"""Non-blocking delivery of processed meeting artifacts to secure storage."""

import asyncio
import os
import shutil
import tempfile
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

from app import store
from app.config import get_settings
from app.paths import audio_dir
from app.schemas import BlobStatus, Meeting, PipelineStatus
from app.services.failure_reasons import (
    FailureCategory,
    FailureReason,
    classify,
    log_delivery_failure,
)
from app.services.storage_api import (
    StorageApiClient,
    StorageApiUnavailable,
    get_storage_api_client,
)


_BLOB_DELIVERY_TASKS: set[asyncio.Task[Meeting | None]] = set()
_DELIVERY_LOCKS: dict[UUID, asyncio.Lock] = {}


def meeting_time_basis_utc(meeting: Meeting, export_payload: dict) -> datetime:
    """Return the stable server path time basis, normalized to UTC."""
    scheduled_start = export_payload.get("scheduled_start")
    if isinstance(scheduled_start, str):
        try:
            parsed = datetime.fromisoformat(scheduled_start.replace("Z", "+00:00"))
        except ValueError:
            parsed = None
        if parsed is not None and parsed.tzinfo is not None:
            return parsed.astimezone(timezone.utc)

    created_at = meeting.created_at
    if created_at.tzinfo is None:
        return created_at.replace(tzinfo=timezone.utc)
    return created_at.astimezone(timezone.utc)


def _safe_snapshot() -> None:
    try:
        store.save_snapshot()
    except Exception:
        # Delivery is deliberately non-blocking. A persistence failure must not
        # turn finalisation or the processing pipeline into a failed request.
        pass


def _set_pending(meeting: Meeting) -> datetime:
    started_at = datetime.now(timezone.utc)
    meeting.blob_status = BlobStatus.pending
    meeting.blob_error_message = None
    meeting.blob_error_code = None
    store.BLOB_DELIVERY_STARTED_AT[meeting.id] = started_at
    _safe_snapshot()
    return started_at


def _clear_started_marker(meeting_id: UUID, started_at: datetime | None) -> bool:
    if (
        started_at is not None
        and store.BLOB_DELIVERY_STARTED_AT.get(meeting_id) == started_at
    ):
        store.BLOB_DELIVERY_STARTED_AT.pop(meeting_id, None)
        return True
    return False


def _current_run(
    meeting_id: UUID,
    processing_attempt: int,
    started_at: datetime,
) -> Meeting | None:
    meeting = store.MEETINGS.get(meeting_id)
    if (
        meeting is None
        or meeting.processing_attempt != processing_attempt
        or meeting.pipeline_status is not PipelineStatus.ready
        or store.BLOB_DELIVERY_STARTED_AT.get(meeting_id) != started_at
    ):
        return None
    return meeting


def _abort_superseded(
    meeting_id: UUID,
    started_at: datetime | None,
) -> Meeting | None:
    if _clear_started_marker(meeting_id, started_at):
        _safe_snapshot()
    return store.MEETINGS.get(meeting_id)


def _finish(
    meeting_id: UUID,
    *,
    processing_attempt: int,
    started_at: datetime | None,
    status: BlobStatus,
    error_message: str | None,
    actor: str,
    error_code: str | None = None,
    require_ready: bool = True,
) -> Meeting | None:
    meeting = store.MEETINGS.get(meeting_id)
    if (
        meeting is None
        or meeting.processing_attempt != processing_attempt
        or (require_ready and meeting.pipeline_status is not PipelineStatus.ready)
        or (
            started_at is not None
            and store.BLOB_DELIVERY_STARTED_AT.get(meeting_id) != started_at
        )
    ):
        return _abort_superseded(meeting_id, started_at)

    before = meeting.blob_status.value
    meeting.blob_status = status
    meeting.blob_error_message = error_message
    meeting.blob_error_code = error_code
    _clear_started_marker(meeting_id, started_at)
    try:
        store.add_audit(
            actor,
            (
                "meeting.blob_upload"
                if status is BlobStatus.uploaded
                else "meeting.blob_upload_failed"
            ),
            meeting.title,
            before=before,
            after=status.value,
            meeting_id=meeting.id,
        )
    except Exception:
        pass
    _safe_snapshot()
    return meeting


def _snapshot_audio(source: Path, meeting_id: UUID) -> Path:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f"mn-blob-{meeting_id}-",
        suffix=".webm",
    )
    os.close(descriptor)
    snapshot = Path(temporary_name)
    try:
        shutil.copyfile(source, snapshot)
    except Exception:
        snapshot.unlink(missing_ok=True)
        raise
    return snapshot


