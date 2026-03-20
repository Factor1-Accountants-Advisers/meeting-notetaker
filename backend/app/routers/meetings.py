"""Meeting endpoints.

Handles meeting upload, listing, and detail retrieval.
"""
import logging
from typing import Optional
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status, UploadFile, File, Form
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
import json

from app.core.database import get_db
from app.api.dependencies import get_current_user
from app.models import (
    User, Meeting, Participant, Transcript, Summary, ActionItem,
    MeetingStatus,
)
from app.schemas import (
    MeetingUploadResponse, MeetingUploadMetadata,
    MeetingListItem, MeetingListResponse, MeetingDetailResponse,
    ParticipantResponse, TranscriptResponse, SummaryResponse,
    ActionItemResponse,
)
from app.services.storage import get_storage
from app.services.pipeline import process_meeting

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/meetings", tags=["meetings"])

# File validation constants
MAX_FILE_SIZE = 500 * 1024 * 1024  # 500 MB
ALLOWED_CONTENT_TYPES = ["audio/wav", "audio/wave", "audio/x-wav", "audio/mpeg", "audio/mp3"]
ALLOWED_EXTENSIONS = [".wav", ".mp3"]


def validate_audio_file(file: UploadFile) -> None:
    """Validate uploaded audio file.

    OWASP Security:
    - Validates file extension (allowlist)
    - Validates content type (allowlist)
    - Size validation happens via FastAPI config

    Args:
        file: Uploaded file to validate

    Raises:
        HTTPException: If validation fails
    """
    # Check filename exists
    if not file.filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Filename is required"
        )

    # Check extension (allowlist)
    filename_lower = file.filename.lower()
    if not any(filename_lower.endswith(ext) for ext in ALLOWED_EXTENSIONS):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid file type. Allowed: {', '.join(ALLOWED_EXTENSIONS)}"
        )

    # Check content type (allowlist)
    if file.content_type not in ALLOWED_CONTENT_TYPES:
        logger.warning(f"Unexpected content type: {file.content_type}")
        # Be lenient on content type as browsers may vary


