"""Post-meeting processing pipeline (Jira CSV is source of truth).

audio stored -> queued -> processing:
  1. pyannoteAI API: transcription + diarization/speaker labels
  2. pyannoteAI voiceprints: identify known speakers above threshold
  3. OpenAI provider: summary + action items
-> ready (or failed, flagged for retry)

Stages run behind provider interfaces. If pyannoteAI is not configured, the
pipeline returns an explicit unavailable-provider transcript rather than fake
speaker identities.
"""

import asyncio
import logging
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

from app import store
from app.schemas import (
    AccessRole,
    MeetingAccessEntry,
    MeetingParticipant,
    PipelineStatus,
    TranscriptSegment,
)
from app.services.llm import get_llm_provider
from app.services.speech import get_speech_provider
from app.services.speaker_matching import get_speaker_matcher

logger = logging.getLogger(__name__)

# Local stand-in for Azure Blob Storage (30-day lifecycle handled there).
AUDIO_DIR = Path(__file__).resolve().parents[2] / "var" / "audio"

# Simulated stage latency so the UI's queued/processing states are visible.
STAGE_DELAY_S = 1.5


def audio_path_for(meeting_id: UUID, mime_type: str) -> Path:
    ext = "webm" if "webm" in mime_type else "bin"
    return AUDIO_DIR / f"{meeting_id}.{ext}"


def _set_status(meeting_id: UUID, status: PipelineStatus) -> None:
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is not None:
        store.MEETINGS[meeting_id] = meeting.model_copy(update={"pipeline_status": status})


async def run_pipeline(meeting_id: UUID, audio_path: Path) -> None:
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None:
        return
    try:
        await asyncio.sleep(STAGE_DELAY_S)  # sitting in the queue
        _set_status(meeting_id, PipelineStatus.processing)

        speech = get_speech_provider()
        raw_segments = await speech.transcribe_diarized(audio_path, meeting)
        await asyncio.sleep(STAGE_DELAY_S)

        # Speaker matching via pyannoteAI `/v1/identify` using enrolled
        # voiceprints (IN-69). If identification fails or confidence/overlap is
        # insufficient, segments remain Unknown rather than guessed.
        matcher = get_speaker_matcher()
        segments, participants, unknown_count = await matcher.match_speakers(
            raw_segments, meeting, audio_path
        )

        llm = get_llm_provider()
        summary = await llm.summarize(segments)
        items = await llm.extract_action_items(meeting_id, segments)
        await asyncio.sleep(STAGE_DELAY_S)

        # Unknown-owned items stay unassigned until the speaker is named.
        for item in items:
            if item.owner is not None and item.owner.startswith("Unknown"):
                item.owner = None

        store.TRANSCRIPTS[meeting_id] = segments
        store.PARTICIPANTS[meeting_id] = participants
        store.SUMMARIES[meeting_id] = summary
        for item in items:
            store.ACTION_ITEMS[item.id] = item

        # Private to participants by default (decision #7): matched (known)
        # participants get viewer access automatically.
        access = store.ACCESS.setdefault(meeting_id, [])
        for participant in participants:
            if participant.known and not any(e.user == participant.name for e in access):
                access.append(
                    MeetingAccessEntry(user=participant.name, role=AccessRole.viewer)
                )

        updated = store.MEETINGS[meeting_id].model_copy(
            update={
                "pipeline_status": PipelineStatus.ready,
                "unknown_speaker_count": unknown_count,
                "action_item_count": len(items),
            }
        )
        store.MEETINGS[meeting_id] = updated
        logger.info("pipeline ready for %s at %s", meeting_id, datetime.now(timezone.utc))
    except Exception:
        logger.exception("pipeline failed for %s", meeting_id)
        _set_status(meeting_id, PipelineStatus.failed)
    finally:
        # Async task runs outside any request, so persist explicitly.
        store.save_snapshot()


def kick_pipeline(meeting_id: UUID, audio_path: Path) -> None:
    _set_status(meeting_id, PipelineStatus.queued)
    asyncio.get_running_loop().create_task(run_pipeline(meeting_id, audio_path))