async def _remove_audio_snapshot(snapshot: Path | None) -> None:
    if snapshot is None:
        return
    try:
        await asyncio.to_thread(snapshot.unlink, missing_ok=True)
    except Exception:
        pass


async def deliver_meeting_to_blob(
    meeting_id: UUID,
    *,
    access_token: str | None,
    actor: str,
    include_audio: bool,
    client: StorageApiClient | None = None,
) -> Meeting | None:
    """Upload one ready meeting without allowing delivery failures to escape."""
    lock = _DELIVERY_LOCKS.setdefault(meeting_id, asyncio.Lock())
    async with lock:
        meeting = store.MEETINGS.get(meeting_id)
        if meeting is None:
            return None

        processing_attempt = meeting.processing_attempt
        started_at: datetime | None = None
        audio_snapshot: Path | None = None
        try:
            settings = get_settings()
            if not settings.storage_api_enabled:
                return meeting

            stored_export = store.MEETING_EXPORTS.get(meeting_id)
            if (
                meeting.pipeline_status is not PipelineStatus.ready
                or stored_export is None
            ):
                reason = FailureReason.for_category(
                    FailureCategory.processing_error, detail="prerequisite_check"
                )
                log_delivery_failure(meeting_id, "blob", reason, code="prerequisite_check")
                return _finish(
                    meeting_id,
                    processing_attempt=processing_attempt,
                    started_at=store.BLOB_DELIVERY_STARTED_AT.get(meeting_id),
                    status=BlobStatus.failed,
                    error_message=reason.user_sentence,
                    error_code=reason.category.value,
                    actor=actor,
                    require_ready=False,
                )

            export_payload = deepcopy(stored_export)
            started_at = _set_pending(meeting)

            if settings.storage_api_url and not (access_token or "").strip():
                reason = FailureReason.for_category(
                    FailureCategory.azure_signin, detail="signin_check"
                )
                log_delivery_failure(meeting_id, "blob", reason, code="signin_check")
                return _finish(
                    meeting_id,
                    processing_attempt=processing_attempt,
                    started_at=started_at,
                    status=BlobStatus.failed,
                    error_message=reason.user_sentence,
                    error_code=reason.category.value,
                    actor=actor,
                )

            resolved_client = client if client is not None else get_storage_api_client()
            time_basis_utc = meeting_time_basis_utc(meeting, export_payload)

            if include_audio:
                try:
                    if _current_run(
                        meeting_id,
                        processing_attempt,
                        started_at,
                    ) is None:
                        return _abort_superseded(meeting_id, started_at)
                    source_audio = audio_dir() / f"{meeting_id}.webm"
                    audio_snapshot = await asyncio.to_thread(
                        _snapshot_audio,
                        source_audio,
                        meeting_id,
                    )
                    if _current_run(
                        meeting_id,
                        processing_attempt,
                        started_at,
                    ) is None:
                        return _abort_superseded(meeting_id, started_at)
                    grant = await asyncio.to_thread(
                        resolved_client.request_audio_upload_sas,
                        meeting_id,
                        time_basis_utc,
                        access_token,
                    )
                    if _current_run(
                        meeting_id,
                        processing_attempt,
                        started_at,
                    ) is None:
                        return _abort_superseded(meeting_id, started_at)
                    await asyncio.to_thread(
                        resolved_client.upload_audio_to_grant,
                        grant,
                        audio_snapshot,
                    )
                    if _current_run(
                        meeting_id,
                        processing_attempt,
                        started_at,
                    ) is None:
                        return _abort_superseded(meeting_id, started_at)
                except StorageApiUnavailable as exc:
                    reason = FailureReason.for_category(
                        FailureCategory.service_unavailable, detail=str(exc)
                    )
                    log_delivery_failure(
                        meeting_id, "blob", reason, code="StorageApiUnavailable"
                    )
                    return _finish(
                        meeting_id,
                        processing_attempt=processing_attempt,
                        started_at=started_at,
                        status=BlobStatus.failed,
                        error_message=reason.user_sentence,
                        error_code=reason.category.value,
                        actor=actor,
                    )
                except Exception as exc:
                    # The try above spans the local audio-snapshot copy, the
                    # SAS request, and the upload — they share one handler,
                    # so a local file error can't be told apart from a
                    # network/provider failure here without restructuring
                    # control flow. classify() picks the best fit either way.
                    reason = classify(exc, stage="blob")
                    log_delivery_failure(
                        meeting_id, "blob", reason, code=exc.__class__.__name__
                    )
                    return _finish(
                        meeting_id,
                        processing_attempt=processing_attempt,
                        started_at=started_at,
                        status=BlobStatus.failed,
                        error_message=reason.user_sentence,
                        error_code=reason.category.value,
                        actor=actor,
                    )

            if _current_run(
                meeting_id,
                processing_attempt,
                started_at,
            ) is None:
                return _abort_superseded(meeting_id, started_at)
            try:
                await asyncio.to_thread(
                    resolved_client.upload_meeting_export,
                    meeting_id,
                    time_basis_utc,
                    export_payload,
                    access_token,
                )
            except StorageApiUnavailable as exc:
                reason = FailureReason.for_category(
                    FailureCategory.service_unavailable, detail=str(exc)
                )
                log_delivery_failure(
                    meeting_id, "blob", reason, code="StorageApiUnavailable"
                )
                return _finish(
                    meeting_id,
                    processing_attempt=processing_attempt,
                    started_at=started_at,
                    status=BlobStatus.failed,
                    error_message=reason.user_sentence,
                    error_code=reason.category.value,
                    actor=actor,
                )
            except Exception as exc:
                reason = classify(exc, stage="blob")
                log_delivery_failure(
                    meeting_id, "blob", reason, code=exc.__class__.__name__
                )
                return _finish(
                    meeting_id,
                    processing_attempt=processing_attempt,
                    started_at=started_at,
                    status=BlobStatus.failed,
                    error_message=reason.user_sentence,
                    error_code=reason.category.value,
                    actor=actor,
                )

            return _finish(
                meeting_id,
                processing_attempt=processing_attempt,
                started_at=started_at,
                status=BlobStatus.uploaded,
                error_message=None,
                error_code=None,
                actor=actor,
            )
        except StorageApiUnavailable as exc:
            reason = FailureReason.for_category(
                FailureCategory.service_unavailable, detail=str(exc)
            )
            log_delivery_failure(meeting_id, "blob", reason, code="StorageApiUnavailable")
            return _finish(
                meeting_id,
                processing_attempt=processing_attempt,
                started_at=started_at,
                status=BlobStatus.failed,
                error_message=reason.user_sentence,
                error_code=reason.category.value,
                actor=actor,
                require_ready=started_at is not None,
            )
        except Exception as exc:
            reason = classify(exc, stage="blob")
            log_delivery_failure(meeting_id, "blob", reason, code=exc.__class__.__name__)
            return _finish(
                meeting_id,
                processing_attempt=processing_attempt,
                started_at=started_at,
                status=BlobStatus.failed,
                error_message=reason.user_sentence,
                error_code=reason.category.value,
                actor=actor,
                require_ready=started_at is not None,
            )
        finally:
            await _remove_audio_snapshot(audio_snapshot)


