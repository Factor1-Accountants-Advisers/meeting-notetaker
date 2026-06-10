import base64
import binascii
from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, status

from app import store
from app.schemas import (
    Meeting,
    MeetingCreate,
    MeetingReview,
    MeetingStatus,
    NameSpeakerRequest,
    PipelineStatus,
    UploadAudioRequest,
)
from app.services.pipeline import AUDIO_DIR, audio_path_for, kick_pipeline

router = APIRouter(prefix="/meetings", tags=["meetings"])


@router.get("", response_model=list[Meeting])
async def list_meetings(status_filter: MeetingStatus | None = None) -> list[Meeting]:
    items = sorted(store.MEETINGS.values(), key=lambda m: m.created_at, reverse=True)
    if status_filter is not None:
        items = [m for m in items if m.status == status_filter]
    return items


@router.get("/{meeting_id}", response_model=Meeting)
async def get_meeting(meeting_id: UUID) -> Meeting:
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")
    return meeting


@router.post("", response_model=Meeting, status_code=status.HTTP_201_CREATED)
async def create_meeting(body: MeetingCreate) -> Meeting:
    meeting = Meeting(
        id=uuid4(),
        title=body.title,
        context=body.context,
        source=body.source,
        owner_id="gerd",  # from auth once Entra ID lands
        created_at=datetime.now(timezone.utc),
    )
    store.MEETINGS[meeting.id] = meeting
    return meeting


@router.post("/{meeting_id}/audio", response_model=Meeting)
async def upload_audio(meeting_id: UUID, body: UploadAudioRequest) -> Meeting:
    """Store meeting audio (Blob stand-in) and queue the processing pipeline."""
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")
    if meeting.pipeline_status in (PipelineStatus.queued, PipelineStatus.processing):
        raise HTTPException(status.HTTP_409_CONFLICT, "Audio is already being processed")

    try:
        audio = base64.b64decode(body.audio_b64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Audio is not valid base64")
    if len(audio) < 1_000:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Audio is too short")

    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    path = audio_path_for(meeting_id, body.mime_type)
    path.write_bytes(audio)

    updates: dict[str, object] = {}
    if body.duration_seconds:
        updates["duration_seconds"] = body.duration_seconds
    if updates:
        store.MEETINGS[meeting_id] = meeting.model_copy(update=updates)

    kick_pipeline(meeting_id, path)
    return store.MEETINGS[meeting_id]


@router.post("/{meeting_id}/retry", response_model=Meeting)
async def retry_pipeline(meeting_id: UUID) -> Meeting:
    """Re-queue a failed meeting (requirements §4.4: flag and retry)."""
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")
    if meeting.pipeline_status is not PipelineStatus.failed:
        raise HTTPException(status.HTTP_409_CONFLICT, "Meeting is not in a failed state")
    path = audio_path_for(meeting_id, "audio/webm")
    if not path.exists():
        raise HTTPException(status.HTTP_409_CONFLICT, "No stored audio for this meeting")
    kick_pipeline(meeting_id, path)
    return store.MEETINGS[meeting_id]


def _build_review(meeting: Meeting) -> MeetingReview:
    items = [
        a.model_copy(update={"meeting_title": meeting.title})
        for a in store.ACTION_ITEMS.values()
        if a.meeting_id == meeting.id
    ]
    return MeetingReview(
        meeting=meeting,
        summary_text=store.SUMMARIES.get(meeting.id),
        participants=store.PARTICIPANTS.get(meeting.id, []),
        segments=store.TRANSCRIPTS.get(meeting.id, []),
        action_items=items,
    )


@router.get("/{meeting_id}/review", response_model=MeetingReview)
async def get_review(meeting_id: UUID) -> MeetingReview:
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")
    return _build_review(meeting)


@router.post("/{meeting_id}/name-speaker", response_model=MeetingReview)
async def name_speaker(meeting_id: UUID, body: NameSpeakerRequest) -> MeetingReview:
    """Manually name an unknown diarized speaker (requirements §4.4).

    Renames the speaker across transcript and participants and decrements the
    meeting's unknown count. Audit logging attaches here later.
    """
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")

    participants = store.PARTICIPANTS.get(meeting_id, [])
    target = next((p for p in participants if p.name == body.label and not p.known), None)
    if target is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"No unknown speaker labelled '{body.label}'"
        )

    target.name = body.name
    target.known = True
    for seg in store.TRANSCRIPTS.get(meeting_id, []):
        if seg.speaker == body.label:
            seg.speaker = body.name
            seg.speaker_known = True

    updated = meeting.model_copy(
        update={"unknown_speaker_count": max(0, meeting.unknown_speaker_count - 1)}
    )
    store.MEETINGS[meeting_id] = updated
    return _build_review(updated)


@router.post("/{meeting_id}/finalize", response_model=Meeting)
async def finalize_meeting(meeting_id: UUID) -> Meeting:
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")
    if meeting.status is MeetingStatus.finalized:
        raise HTTPException(status.HTTP_409_CONFLICT, "Meeting is already finalized")
    if meeting.unknown_speaker_count > 0:
        # Product rule: unknown speakers must be named before finalisation.
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{meeting.unknown_speaker_count} unknown speaker(s) must be named first",
        )
    updated = meeting.model_copy(update={"status": MeetingStatus.finalized})
    store.MEETINGS[meeting_id] = updated
    return updated
