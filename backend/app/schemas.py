"""Pydantic models mirroring the indicative schema (requirements §6.1).

These are the API shapes the Electron client consumes. Database models arrive
with the PostgreSQL work; keep the two aligned.
"""

from datetime import date, datetime
from enum import Enum
from uuid import UUID

from pydantic import BaseModel, Field


class MeetingStatus(str, Enum):
    draft = "draft"
    finalized = "finalized"


class MeetingSource(str, Enum):
    online = "online"  # WASAPI loopback + mic
    in_person = "in_person"  # mic only
    upload = "upload"


class PipelineStatus(str, Enum):
    pending_audio = "pending_audio"  # created, no recording uploaded yet
    queued = "queued"  # audio stored, waiting for transcription
    processing = "processing"  # transcribe -> diarize -> match -> summarise
    ready = "ready"
    failed = "failed"  # flagged for retry (requirements §4.4)


class PipelineStage(str, Enum):
    pending_audio = "pending_audio"
    audio_uploaded = "audio_uploaded"
    queued = "queued"
    transcribing_diarizing = "transcribing_diarizing"
    identifying_speakers = "identifying_speakers"
    extracting_notes = "extracting_notes"
    ready = "ready"
    failed = "failed"


class DeliveryStatus(str, Enum):
    not_started = "not_started"
    emailing = "emailing"
    emailed = "emailed"
    failed = "failed"


class GraphMeetingAttendeeMetadata(BaseModel):
    name: str | None = None
    email: str | None = None
    response: str | None = None


class GraphMeetingMetadata(BaseModel):
    """Calendar/Teams metadata carried from Graph detection to the backend."""

    title: str | None = None
    attendees: list[GraphMeetingAttendeeMetadata] = Field(default_factory=list)
    meeting_id: str
    online_meeting_id: str | None = None
    join_web_url: str | None = None
    organizer_email: str | None = None


class Priority(str, Enum):
    high = "high"
    medium = "medium"
    low = "low"


class ActionItemStatus(str, Enum):
    open = "open"
    done = "done"
    # "overdue" is derived from deadline < today while open, not stored.


class AccessRole(str, Enum):
    owner = "owner"
    editor = "editor"
    viewer = "viewer"


class TranscriptSegment(BaseModel):
    speaker: str  # display name, or "Unknown N" until manually named
    speaker_known: bool
    text: str
    start_ms: int
    end_ms: int
    raw_speaker: str | None = None
    speaker_source: str = "unknown"  # pyannote_voiceprint | unknown | user_corrected later
    speaker_confidence: float | None = None
    speaker_evidence_start_ms: int | None = None
    speaker_evidence_end_ms: int | None = None
    speaker_evidence_job_id: str | None = None
    unknown_reason: str | None = None


class Meeting(BaseModel):
    id: UUID
    title: str
    context: str = "Internal"  # client name or "Internal"
    source: MeetingSource
    owner_id: str
    status: MeetingStatus = MeetingStatus.draft
    created_at: datetime
    duration_seconds: int | None = None
    unknown_speaker_count: int = 0
    action_item_count: int = 0
    pipeline_status: PipelineStatus = PipelineStatus.pending_audio
    pipeline_stage: PipelineStage = PipelineStage.pending_audio
    pipeline_stage_message: str = "Waiting for recording upload."
    pipeline_started_at: datetime | None = None
    pipeline_updated_at: datetime | None = None
    pipeline_completed_at: datetime | None = None
    processing_error_code: str | None = None
    processing_error_message: str | None = None
    processing_attempt: int = 0
    delivery_status: DeliveryStatus = DeliveryStatus.not_started
    delivery_error_message: str | None = None
    graph_metadata: GraphMeetingMetadata | None = None


class MeetingCreate(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    context: str = "Internal"
    source: MeetingSource
    meeting_link: str | None = None  # optional; only used for Graph auto-fill
    graph_metadata: GraphMeetingMetadata | None = None


class ActionItem(BaseModel):
    id: UUID
    meeting_id: UUID
    meeting_title: str = ""  # denormalised for list views; filled by routers
    owner: str | None = None  # None when owned by an unnamed Unknown speaker
    description: str
    deadline: date | None = None
    priority: Priority = Priority.medium
    status: ActionItemStatus = ActionItemStatus.open


class ActionItemUpdate(BaseModel):
    owner: str | None = None
    description: str | None = None
    deadline: date | None = None
    priority: Priority | None = None
    status: ActionItemStatus | None = None


class MeetingParticipant(BaseModel):
    name: str  # display name, or "Unknown N" until manually named
    known: bool


class MeetingReview(BaseModel):
    """Everything the review screen needs in one response."""

    meeting: "Meeting"
    summary_text: str | None = None
    participants: list[MeetingParticipant] = []
    segments: list[TranscriptSegment] = []
    action_items: list[ActionItem] = []


class NameSpeakerRequest(BaseModel):
    label: str = Field(min_length=1)  # e.g. "Unknown 1"
    name: str = Field(min_length=1)


class MeetingAccessEntry(BaseModel):
    """Per-meeting access (decision #7): private to participants by default,
    shareable by the owner. Keyed by display name until Entra IDs arrive."""

    user: str
    role: AccessRole


class GrantAccessRequest(BaseModel):
    user: str = Field(min_length=1)
    role: AccessRole = AccessRole.viewer


class AuditEntry(BaseModel):
    """Who/what/when for every edit, naming, and finalisation (requirements §4.6)."""

    id: UUID
    meeting_id: UUID | None = None
    actor: str
    action: str  # e.g. "transcript.edit", "speaker.name", "meeting.finalize"
    target: str  # human-readable target, e.g. "segment 3", "action item <desc>"
    before: str | None = None
    after: str | None = None
    at: datetime


class EditSegmentRequest(BaseModel):
    text: str = Field(min_length=1)


class EmailRequest(BaseModel):
    note: str | None = None  # optional message above the notes
    recorder_email: str | None = None  # fallback recipient for manual/ad-hoc recordings


class EmailResult(BaseModel):
    recipients: list[str]
    sent_at: datetime


class UploadAudioRequest(BaseModel):
    """Recorded or uploaded meeting audio, base64-encoded.

    Stored to the local audio dir (stand-in for Azure Blob with its 30-day
    lifecycle policy) and queued for the processing pipeline.
    """

    audio_b64: str = Field(min_length=1)
    mime_type: str = "audio/webm"
    # Optional separate WASAPI/system capture. When present, the backend merges
    # mic + system with ffmpeg before transcription so Chromium cannot drop the
    # second audio track from a multi-track MediaRecorder stream.
    system_audio_b64: str | None = None
    system_mime_type: str | None = None
    duration_seconds: int | None = None  # client-measured; refined later
    graph_metadata: GraphMeetingMetadata | None = None


class PersonEnrollment(BaseModel):
    employee_id: str
    display_name: str
    role: str = ""
    enrolled: bool
    model_version: str | None = None
    reenrollment_required: bool = False


class CurrentUserRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    email: str = Field(min_length=3, max_length=320)


class EnrollRequest(BaseModel):
    """Three short clips of natural speech (~5–20 s each), base64-encoded.

    Audio is held in memory only while pyannoteAI creates provider voiceprints.
    Raw clips are not exposed to the renderer, logged, or persisted locally.
    """

    clips_b64: list[str] = Field(min_length=3, max_length=3)
    mime_type: str = "audio/webm"
