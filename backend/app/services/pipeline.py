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
from app.config import get_settings
from app.schemas import (
    AccessRole,
    DeliveryStatus,
    MeetingAccessEntry,
    MeetingSource,
    PipelineStage,
    PipelineStatus,
)
from app.paths import audio_dir
from app.services import audio_checks
from app.services.llm import get_llm_provider
from app.services.meeting_export import refresh_meeting_export
from app.services.speech import get_speech_provider
from app.services.speaker_matching import get_speaker_matcher

logger = logging.getLogger(__name__)

# Simulated stage latency so the UI's queued/processing states are visible.
STAGE_DELAY_S = 1.5

# Keep strong references to fire-and-forget pipeline tasks until they finish.
_PIPELINE_TASKS: set[asyncio.Task[None]] = set()

# Watchdog thresholds. A meeting only sits in `queued` for a moment before its
# task advances it to `processing`, so a long stall there means no live task.
# `processing` legitimately runs until the provider poll times out, so its
# limit is that timeout plus a buffer.
WATCHDOG_INTERVAL_S = 30
QUEUE_STALL_S = 120
PROCESSING_STALL_BUFFER_S = 600


def audio_path_for(meeting_id: UUID, mime_type: str) -> Path:
    ext = "webm" if "webm" in mime_type else "bin"
    return audio_dir() / f"{meeting_id}.{ext}"


def mic_track_path(meeting_id: UUID) -> Path:
    """Raw mic capture kept alongside the merged file for dual-track uploads."""
    return audio_dir() / f"{meeting_id}.mic.webm"


async def _stamp_recorder_audio_missing(meeting_id: UUID, audio_path: Path) -> None:
    """Measure the recorder's mic track and flag silent captures on the meeting.

    Runs inside the background pipeline task (a full-file ffmpeg decode is too
    slow for the upload request path). Dual-track uploads keep the raw mic file;
    single-track uploads are the mic.
    """
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None:
        return
    # Only measure tracks that are genuinely the recorder's mic: the kept raw
    # mic file from dual-track uploads, or the single track of an in-person
    # capture (mic-only by construction). Online single-track audio may be the
    # system-audio fallback, and 'upload'-sourced files were never a mic.
    mic_track = mic_track_path(meeting_id)
    if mic_track.exists():
        probe = mic_track
    elif meeting.source is MeetingSource.in_person:
        probe = audio_path
    else:
        return
    mic_silent = await asyncio.to_thread(audio_checks.is_silent, probe)
    meeting = store.MEETINGS.get(meeting_id)
    if mic_silent is None or meeting is None:
        return
    store.MEETINGS[meeting_id] = meeting.model_copy(update={"recorder_audio_missing": mic_silent})
    if mic_silent:
        logger.warning("mic track is silent for meeting %s — recorder audio missing", meeting_id)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def set_pipeline_state(
    meeting_id: UUID,
    status: PipelineStatus,
    stage: PipelineStage,
    message: str,
    *,
    error_code: str | None = None,
    error_message: str | None = None,
) -> None:
    """Persist backend-owned pipeline progress for UI recovery and audits."""
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None:
        return

    now = _now()
    started_at = meeting.pipeline_started_at
    if status in (PipelineStatus.queued, PipelineStatus.processing) and started_at is None:
        started_at = now

    completed_at = meeting.pipeline_completed_at
    if status in (PipelineStatus.ready, PipelineStatus.failed):
        completed_at = now
    elif status in (PipelineStatus.queued, PipelineStatus.processing):
        completed_at = None

    updates = {
        "pipeline_status": status,
        "pipeline_stage": stage,
        "pipeline_stage_message": message,
        "pipeline_started_at": started_at,
        "pipeline_updated_at": now,
        "pipeline_completed_at": completed_at,
        "processing_error_code": error_code,
        "processing_error_message": error_message,
    }
    store.MEETINGS[meeting_id] = meeting.model_copy(update=updates)


