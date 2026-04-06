"""Meeting processing pipeline.

Runs the processing steps in a background thread:
1. Transcription + speaker diarisation (AssemblyAI)
2. Speaker label renaming
3. AI summarisation (OpenAI)

No Celery or Redis required — uses asyncio.to_thread() for background processing.
"""
import asyncio
import logging
from typing import Optional

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session

from app.core.config import settings
from app.models import Meeting, MeetingStatus

logger = logging.getLogger(__name__)

# Sync database engine for pipeline tasks (service code is synchronous)
_sync_engine = None
_SyncSessionLocal = None


def _get_sync_session_factory():
    global _sync_engine, _SyncSessionLocal
    if _SyncSessionLocal is None:
        sync_url = settings.database_url
        # asyncpg URLs need converting to sync psycopg2/sqlite
        if "+asyncpg" in sync_url:
            sync_url = sync_url.replace("+asyncpg", "")
        elif "+aiosqlite" in sync_url:
            sync_url = sync_url.replace("+aiosqlite", "")
        _sync_engine = create_engine(sync_url)
        _SyncSessionLocal = sessionmaker(bind=_sync_engine)
    return _SyncSessionLocal


def SyncSessionLocal():
    return _get_sync_session_factory()()


def update_meeting_status(meeting_id: int, status: MeetingStatus) -> None:
    """Update meeting status in database."""
    with SyncSessionLocal() as session:
        meeting = session.query(Meeting).filter(Meeting.id == meeting_id).first()
        if meeting:
            meeting.status = status
            session.commit()
            logger.info(f"Meeting {meeting_id} status updated to {status.value}")


def _run_pipeline_sync(meeting_id: int) -> dict:
    """Run the full pipeline synchronously (called in a background thread).

    Chains: transcription -> diarization -> summarization
    """
    from app.services.transcription import process_transcription
    from app.services.diarisation import process_diarisation
    from app.services.summarisation import process_summarisation

    logger.info(f"Starting processing pipeline for meeting {meeting_id}")

    try:
        update_meeting_status(meeting_id, MeetingStatus.PROCESSING)

        # Step 1: Transcribe + diarise with AssemblyAI
        with SyncSessionLocal() as session:
            process_transcription(session, meeting_id)

        # Step 2: Rename speaker labels
        with SyncSessionLocal() as session:
            process_diarisation(session, meeting_id)

        # Step 3: Summarise with OpenAI
        with SyncSessionLocal() as session:
            process_summarisation(session, meeting_id)

        logger.info(f"Pipeline completed for meeting {meeting_id}")
        return {"meeting_id": meeting_id, "status": "completed"}

    except Exception as e:
        logger.error(f"Pipeline failed for meeting {meeting_id}: {e}")
        update_meeting_status(meeting_id, MeetingStatus.FAILED)
        return {"meeting_id": meeting_id, "status": "failed", "error": str(e)}


def enqueue_meeting(meeting_id: int) -> None:
    """Launch the processing pipeline as a background task.

    Runs the sync pipeline in a separate thread so it doesn't block
    the FastAPI event loop.
    """
    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _run_pipeline_sync, meeting_id)
    logger.info(f"Pipeline enqueued (background thread) for meeting {meeting_id}")