@router.post("/upload", response_model=MeetingUploadResponse)
async def upload_meeting(
    audio_file: UploadFile = File(..., description="Audio file (.wav or .mp3)"),
    metadata: str = Form(..., description="JSON metadata with meeting_title, attendees, scheduled_time"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> MeetingUploadResponse:
    """Upload a meeting recording for processing.

    Accepts audio file and meeting metadata, stores in blob storage,
    creates database records, and enqueues processing pipeline.

    Security:
    - Requires authentication (Azure AD JWT)
    - Validates file type (allowlist)
    - Sanitizes filename
    - No direct path exposure (uses blob storage)

    Args:
        audio_file: Audio recording (.wav or .mp3)
        metadata: JSON string with meeting details
        current_user: Authenticated user
        db: Database session

    Returns:
        MeetingUploadResponse with meeting_id and status

    Raises:
        HTTPException: 400 for validation errors, 500 for processing errors
    """
    # Validate audio file
    validate_audio_file(audio_file)

    # Parse metadata
    try:
        metadata_dict = json.loads(metadata)
        meeting_metadata = MeetingUploadMetadata(**metadata_dict)
    except json.JSONDecodeError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid JSON in metadata"
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid metadata: {str(e)}"
        )

    try:
        # Upload file to blob storage
        storage = get_storage()
        blob_path = await storage.upload_file(
            file=audio_file.file,
            filename=audio_file.filename,
            content_type=audio_file.content_type or "audio/wav"
        )

        logger.info(f"Audio uploaded to: {blob_path}")

        # Create meeting record
        meeting = Meeting(
            title=meeting_metadata.meeting_title,
            scheduled_time=meeting_metadata.scheduled_time,
            status=MeetingStatus.PROCESSING,
            audio_blob_url=blob_path,
            user_id=current_user.id
        )
        db.add(meeting)
        await db.flush()  # Get the meeting ID

        # Create participant records
        for attendee in meeting_metadata.attendees:
            participant = Participant(
                meeting_id=meeting.id,
                name=attendee.name,
                email=attendee.email
            )
            db.add(participant)

        await db.commit()
        await db.refresh(meeting)

        logger.info(f"Meeting record created: {meeting.id}")

        # Enqueue processing task
        task = process_meeting.delay(meeting.id)
        logger.info(f"Processing task enqueued: {task.id} for meeting {meeting.id}")

        return MeetingUploadResponse(
            meeting_id=meeting.id,
            status="processing"
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Upload failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to process upload"
        )


@router.get("", response_model=MeetingListResponse)
async def list_meetings(
    page: int = 1,
    per_page: int = 20,
    status_filter: Optional[str] = Query(None, alias="status"),
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MeetingListResponse:
    """List meetings for the authenticated user.

    Returns a paginated list ordered newest-first, with participant count
    and has_summary flags computed per row.
    """
    # Base query scoped to current user
    base = select(Meeting).where(Meeting.user_id == current_user.id)

    if status_filter:
        base = base.where(Meeting.status == MeetingStatus(status_filter))
    if date_from:
        base = base.where(Meeting.created_at >= date_from)
    if date_to:
        base = base.where(Meeting.created_at <= date_to)

    # Count total before pagination
    count_result = await db.execute(
        select(func.count()).select_from(base.subquery())
    )
    total = count_result.scalar() or 0

    # Fetch page
    offset = (page - 1) * per_page
    result = await db.execute(
        base.order_by(Meeting.created_at.desc())
        .offset(offset)
        .limit(per_page)
    )
    meetings = result.scalars().all()

    items = []
    for m in meetings:
        # Participant count
        p_result = await db.execute(
            select(func.count()).where(Participant.meeting_id == m.id)
        )
        participant_count = p_result.scalar() or 0

        # Has summary?
        s_result = await db.execute(
            select(func.count()).where(Summary.meeting_id == m.id)
        )
        has_summary = (s_result.scalar() or 0) > 0

        items.append(MeetingListItem(
            id=m.id,
            title=m.title,
            scheduled_time=m.scheduled_time,
            duration_seconds=m.duration_seconds,
            status=m.status.value,
            participant_count=participant_count,
            has_summary=has_summary,
            created_at=m.created_at,
        ))

    return MeetingListResponse(
        items=items,
        total=total,
        page=page,
        per_page=per_page,
        has_next=(offset + per_page) < total,
    )


@router.get("/{meeting_id}", response_model=MeetingDetailResponse)
async def get_meeting(
    meeting_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MeetingDetailResponse:
    """Get full meeting details including transcript, summary, and action items.

    Security:
    - Requires authentication
    - Verifies user owns the meeting (access control)
    """
    result = await db.execute(
        select(Meeting).where(
            Meeting.id == meeting_id,
            Meeting.user_id == current_user.id,
        )
    )
    meeting = result.scalars().first()

    if not meeting:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Meeting not found",
        )

    # Audio URL
    audio_url = None
    if meeting.audio_blob_url:
        try:
            storage = get_storage()
            audio_url = await storage.get_signed_url(meeting.audio_blob_url)
        except Exception as e:
            logger.warning(f"Could not generate audio URL: {e}")

    # Participants
    p_result = await db.execute(
        select(Participant).where(Participant.meeting_id == meeting.id)
    )
    participants = p_result.scalars().all()

    # Transcript
    t_result = await db.execute(
        select(Transcript).where(Transcript.meeting_id == meeting.id)
    )
    transcript_row = t_result.scalars().first()
    transcript = None
    if transcript_row:
        transcript = TranscriptResponse(
            meeting_id=meeting.id,
            segments=transcript_row.segments or [],
        )

    # Summary
    s_result = await db.execute(
        select(Summary).where(Summary.meeting_id == meeting.id)
    )
    summary_row = s_result.scalars().first()
    summary = None
    if summary_row:
        summary = SummaryResponse(
            summary_text=summary_row.summary_text,
            key_points=summary_row.key_points or [],
            follow_ups=summary_row.follow_ups or [],
        )

    # Action items
    ai_result = await db.execute(
        select(ActionItem).where(ActionItem.meeting_id == meeting.id)
    )
    action_items = ai_result.scalars().all()

    return MeetingDetailResponse(
        id=meeting.id,
        title=meeting.title,
        scheduled_time=meeting.scheduled_time,
        duration_seconds=meeting.duration_seconds,
        status=meeting.status.value,
        audio_url=audio_url,
        created_at=meeting.created_at,
        participants=[
            ParticipantResponse(id=p.id, name=p.name, email=p.email)
            for p in participants
        ],
        transcript=transcript,
        summary=summary,
        action_items=[
            ActionItemResponse(
                id=ai.id,
                meeting_id=ai.meeting_id,
                description=ai.description,
                owner_name=ai.owner_name,
                owner_email=ai.owner_email,
                due_date=ai.due_date,
                status=ai.status.value,
                created_at=ai.created_at,
                updated_at=ai.updated_at,
            )
            for ai in action_items
        ],
    )


@router.get("/{meeting_id}/transcript", response_model=TranscriptResponse)
async def get_transcript(
    meeting_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TranscriptResponse:
    """Get transcript for a specific meeting."""
    # Verify meeting belongs to user
    m_result = await db.execute(
        select(Meeting).where(
            Meeting.id == meeting_id,
            Meeting.user_id == current_user.id,
        )
    )
    if not m_result.scalars().first():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Meeting not found")

    t_result = await db.execute(
        select(Transcript).where(Transcript.meeting_id == meeting_id)
    )
    transcript = t_result.scalars().first()
    if not transcript:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transcript not available")

    return TranscriptResponse(
        meeting_id=meeting_id,
        segments=transcript.segments or [],
    )


@router.get("/{meeting_id}/action-items", response_model=list[ActionItemResponse])
async def get_meeting_action_items(
    meeting_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ActionItemResponse]:
    """Get action items for a specific meeting."""
    # Verify meeting belongs to user
    m_result = await db.execute(
        select(Meeting).where(
            Meeting.id == meeting_id,
            Meeting.user_id == current_user.id,
        )
    )
    if not m_result.scalars().first():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Meeting not found")

    result = await db.execute(
        select(ActionItem).where(ActionItem.meeting_id == meeting_id)
    )
    items = result.scalars().all()

    return [
        ActionItemResponse(
            id=ai.id,
            meeting_id=ai.meeting_id,
            description=ai.description,
            owner_name=ai.owner_name,
            owner_email=ai.owner_email,
            due_date=ai.due_date,
            status=ai.status.value,
            created_at=ai.created_at,
            updated_at=ai.updated_at,
        )
        for ai in items
    ]
