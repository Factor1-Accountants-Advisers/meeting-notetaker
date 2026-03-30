"""Meeting processing pipeline.

Celery tasks for processing uploaded audio files through:
1. Transcription + speaker diarisation (AssemblyAI)
2. Speaker label renaming
3. AI summarisation (OpenAI)

Each step updates the meeting status and can notify clients via WebSocket.
"""
import logging
from typing import Optional

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.celery_app import celery_app
from app.core.config import settings
from app.models import Meeting, MeetingStatus

logger = logging.getLogger(__name__)

# Sync database engine for Celery tasks (Celery doesn't support async natively)
# Lazy-initialised to avoid import-time failures when DB drivers aren't available
_sync_engine = None
_SyncSessionLocal = None


def _get_sync_session_factory():
    global _sync_engine, _SyncSessionLocal
    if _SyncSessionLocal is None:
        sync_url = settings.database_url.replace("+asyncpg", "")
        _sync_engine = create_engine(sync_url)
        _SyncSessionLocal = sessionmaker(bind=_sync_engine)
    return _SyncSessionLocal


def SyncSessionLocal():
    return _get_sync_session_factory()()


def update_meeting_status(meeting_id: int, status: MeetingStatus) -> None:
    """Update meeting status in database.

    Args:
        meeting_id: Meeting ID to update
        status: New status value
    """
    with SyncSessionLocal() as session:
        meeting = session.query(Meeting).filter(Meeting.id == meeting_id).first()
        if meeting:
            meeting.status = status
            session.commit()
            logger.info(f"Meeting {meeting_id} status updated to {status.value}")


@celery_app.task(bind=True, max_retries=3)
def process_meeting(self, meeting_id: int) -> dict:
    """Main pipeline task to process a meeting recording.

    This is the entry point for the processing pipeline.
    Chains together: transcription -> diarization -> summarization

    Args:
        meeting_id: ID of the meeting to process

    Returns:
        Dictionary with processing results
    """
    logger.info(f"Starting processing pipeline for meeting {meeting_id}")

    try:
        # Update status to processing
        update_meeting_status(meeting_id, MeetingStatus.PROCESSING)

        # Step 1: Transcribe + diarise with AssemblyAI
        transcribe_meeting(meeting_id)

        # Step 2: Rename speaker labels
        diarize_meeting(meeting_id)

        # Step 3: Summarise with OpenAI
        summarise_meeting(meeting_id)

        logger.info(f"Pipeline completed for meeting {meeting_id}")

        return {
            "meeting_id": meeting_id,
            "status": "completed",
            "message": "Pipeline completed successfully"
        }

    except Exception as e:
        logger.error(f"Pipeline failed for meeting {meeting_id}: {e}")
        update_meeting_status(meeting_id, MeetingStatus.FAILED)

        # Retry with exponential backoff
        raise self.retry(exc=e, countdown=60 * (2 ** self.request.retries))


@celery_app.task(bind=True, max_retries=3)
def transcribe_meeting(self, meeting_id: int) -> dict:
    """Celery task to transcribe a meeting's audio via AssemblyAI.

    Downloads audio from blob storage, sends to AssemblyAI for
    transcription with speaker diarisation, and saves to database.

    Args:
        meeting_id: ID of the meeting to transcribe

    Returns:
        Dictionary with transcription results
    """
    from app.services.transcription import process_transcription

    logger.info(f"Starting transcription task for meeting {meeting_id}")

    with SyncSessionLocal() as session:
        try:
            transcript = process_transcription(session, meeting_id)

            return {
                "meeting_id": meeting_id,
                "status": "transcribed",
                "segments_count": len(transcript.segments) if transcript.segments else 0,
            }

        except Exception as e:
            logger.error(f"Transcription task failed for meeting {meeting_id}: {e}")
            # Status already set to FAILED by process_transcription
            raise


@celery_app.task(bind=True, max_retries=3)
def diarize_meeting(self, meeting_id: int) -> dict:
    """Celery task to rename speaker labels on a transcript.

    AssemblyAI already provides speaker labels (A, B, C) during
    transcription. This step renames them to human-readable names.

    Args:
        meeting_id: ID of the meeting to process

    Returns:
        Dictionary with diarisation results
    """
    from app.services.diarisation import process_diarisation

    logger.info(f"Starting speaker label renaming for meeting {meeting_id}")

    with SyncSessionLocal() as session:
        try:
            transcript = process_diarisation(session, meeting_id)

            # Count unique speakers
            speakers = set()
            for seg in transcript.segments or []:
                speakers.add(seg.get("speaker", "Unknown"))

            return {
                "meeting_id": meeting_id,
                "status": "diarised",
                "speaker_count": len(speakers),
            }

        except Exception as e:
            logger.error(f"Speaker renaming failed for meeting {meeting_id}: {e}")
            raise


@celery_app.task(bind=True, max_retries=3)
def summarise_meeting(self, meeting_id: int) -> dict:
    """Celery task to summarise a meeting transcript with OpenAI.

    Args:
        meeting_id: ID of the meeting to summarise

    Returns:
        Dictionary with summarisation results
    """
    from app.services.summarisation import process_summarisation

    logger.info(f"Starting summarisation task for meeting {meeting_id}")

    with SyncSessionLocal() as session:
        try:
            summary, action_items = process_summarisation(session, meeting_id)

            return {
                "meeting_id": meeting_id,
                "status": "summarised",
                "action_items_count": len(action_items),
            }

        except Exception as e:
            logger.error(f"Summarisation task failed for meeting {meeting_id}: {e}")
            raise


@celery_app.task
def cleanup_temp_files(meeting_id: int) -> None:
    """Clean up temporary files after processing.

    Called after pipeline completion to remove local temp files.

    Args:
        meeting_id: Meeting ID whose files should be cleaned up
    """
    logger.info(f"Cleaning up temp files for meeting {meeting_id}")
    # TODO: Implement cleanup logic
    pass
