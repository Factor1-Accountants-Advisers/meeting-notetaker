"""Non-blocking delivery of processed meeting artifacts to secure storage."""

import asyncio
from datetime import datetime, timezone
from uuid import UUID

from app import store
from app.config import get_settings
from app.paths import audio_dir
from app.schemas import BlobStatus, Meeting, PipelineStatus
from app.services.storage_api import StorageApiClient, get_storage_api_client


PREREQUISITE_FAILURE = "Secure storage upload is waiting for processed meeting data."
SIGN_IN_FAILURE = "Sign in is required to upload this meeting to secure storage."
AUDIO_FAILURE = (
    "Secure storage upload failed while uploading audio. Retry when connected."
)
EXPORT_FAILURE = (
    "Secure storage upload failed while uploading the meeting record. "
    "Retry when connected."
)
INTERRUPTED_FAILURE = (
    "Secure storage upload was interrupted. Retry when connected."
)
_BLOB_DELIVERY_TASKS: set[asyncio.Task[Meeting]] = set()


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


def _set_pending(meeting: Meeting) -> None:
    meeting.blob_status = BlobStatus.pending
    meeting.blob_error_message = None
    _safe_snapshot()


def _finish(
    meeting: Meeting,
    *,
    status: BlobStatus,
    error_message: str | None,
    actor: str,
) -> Meeting:
    before = meeting.blob_status.value
    meeting.blob_status = status
    meeting.blob_error_message = error_message
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


async def deliver_meeting_to_blob(
    meeting_id: UUID,
    *,
    access_token: str | None,
    actor: str,
    include_audio: bool,
    client: StorageApiClient | None = None,
) -> Meeting:
    """Upload one ready meeting without allowing delivery failures to escape."""
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None:
        return None  # type: ignore[return-value]

    try:
        settings = get_settings()
        if not settings.storage_api_enabled:
            return meeting

        export_payload = store.MEETING_EXPORTS.get(meeting_id)
        if (
            meeting.pipeline_status is not PipelineStatus.ready
            or export_payload is None
        ):
            return _finish(
                meeting,
                status=BlobStatus.failed,
                error_message=PREREQUISITE_FAILURE,
                actor=actor,
            )

        _set_pending(meeting)

        if settings.storage_api_url and not (access_token or "").strip():
            return _finish(
                meeting,
                status=BlobStatus.failed,
                error_message=SIGN_IN_FAILURE,
                actor=actor,
            )

        resolved_client = client if client is not None else get_storage_api_client()
        time_basis_utc = meeting_time_basis_utc(meeting, export_payload)

        if include_audio:
            try:
                audio_path = audio_dir() / f"{meeting_id}.webm"
                if not audio_path.is_file():
                    return _finish(
                        meeting,
                        status=BlobStatus.failed,
                        error_message=AUDIO_FAILURE,
                        actor=actor,
                    )
                grant = await asyncio.to_thread(
                    resolved_client.request_audio_upload_sas,
                    meeting_id,
                    time_basis_utc,
                    access_token,
                )
                await asyncio.to_thread(
                    resolved_client.upload_audio_to_grant,
                    grant,
                    audio_path,
                )
            except Exception:
                return _finish(
                    meeting,
                    status=BlobStatus.failed,
                    error_message=AUDIO_FAILURE,
                    actor=actor,
                )

        try:
            await asyncio.to_thread(
                resolved_client.upload_meeting_export,
                meeting_id,
                time_basis_utc,
                export_payload,
                access_token,
            )
        except Exception:
            return _finish(
                meeting,
                status=BlobStatus.failed,
                error_message=EXPORT_FAILURE,
                actor=actor,
            )

        return _finish(
            meeting,
            status=BlobStatus.uploaded,
            error_message=None,
            actor=actor,
        )
    except Exception:
        return _finish(
            meeting,
            status=BlobStatus.failed,
            error_message=EXPORT_FAILURE,
            actor=actor,
        )


def kick_blob_delivery(
    meeting_id: UUID,
    *,
    access_token: str | None,
    actor: str,
    include_audio: bool,
    client: StorageApiClient | None = None,
) -> asyncio.Task[Meeting] | None:
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
    for meeting in store.MEETINGS.values():
        if (
            meeting.pipeline_status is PipelineStatus.ready
            and meeting.blob_status is BlobStatus.pending
        ):
            meeting.blob_status = BlobStatus.failed
            meeting.blob_error_message = INTERRUPTED_FAILURE
            changed += 1
    if changed:
        _safe_snapshot()
    return changed
