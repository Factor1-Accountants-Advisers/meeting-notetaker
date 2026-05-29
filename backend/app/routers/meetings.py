"""Meeting endpoints.

Handles meeting upload, listing, and detail retrieval.
"""
import logging
import os
import tempfile
from typing import Any, Optional, cast
from datetime import datetime, timezone

from pydantic import ValidationError

from fastapi import APIRouter, Depends, HTTPException, Query, status, UploadFile, File, Form
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from sqlalchemy.orm.attributes import flag_modified
import json

from app.core.database import get_db
from app.api.dependencies import get_current_user
from app.models import (
    User, Meeting, Participant, Transcript, Summary, ActionItem,
    MeetingStatus, SpeakerMapping, SpeakerMappingSource, ActionOwnerSource,
)
from app.schemas import (
    MeetingUploadResponse, MeetingUploadMetadata,
    MeetingListItem, MeetingListResponse, MeetingDetailResponse,
    ParticipantResponse, TranscriptResponse, SummaryResponse,
    ActionItemResponse,
    RenameSpeakerRequest, RenameSpeakerResponse,
    SpeakerMappingListResponse, SpeakerMappingResponse, SpeakerMappingUpdate,
)
from app.services.storage import get_storage
from app.services.pipeline import enqueue_meeting
from app.services.audio import extract_audio_from_video
from app.services.identity_candidates import build_candidate_pool
from app.services.speaker_mapping import (
    build_diarization_diagnostics,
    calculate_mapping_quality,
    extract_speaker_labels,
    should_require_review,
    _mapping_counts_as_reviewed,
    _mapping_requires_confidence_review,
)
from app.services.action_owner_resolution import resolve_action_owner

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/meetings", tags=["meetings"])

# File validation constants
MAX_FILE_SIZE = 500 * 1024 * 1024  # 500 MB
ALLOWED_CONTENT_TYPES = [
    "audio/wav", "audio/wave", "audio/x-wav", "audio/mpeg", "audio/mp3",
    "video/mp4", "video/x-m4v", "video/quicktime",
]
ALLOWED_EXTENSIONS = [".wav", ".mp3", ".mp4", ".m4v", ".mov"]
VIDEO_EXTENSIONS = {".mp4", ".m4v", ".mov"}


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


def normalize_scheduled_time(value: Optional[datetime]) -> Optional[datetime]:
    """Convert aware datetimes to naive UTC for the current DB schema."""
    if value is None:
        return None
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


async def get_owned_meeting_or_404(
    db: AsyncSession, meeting_id: int, current_user: User
) -> Meeting:
    result = await db.execute(
        select(Meeting).where(Meeting.id == meeting_id, Meeting.user_id == current_user.id)
    )
    meeting = result.scalar_one_or_none()
    if meeting is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Meeting not found")
    return meeting


def _speaker_mapping_response(mapping: SpeakerMapping) -> SpeakerMappingResponse:
    return SpeakerMappingResponse(
        id=mapping.id,
        meeting_id=mapping.meeting_id,
        speaker_label=mapping.speaker_label,
        display_name=mapping.display_name,
        email=mapping.email,
        confidence=mapping.confidence,
        source=mapping.source.value if hasattr(mapping.source, "value") else mapping.source,
        reason=mapping.reason,
        created_at=mapping.created_at,
        updated_at=mapping.updated_at,
    )


def resolve_segments_for_display(
    segments: list[dict], mappings: list[SpeakerMapping]
) -> list[dict]:
    by_label = {mapping.speaker_label: mapping for mapping in mappings}
    resolved: list[dict] = []
    for segment in segments or []:
        raw = segment.get("speaker")
        mapping = by_label.get(raw)
        item = dict(segment)
        item["raw_speaker"] = raw
        if mapping and mapping.display_name:
            item["speaker"] = mapping.display_name
            item["matched_email"] = mapping.email
            item["match_confidence"] = mapping.confidence
        else:
            item["matched_email"] = None
            item["match_confidence"] = None
        resolved.append(item)
    return resolved


def _action_item_response(action_item: ActionItem) -> ActionItemResponse:
    return ActionItemResponse(
        id=action_item.id,
        meeting_id=action_item.meeting_id,
        description=action_item.description,
        owner_name=action_item.owner_name,
        owner_email=action_item.owner_email,
        owner_confidence=action_item.owner_confidence,
        owner_source=(
            action_item.owner_source.value
            if action_item.owner_source is not None and hasattr(action_item.owner_source, "value")
            else action_item.owner_source
        ),
        owner_reason=action_item.owner_reason,
        due_date=action_item.due_date,
        status=action_item.status.value,
        created_at=action_item.created_at,
        updated_at=action_item.updated_at,
    )