def set_delivery_state(
    meeting_id: UUID,
    status: DeliveryStatus,
    error_message: str | None = None,
    *,
    recipients: list[str] | None = None,
    emailed_at: datetime | None = None,
) -> None:
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is not None:
        store.MEETINGS[meeting_id] = meeting.model_copy(
            update={
                "delivery_status": status,
                "delivery_error_message": error_message,
                # Replay fields only survive while the state is emailed; any
                # other transition (reset, failure, re-upload) clears them so a
                # regenerated transcript can be emailed fresh.
                "delivery_recipients": list(recipients) if status is DeliveryStatus.emailed and recipients else [],
                "delivery_emailed_at": emailed_at if status is DeliveryStatus.emailed else None,
                "pipeline_updated_at": _now(),
            }
        )


def _increment_attempt(meeting_id: UUID) -> None:
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is not None:
        store.MEETINGS[meeting_id] = meeting.model_copy(
            update={"processing_attempt": meeting.processing_attempt + 1}
        )


def reconcile_interrupted_pipelines() -> int:
    """Mark in-flight pipeline work from a prior process as retryable failed.

    Queued/processing state only exists in memory as an asyncio task. If the
    backend process restarts while a meeting is in either state, no task remains
    to advance it and upload/retry would otherwise 409 forever. On startup we
    make that state honest and retryable.
    """
    changed = 0
    for meeting_id, meeting in list(store.MEETINGS.items()):
        # An in-flight email send also only exists as in-process work. A restart
        # mid-send would otherwise leave delivery_status=emailing forever, and
        # the idempotency guard would then block every future email attempt.
        if meeting.delivery_status is DeliveryStatus.emailing:
            set_delivery_state(
                meeting_id,
                DeliveryStatus.failed,
                "Email delivery was interrupted by a backend restart. Retry email.",
            )
            changed += 1
        if meeting.pipeline_status not in (PipelineStatus.queued, PipelineStatus.processing):
            continue
        set_pipeline_state(
            meeting_id,
            PipelineStatus.failed,
            PipelineStage.failed,
            "Processing was interrupted by a backend restart. Retry processing when ready.",
            error_code="Interrupted",
            error_message="Backend restarted while this meeting was processing.",
        )
        changed += 1
    if changed:
        logger.warning("marked %s interrupted pipeline(s) retryable after startup", changed)
        store.save_snapshot()
    return changed


def sweep_stuck_pipelines() -> int:
    """Flip meetings stranded mid-pipeline to retryable-failed.

    ``reconcile_interrupted_pipelines`` only runs at startup, so it catches
    process restarts but not a *live* strand — e.g. an upload that set the
    meeting to ``queued`` but whose pipeline task never advanced (observed on a
    long recording whose upload request was interrupted before the task was
    scheduled). This runs periodically so such a meeting becomes honest and
    retryable instead of spinning in the UI forever.
    """
    settings = get_settings()
    now = _now()
    processing_limit = settings.pyannote_poll_timeout_seconds + PROCESSING_STALL_BUFFER_S
    changed = 0
    for meeting_id, meeting in list(store.MEETINGS.items()):
        status = meeting.pipeline_status
        if status is PipelineStatus.queued:
            limit = QUEUE_STALL_S
        elif status is PipelineStatus.processing:
            limit = processing_limit
        else:
            continue
        reference = (
            meeting.pipeline_updated_at
            or meeting.pipeline_started_at
            or meeting.created_at
        )
        if reference is None or (now - reference).total_seconds() <= limit:
            continue
        set_pipeline_state(
            meeting_id,
            PipelineStatus.failed,
            PipelineStage.failed,
            "Processing stalled before finishing. The recording is saved — retry to try again.",
            error_code="Stalled",
            error_message=f"No pipeline progress for over {int(limit)}s while {status.value}.",
        )
        changed += 1
    if changed:
        logger.warning("watchdog marked %s stalled pipeline(s) retryable", changed)
        store.save_snapshot()
    return changed


async def pipeline_watchdog_loop() -> None:
    while True:
        try:
            sweep_stuck_pipelines()
        except Exception:
            logger.exception("pipeline watchdog sweep failed")
        await asyncio.sleep(WATCHDOG_INTERVAL_S)


