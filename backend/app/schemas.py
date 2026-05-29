"""Pydantic schemas for API request and response validation."""
from datetime import datetime, date
from typing import List, Literal, Optional
from pydantic import BaseModel, EmailStr, Field


# ============================================================================
# User Schemas
# ============================================================================

class UserBase(BaseModel):
    """Base user schema."""
    email: EmailStr
    name: str


class UserResponse(UserBase):
    """User response schema for /api/me."""
    id: int
    role: str
    azure_ad_id: str
    created_at: datetime

    class Config:
        from_attributes = True


# ============================================================================
# Participant Schemas
# ============================================================================

class ParticipantBase(BaseModel):
    """Participant schema."""
    name: str
    email: Optional[EmailStr] = None


class ParticipantResponse(ParticipantBase):
    """Participant response with ID."""
    id: int

    class Config:
        from_attributes = True


# ============================================================================
# Meeting Schemas
# ============================================================================

class MeetingUploadMetadata(BaseModel):
    """Metadata sent with audio upload."""
    meeting_title: str
    attendees: List[ParticipantBase] = Field(..., min_length=1)
    scheduled_time: Optional[datetime] = None
    organizer: Optional[ParticipantBase] = None
    source_event_id: Optional[str] = None


class MeetingUploadResponse(BaseModel):
    """Response from /api/meetings/upload."""
    meeting_id: int
    status: str


class RenameSpeakerRequest(BaseModel):
    """Request body for PATCH /api/meetings/{id}/rename-speaker."""
    old_name: str = Field(..., min_length=1, max_length=100)
    new_name: str = Field(..., min_length=1, max_length=100)


class RenameSpeakerResponse(BaseModel):
    """Response from PATCH /api/meetings/{id}/rename-speaker."""
    updated_count: int


class MeetingListItem(BaseModel):
    """Meeting item in list view."""
    id: int
    title: str
    date: Optional[datetime] = Field(None, alias="scheduled_time")
    duration: Optional[int] = Field(None, alias="duration_seconds")
    status: str
    participant_count: int
    has_summary: bool
    created_at: datetime

    class Config:
        from_attributes = True
        populate_by_name = True


class MeetingListResponse(BaseModel):
    """Paginated meeting list response."""
    items: List[MeetingListItem]
    total: int
    page: int
    per_page: int
    has_next: bool


# ============================================================================
# Transcript Schemas
# ============================================================================

class TranscriptSegment(BaseModel):
    """Single transcript segment with speaker and timestamp."""
    speaker: str
    start: float
    end: float
    text: str
    raw_speaker: Optional[str] = None
    matched_email: Optional[str] = None
    match_confidence: Optional[float] = None


class TranscriptResponse(BaseModel):
    """Full transcript response."""
    meeting_id: int
    segments: List[TranscriptSegment]

    class Config:
        from_attributes = True


# ============================================================================
# Speaker Mapping Schemas
# ============================================================================

class SpeakerMappingResponse(BaseModel):
    """Speaker mapping response."""
    id: int
    meeting_id: int
    speaker_label: str
    display_name: Optional[str] = None
    email: Optional[EmailStr] = None
    confidence: float = Field(..., ge=0.0, le=1.0)
    source: str
    reason: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class SpeakerMappingUpdate(BaseModel):
    """Speaker mapping update request."""
    speaker_label: str = Field(..., min_length=1, max_length=100)
    display_name: Optional[str] = Field(None, max_length=200)
    email: Optional[EmailStr] = None
    confidence: float = Field(1.0, ge=0.0, le=1.0)
    source: Literal["user_corrected"] = "user_corrected"
    reason: Optional[str] = Field(None, max_length=500)


class SpeakerMappingListResponse(BaseModel):
    """Speaker mapping list response."""
    items: List[SpeakerMappingResponse]
    needs_speaker_review: bool
    speaker_mapping_quality: Optional[float] = Field(None, ge=0.0, le=1.0)


# ============================================================================
# Summary Schemas
# ============================================================================

class SummaryResponse(BaseModel):
    """AI-generated summary response."""
    summary_text: Optional[str] = None
    key_points: List[str] = Field(default_factory=list)
    follow_ups: List[str] = Field(default_factory=list)

    class Config:
        from_attributes = True


# ============================================================================
# Action Item Schemas
# ============================================================================

class ActionItemBase(BaseModel):
    """Base action item fields."""
    description: str
    owner_name: Optional[str] = None
    owner_email: Optional[EmailStr] = None
    due_date: Optional[date] = None
    status: str = "open"


class ActionItemCreate(ActionItemBase):
    """Action item creation request."""
    meeting_id: int


class ActionItemResponse(ActionItemBase):
    """Action item response."""
    id: int
    meeting_id: int
    owner_confidence: Optional[float] = Field(None, ge=0.0, le=1.0)
    owner_source: Optional[str] = None
    owner_reason: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ActionItemUpdate(BaseModel):
    """Action item update request."""
    description: Optional[str] = None
    owner_name: Optional[str] = None
    owner_email: Optional[EmailStr] = None
    due_date: Optional[date] = None
    status: Optional[str] = None


class ActionItemListResponse(BaseModel):
    """Paginated action items list."""
    items: List[ActionItemResponse]
    total: int
    page: int
    per_page: int
    has_next: bool


# ============================================================================
# Meeting Detail Schema (combines all)
# ============================================================================

class MeetingDetailResponse(BaseModel):
    """Complete meeting detail with all related data."""
    # Meeting metadata
    id: int
    title: str
    scheduled_time: Optional[datetime] = None
    duration_seconds: Optional[int] = None
    status: str
    audio_url: Optional[str] = None
    created_at: datetime

    # Participants
    participants: List[ParticipantResponse] = Field(default_factory=list)

    # Transcript
    transcript: Optional[TranscriptResponse] = None

    # Summary
    summary: Optional[SummaryResponse] = None

    # Action items
    action_items: List[ActionItemResponse] = Field(default_factory=list)

    # Speaker mappings
    needs_speaker_review: bool = False
    speaker_review_completed_at: Optional[datetime] = None
    speaker_mapping_quality: Optional[float] = Field(None, ge=0.0, le=1.0)
    diarization_diagnostics: Optional[dict] = None
    speaker_mappings: List[SpeakerMappingResponse] = Field(default_factory=list)

    class Config:
        from_attributes = True