def _source_speaker_label_from_reason(owner_reason: str | None) -> str | None:
    prefix = "speaker_label="
    if not owner_reason or not owner_reason.startswith(prefix):
        return None
    label = owner_reason[len(prefix):].split(";", 1)[0].strip()
    return label or None


async def _list_speaker_mappings(
    db: AsyncSession, meeting: Meeting
) -> SpeakerMappingListResponse:
    result = await db.execute(
        select(SpeakerMapping)
        .where(SpeakerMapping.meeting_id == meeting.id)
        .order_by(SpeakerMapping.speaker_label)
    )
    mappings = list(result.scalars().all())
    return SpeakerMappingListResponse(
        items=[_speaker_mapping_response(mapping) for mapping in mappings],
        needs_speaker_review=meeting.needs_speaker_review,
        speaker_mapping_quality=meeting.speaker_mapping_quality,
    )


async def _refresh_speaker_mapping_diagnostics(
    db: AsyncSession, meeting: Meeting, transcript: Transcript | None = None
) -> None:
    if transcript is None:
        t_result = await db.execute(
            select(Transcript).where(Transcript.meeting_id == meeting.id)
        )
        transcript = t_result.scalar_one_or_none()

    labels = extract_speaker_labels(transcript.segments if transcript else [])
    result = await db.execute(
        select(SpeakerMapping)
        .where(SpeakerMapping.meeting_id == meeting.id)
        .order_by(SpeakerMapping.speaker_label)
    )
    mappings = list(result.scalars().all())
    if transcript is not None:
        label_set = set(labels)
        current_mappings = [m for m in mappings if m.speaker_label in label_set]
    else:
        current_mappings = mappings
    mappings_by_label = {cast(str, m.speaker_label): m for m in current_mappings}

    mapped_labels = [
        label
        for label in labels
        if label in mappings_by_label
        and _mapping_counts_as_reviewed(mappings_by_label[label])
    ]
    unmapped_labels = [
        label
        for label in labels
        if label not in mappings_by_label
        or not _mapping_counts_as_reviewed(mappings_by_label[label])
    ]
    low_confidence_labels = [
        label
        for label in labels
        if label in mappings_by_label
        and _mapping_requires_confidence_review(mappings_by_label[label])
    ]

    average_mapping_confidence = calculate_mapping_quality(current_mappings)
    cast(Any, meeting).speaker_mapping_quality = average_mapping_confidence
    cast(Any, meeting).needs_speaker_review = should_require_review(labels, mappings_by_label)
    cast(Any, meeting).diarization_diagnostics = build_diarization_diagnostics(
        labels=labels,
        mapped_labels=mapped_labels,
        unmapped_labels=unmapped_labels,
        low_confidence_labels=low_confidence_labels,
        average_mapping_confidence=average_mapping_confidence,
    )