def kick_blob_delivery(
    meeting_id: UUID,
    *,
    access_token: str | None,
    actor: str,
    include_audio: bool,
    client: StorageApiClient | None = None,
) -> asyncio.Task[Meeting | None] | None:
    """Launch retained background delivery and expose pending immediately."""
    if not get_settings().storage_api_enabled:
        return None
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None:
        return None
    _set_pending(meeting)
    task = asyncio.create_task(
        deliver_meeting_to_blob(
            meeting_id,
            access_token=access_token,
            actor=actor,
            include_audio=include_audio,
            client=client,
        )
    )
    _BLOB_DELIVERY_TASKS.add(task)
    task.add_done_callback(_BLOB_DELIVERY_TASKS.discard)
    return task


def reconcile_interrupted_blob_deliveries() -> int:
    """Make orphaned ready/pending deliveries honest and retryable."""
    changed = 0
    for meeting_id, meeting in store.MEETINGS.items():
        if (
            meeting.pipeline_status is PipelineStatus.ready
            and meeting.blob_status is BlobStatus.pending
            and meeting_id in store.BLOB_DELIVERY_STARTED_AT
        ):
            reason = FailureReason.for_category(
                FailureCategory.interrupted, detail="startup_reconcile"
            )
            log_delivery_failure(meeting_id, "blob", reason, code="startup_reconcile")
            meeting.blob_status = BlobStatus.failed
            meeting.blob_error_message = reason.user_sentence
            meeting.blob_error_code = reason.category.value
            store.BLOB_DELIVERY_STARTED_AT.pop(meeting_id, None)
            changed += 1
    if changed:
        _safe_snapshot()
    return changed
