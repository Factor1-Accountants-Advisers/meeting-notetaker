from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, status

from app import store
from app.schemas import Meeting, MeetingCreate, MeetingStatus

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