async def _resolve_action_item_owners_for_meeting(
    db: AsyncSession, meeting: Meeting
) -> list[ActionItem]:
    p_result = await db.execute(
        select(Participant).where(Participant.meeting_id == meeting.id)
    )
    participants = list(p_result.scalars().all())
    candidates = build_candidate_pool(participants, meeting.identity_hints)

    m_result = await db.execute(
        select(SpeakerMapping)
        .where(SpeakerMapping.meeting_id == meeting.id)
        .order_by(SpeakerMapping.speaker_label)
    )
    mappings = list(m_result.scalars().all())
    mappings_by_label = {mapping.speaker_label: mapping for mapping in mappings}

    ai_result = await db.execute(
        select(ActionItem)
        .where(ActionItem.meeting_id == meeting.id)
        .order_by(ActionItem.id)
    )
    action_items = list(ai_result.scalars().all())

    for action_item in action_items:
        if action_item.owner_source == ActionOwnerSource.USER_CORRECTED:
            continue
        speaker_label = None
        if action_item.owner_source == ActionOwnerSource.SPEAKER_MAPPING:
            speaker_label = _source_speaker_label_from_reason(action_item.owner_reason)
        resolved = resolve_action_owner(
            extracted_owner=action_item.owner_name,
            speaker_label=speaker_label,
            candidates=candidates,
            mappings_by_label=mappings_by_label,
        )
        action_item.owner_name = resolved["owner_name"]
        action_item.owner_email = resolved["owner_email"]
        action_item.owner_confidence = resolved["owner_confidence"]
        action_item.owner_source = resolved["owner_source"]
        action_item.owner_reason = resolved["owner_reason"]

    await db.flush()
    return action_items


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
    except ValidationError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=e.errors()
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid metadata: {str(e)}"
        )

    opened_file = None
    temp_files: list[str] = []
    try:
        # If video file, extract audio first
        file_ext = os.path.splitext(audio_file.filename or "")[1].lower()
        upload_file = audio_file.file
        upload_filename = audio_file.filename or "recording.wav"
        upload_content_type = "audio/wav"

        if file_ext in VIDEO_EXTENSIONS:
            # Save uploaded video to temp file, then extract audio
            temp_video = tempfile.NamedTemporaryFile(
                suffix=file_ext, delete=False
            )
            temp_files.append(temp_video.name)
            try:
                temp_video.write(await audio_file.read())
                temp_video.close()
                extracted_path = extract_audio_from_video(temp_video.name)
                temp_files.append(extracted_path)
                opened_file = open(extracted_path, "rb")
                upload_file = opened_file
                upload_filename = os.path.splitext(upload_filename)[0] + ".wav"
                logger.info(f"Extracted audio from video: {audio_file.filename}")
            except RuntimeError as e:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=str(e),
                )
        else:
            upload_content_type = audio_file.content_type or "audio/wav"

        # Upload file to blob storage
        storage = get_storage()
        blob_path = await storage.upload_file(
            file=upload_file,
            filename=upload_filename,
            content_type=upload_content_type,
        )

        logger.info(f"Audio uploaded to: {blob_path}")

        # Build identity hints — always include current_user (the recorder)
        identity_hints = {
            "source_event_id": meeting_metadata.source_event_id,
            "current_user": {
                "name": current_user.name,
                "email": current_user.email,
                "azure_ad_id": current_user.azure_ad_id,
                "is_current_user": True,
            },
            "organizer": (
                {
                    "name": meeting_metadata.organizer.name,
                    "email": meeting_metadata.organizer.email,
                    "is_organizer": True,
                }
                if meeting_metadata.organizer else None
            ),
        }

        # Create meeting record
        meeting = Meeting(
            title=meeting_metadata.meeting_title,
            scheduled_time=normalize_scheduled_time(meeting_metadata.scheduled_time),
            status=MeetingStatus.PROCESSING,
            audio_blob_url=blob_path,
            user_id=current_user.id,
            identity_hints=identity_hints,
        )
        db.add(meeting)
        await db.flush()

        # Create participant records
        for attendee in meeting_metadata.attendees:
            is_org = (
                meeting_metadata.organizer is not None
                and attendee.email is not None
                and meeting_metadata.organizer.email is not None
                and attendee.email.lower() == meeting_metadata.organizer.email.lower()
            )
            participant = Participant(
                meeting_id=meeting.id,
                name=attendee.name,
                email=attendee.email,
                is_organizer=is_org,
            )
            db.add(participant)

        await db.commit()
        await db.refresh(meeting)

        logger.info(f"Meeting record created: {meeting.id}")

        # Launch processing pipeline in background thread
        enqueue_meeting(meeting.id)

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
    finally:
        if opened_file:
            opened_file.close()
        for tf in temp_files:
            try:
                os.unlink(tf)
            except OSError:
                pass


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

    # Correlated subqueries to avoid N+1
    participant_count_sq = (
        select(func.count())
        .where(Participant.meeting_id == Meeting.id)
        .correlate(Meeting)
        .scalar_subquery()
        .label("participant_count")
    )
    has_summary_sq = (
        select(func.count())
        .where(Summary.meeting_id == Meeting.id)
        .correlate(Meeting)
        .scalar_subquery()
        .label("summary_count")
    )

    # Fetch page with counts in a single query
    offset = (page - 1) * per_page
    result = await db.execute(
        select(Meeting, participant_count_sq, has_summary_sq)
        .where(Meeting.user_id == current_user.id)
        .where(
            Meeting.status == MeetingStatus(status_filter) if status_filter else True
        )
        .where(Meeting.created_at >= date_from if date_from else True)
        .where(Meeting.created_at <= date_to if date_to else True)
        .order_by(Meeting.created_at.desc())
        .offset(offset)
        .limit(per_page)
    )
    rows = result.all()

    items = []
    for m, participant_count, summary_count in rows:
        items.append(MeetingListItem(
            id=m.id,
            title=m.title,
            scheduled_time=m.scheduled_time,
            duration_seconds=m.duration_seconds,
            status=m.status.value,
            participant_count=participant_count or 0,
            has_summary=(summary_count or 0) > 0,
            created_at=m.created_at,
        ))

    return MeetingListResponse(
        items=items,
        total=total,
        page=page,
        per_page=per_page,
        has_next=(offset + per_page) < total,
    )