async def run_pipeline(meeting_id: UUID, audio_path: Path) -> None:
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None:
        return
    try:
        await asyncio.sleep(STAGE_DELAY_S)  # sitting in the queue
        set_pipeline_state(
            meeting_id,
            PipelineStatus.processing,
            PipelineStage.transcribing_diarizing,
            "Transcribing and diarizing recording...",
        )

        await _stamp_recorder_audio_missing(meeting_id, audio_path)

        speech = get_speech_provider()
        raw_segments = await speech.transcribe_diarized(audio_path, meeting)
        await asyncio.sleep(STAGE_DELAY_S)

        # Speaker matching via pyannoteAI `/v1/identify` using enrolled
        # voiceprints (IN-69). If identification fails or confidence/overlap is
        # insufficient, segments remain Unknown rather than guessed.
        set_pipeline_state(
            meeting_id,
            PipelineStatus.processing,
            PipelineStage.identifying_speakers,
            "Identifying enrolled speakers...",
        )
        matcher = get_speaker_matcher()
        segments, participants, unknown_count = await matcher.match_speakers(
            raw_segments, meeting, audio_path
        )

        set_pipeline_state(
            meeting_id,
            PipelineStatus.processing,
            PipelineStage.extracting_notes,
            "Extracting summary and action items...",
        )
        llm = get_llm_provider()
        summary = await llm.summarize(segments)
        summary_html = await llm.summarize_html(segments)
        items = await llm.extract_action_items(meeting_id, segments)
        await asyncio.sleep(STAGE_DELAY_S)

        # Items owned by an unidentified speaker stay unassigned until named.
        # Unidentified speakers are labelled "Speaker N" (IN-127); "Unknown"
        # is kept for backward compatibility with older stored data.
        for item in items:
            if item.owner is not None and (
                item.owner.startswith("Speaker ") or item.owner.startswith("Unknown")
            ):
                item.owner = None

        store.TRANSCRIPTS[meeting_id] = segments
        store.PARTICIPANTS[meeting_id] = participants
        store.SUMMARIES[meeting_id] = summary
        if summary_html:
            store.SUMMARY_HTML[meeting_id] = summary_html
        else:
            store.SUMMARY_HTML.pop(meeting_id, None)
        # A reprocessing run replaces the meeting's outputs wholesale — items
        # from the prior run reference an obsolete transcript and must not
        # accumulate alongside the new set.
        for stale_id in [
            item_id
            for item_id, item in store.ACTION_ITEMS.items()
            if item.meeting_id == meeting_id
        ]:
            del store.ACTION_ITEMS[stale_id]
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

        current = store.MEETINGS[meeting_id]
        store.MEETINGS[meeting_id] = current.model_copy(
            update={
                "unknown_speaker_count": unknown_count,
                "action_item_count": len(items),
            }
        )
        set_pipeline_state(
            meeting_id,
            PipelineStatus.ready,
            PipelineStage.ready,
            "Transcript and notes are ready.",
        )
        # Canonical IN-384 artifact for Blob upload/downstream consumers,
        # built from the just-stored transcript/summary/action items.
        refresh_meeting_export(meeting_id)
        logger.info("pipeline ready for %s at %s", meeting_id, _now())
    except Exception as exc:
        logger.exception("pipeline failed for %s", meeting_id)
        set_pipeline_state(
            meeting_id,
            PipelineStatus.failed,
            PipelineStage.failed,
            "Processing failed. The recording is saved and can be retried.",
            error_code=exc.__class__.__name__,
            error_message=str(exc)[:500] or "Processing failed",
        )
    finally:
        # Async task runs outside any request, so persist explicitly.
        store.save_snapshot()


def kick_pipeline(meeting_id: UUID, audio_path: Path) -> None:
    _increment_attempt(meeting_id)
    # The canonical export describes outputs this run is about to replace;
    # IN-386 must not be able to upload a stale artifact mid-reprocess.
    store.MEETING_EXPORTS.pop(meeting_id, None)
    set_delivery_state(meeting_id, DeliveryStatus.not_started)
    set_pipeline_state(
        meeting_id,
        PipelineStatus.queued,
        PipelineStage.queued,
        "Recording uploaded. Waiting to start processing...",
    )
    task = asyncio.create_task(run_pipeline(meeting_id, audio_path))
    _PIPELINE_TASKS.add(task)
    task.add_done_callback(_PIPELINE_TASKS.discard)