@router.get("/{meeting_id}/speaker-mappings", response_model=SpeakerMappingListResponse)
async def get_speaker_mappings(
    meeting_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SpeakerMappingListResponse:
    """Get speaker identity mappings for a meeting owned by the current user."""
    meeting = await get_owned_meeting_or_404(db, meeting_id, current_user)
    return await _list_speaker_mappings(db, meeting)


@router.put("/{meeting_id}/speaker-mappings", response_model=SpeakerMappingListResponse)
async def put_speaker_mappings(
    meeting_id: int,
    body: list[SpeakerMappingUpdate],
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SpeakerMappingListResponse:
    """Create/update user-corrected speaker mappings and re-resolve actions."""
    meeting = await get_owned_meeting_or_404(db, meeting_id, current_user)

    t_result = await db.execute(
        select(Transcript).where(Transcript.meeting_id == meeting.id)
    )
    transcript = t_result.scalar_one_or_none()
    if transcript is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transcript not found")

    valid_labels = set(extract_speaker_labels(transcript.segments or []))
    requested_labels = {item.speaker_label.strip() for item in body}
    invalid_labels = sorted(label for label in requested_labels if label not in valid_labels)
    if invalid_labels:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"speaker_label not present in transcript: {', '.join(invalid_labels)}",
        )

    existing_result = await db.execute(
        select(SpeakerMapping).where(SpeakerMapping.meeting_id == meeting.id)
    )
    existing = {mapping.speaker_label: mapping for mapping in existing_result.scalars().all()}

    for item in body:
        label = item.speaker_label.strip()
        mapping = existing.get(label)
        if mapping is None:
            mapping = SpeakerMapping(
                meeting_id=meeting.id,
                speaker_label=label,
                source=SpeakerMappingSource.USER_CORRECTED,
            )
            db.add(mapping)
            existing[label] = mapping

        mapping.display_name = item.display_name.strip() if item.display_name else None
        mapping.email = str(item.email).strip() if item.email else None
        mapping.confidence = item.confidence
        mapping.source = SpeakerMappingSource.USER_CORRECTED
        mapping.reason = item.reason.strip() if item.reason else None

    await db.flush()
    await _refresh_speaker_mapping_diagnostics(db, meeting, transcript)
    meeting.speaker_review_completed_at = (
        datetime.utcnow() if not meeting.needs_speaker_review else None
    )
    await _resolve_action_item_owners_for_meeting(db, meeting)
    await db.commit()
    await db.refresh(meeting)

    return await _list_speaker_mappings(db, meeting)


@router.post("/{meeting_id}/resolve-action-owners", response_model=list[ActionItemResponse])
async def resolve_action_owners(
    meeting_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ActionItemResponse]:
    """Re-resolve action item owners for a meeting owned by the current user."""
    meeting = await get_owned_meeting_or_404(db, meeting_id, current_user)
    action_items = await _resolve_action_item_owners_for_meeting(db, meeting)
    await db.commit()
    return [_action_item_response(action_item) for action_item in action_items]


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

    # Speaker mappings
    sm_result = await db.execute(
        select(SpeakerMapping)
        .where(SpeakerMapping.meeting_id == meeting.id)
        .order_by(SpeakerMapping.speaker_label)
    )
    speaker_mappings = list(sm_result.scalars().all())

    # Transcript
    t_result = await db.execute(
        select(Transcript).where(Transcript.meeting_id == meeting.id)
    )
    transcript_row = t_result.scalars().first()
    transcript = None
    if transcript_row:
        transcript = TranscriptResponse(
            meeting_id=meeting.id,
            segments=resolve_segments_for_display(
                transcript_row.segments or [], speaker_mappings
            ),
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
        action_items=[_action_item_response(ai) for ai in action_items],
        needs_speaker_review=meeting.needs_speaker_review,
        speaker_review_completed_at=meeting.speaker_review_completed_at,
        speaker_mapping_quality=meeting.speaker_mapping_quality,
        diarization_diagnostics=meeting.diarization_diagnostics,
        speaker_mappings=[
            _speaker_mapping_response(mapping) for mapping in speaker_mappings
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

    return [_action_item_response(ai) for ai in items]


@router.post("/{meeting_id}/retry", response_model=MeetingUploadResponse)
async def retry_meeting(
    meeting_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Re-enqueue a failed meeting for processing."""
    meeting = await db.get(Meeting, meeting_id)
    if not meeting or meeting.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Meeting not found")

    if meeting.status != MeetingStatus.FAILED:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot retry meeting in '{meeting.status.value}' state — only failed meetings can be retried",
        )

    meeting.status = MeetingStatus.PROCESSING
    await db.commit()

    enqueue_meeting(meeting.id)
    logger.info(f"Retry enqueued for meeting {meeting.id}")

    return MeetingUploadResponse(meeting_id=meeting.id, status="processing")


@router.delete("/{meeting_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_meeting(
    meeting_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a meeting owned by the authenticated user."""
    result = await db.execute(
        select(Meeting).where(Meeting.id == meeting_id, Meeting.user_id == current_user.id)
    )
    meeting = result.scalar_one_or_none()
    if not meeting:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Meeting not found")

    await db.delete(meeting)
    await db.commit()


@router.patch("/{meeting_id}/rename-speaker", response_model=RenameSpeakerResponse)
async def rename_speaker(
    meeting_id: int,
    body: RenameSpeakerRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RenameSpeakerResponse:
    """Rename all occurrences of a speaker label in a meeting transcript.

    Replaces every segment where speaker == old_name with new_name.
    Scoped to the current user's meetings only.

    Args:
        meeting_id: Meeting to update.
        body: old_name (current label) and new_name (replacement).
        current_user: Authenticated user.
        db: Database session.

    Returns:
        RenameSpeakerResponse with count of updated segments.

    Raises:
        HTTPException 404: If meeting or transcript not found, or not owned by user.
        HTTPException 422: If new_name is blank after stripping whitespace.
    """
    new_name = body.new_name.strip()
    if not new_name:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="new_name must not be blank",
        )

    # Verify meeting ownership
    result = await db.execute(
        select(Meeting).where(
            Meeting.id == meeting_id,
            Meeting.user_id == current_user.id,
        )
    )
    meeting = result.scalar_one_or_none()
    if not meeting:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Meeting not found")

    # Fetch transcript
    t_result = await db.execute(
        select(Transcript).where(Transcript.meeting_id == meeting_id)
    )
    transcript = t_result.scalar_one_or_none()
    if not transcript:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transcript not found")

    # Replace raw speaker labels and/or update display-name mappings.
    old_name = body.old_name
    segments = list(transcript.segments or [])
    updated_count = 0

    mapping_result = await db.execute(
        select(SpeakerMapping).where(SpeakerMapping.meeting_id == meeting_id)
    )
    mappings = list(mapping_result.scalars().all())
    display_label_mappings = [mapping for mapping in mappings if mapping.display_name == old_name]
    display_label_raw_labels = {mapping.speaker_label for mapping in display_label_mappings}

    if display_label_mappings:
        for mapping in display_label_mappings:
            mapping.display_name = new_name
            mapping.source = SpeakerMappingSource.USER_CORRECTED
            mapping.confidence = 1.0
            mapping.reason = "User corrected speaker display name"

        for seg in segments:
            raw_speaker = seg.get("raw_speaker") or seg.get("speaker")
            if raw_speaker in display_label_raw_labels:
                if seg.get("speaker") == old_name:
                    seg["speaker"] = new_name
                updated_count += 1
    else:
        for seg in segments:
            if seg.get("speaker") == old_name or seg.get("raw_speaker") == old_name:
                seg["speaker"] = new_name
                updated_count += 1

    # Persist — reassign to trigger SQLAlchemy change detection on JSON column
    transcript.segments = segments
    flag_modified(transcript, "segments")
    await db.commit()

    return RenameSpeakerResponse(updated_count=updated_count)
