"""SQLAlchemy database models."""
import enum
from datetime import datetime
from sqlalchemy import (
    Boolean,
    Column,
    Float,
    Integer,
    String,
    DateTime,
    ForeignKey,
    Enum,
    Text,
    Date,
    JSON,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship

from app.core.database import Base

# Use JSON type which works on both PostgreSQL (as JSONB) and SQLite (as TEXT).
# PostgreSQL will use its native JSON support; SQLite serializes to text.
JSONType = JSON


class MeetingStatus(str, enum.Enum):
    """Meeting processing status."""
    PROCESSING = "processing"
    TRANSCRIBING = "transcribing"
    DIARISING = "diarising"
    SUMMARISING = "summarising"
    COMPLETE = "complete"
    FAILED = "failed"


class VoiceprintStatus(str, enum.Enum):
    """Lifecycle status for a stored speaker voiceprint."""
    ACTIVE = "active"
    DISABLED = "disabled"
    DELETED = "deleted"
    NEEDS_REFRESH = "needs_refresh"

class ActionItemStatus(str, enum.Enum):
    """Action item status."""
    OPEN = "open"
    COMPLETE = "complete"


class SpeakerMappingSource(str, enum.Enum):
    """Source for resolved speaker identity mappings."""
    ASSEMBLYAI = "assemblyai"
    PYANNOTE = "pyannote"
    LLM_INFERENCE = "llm_inference"
    USER_CORRECTED = "user_corrected"


class ActionOwnerSource(str, enum.Enum):
    """Source for action item owner assignment."""
    SPEAKER_MAPPING = "speaker_mapping"
    EXPLICIT_NAME_MATCH = "explicit_name_match"
    LLM_EXTRACTION = "llm_extraction"
    USER_CORRECTED = "user_corrected"
    UNASSIGNED = "unassigned"


class User(Base):
    """User model."""
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, nullable=False, index=True)
    name = Column(String, nullable=False)
    azure_ad_id = Column(String, unique=True, nullable=False, index=True)
    role = Column(String, nullable=False, default="user")
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    # Relationships
    meetings = relationship("Meeting", back_populates="user", cascade="all, delete-orphan")
    voiceprints = relationship("Voiceprint", back_populates="user", cascade="all, delete-orphan")


class Voiceprint(Base):
    """Central firm voiceprint registry entry for known-speaker identification.

    Raw sample audio should be temporary. Production code should normally store
    only the provider voiceprint identifier plus consent/quality metadata here.
    """
    __tablename__ = "voiceprints"
    __table_args__ = (
        UniqueConstraint(
            "provider",
            "provider_voiceprint_id",
            name="uq_voiceprints_provider_voiceprint_id",
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    provider = Column(String, default="pyannote", nullable=False)
    provider_voiceprint_id = Column(String, nullable=False, index=True)
    display_name = Column(String, nullable=False)
    email = Column(String, nullable=True, index=True)
    status = Column(
        Enum(VoiceprintStatus, values_callable=lambda e: [x.value for x in e]),
        default=VoiceprintStatus.ACTIVE,
        nullable=False,
        index=True,
    )
    consent_recorded_at = Column(DateTime, nullable=True)
    raw_sample_path = Column(String, nullable=True)
    sample_duration_seconds = Column(Float, nullable=True)
    sample_source = Column(String, nullable=True)
    metadata_json = Column(JSONType, nullable=True)
    disabled_reason = Column(Text, nullable=True)
    deleted_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    user = relationship("User", back_populates="voiceprints", lazy="noload")


class Meeting(Base):
    """Meeting model."""
    __tablename__ = "meetings"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, nullable=False)
    scheduled_time = Column(DateTime, nullable=True)
    duration_seconds = Column(Integer, nullable=True)
    status = Column(Enum(MeetingStatus, values_callable=lambda e: [x.value for x in e]), default=MeetingStatus.PROCESSING, nullable=False, index=True)
    processing_error = Column(Text, nullable=True)
    audio_blob_url = Column(String, nullable=True)
    identity_hints = Column(JSONType, nullable=True)  # {current_user, organizer, source_event_id}
    needs_speaker_review = Column(Boolean, default=False, nullable=False, index=True)
    speaker_review_completed_at = Column(DateTime, nullable=True)
    speaker_mapping_quality = Column(Float, nullable=True)
    diarization_diagnostics = Column(JSONType, nullable=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    # Relationships
    user = relationship("User", back_populates="meetings")
    participants = relationship("Participant", back_populates="meeting", cascade="all, delete-orphan")
    transcript = relationship("Transcript", back_populates="meeting", uselist=False, cascade="all, delete-orphan")
    speaker_mappings = relationship("SpeakerMapping", back_populates="meeting", cascade="all, delete-orphan")
    summary = relationship("Summary", back_populates="meeting", uselist=False, cascade="all, delete-orphan")
    action_items = relationship("ActionItem", back_populates="meeting", cascade="all, delete-orphan")


class Participant(Base):
    """Meeting participant model."""
    __tablename__ = "participants"

    id = Column(Integer, primary_key=True, index=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), nullable=False, index=True)
    name = Column(String, nullable=False)
    email = Column(String, nullable=True)
    is_organizer = Column(Boolean, default=False, nullable=False)

    # Relationships
    meeting = relationship("Meeting", back_populates="participants")


class Transcript(Base):
    """Transcript model."""
    __tablename__ = "transcripts"

    id = Column(Integer, primary_key=True, index=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), unique=True, nullable=False, index=True)
    full_text = Column(Text, nullable=True)
    segments = Column(JSONType, nullable=True)  # Array of {speaker, start, end, text}
    speaker_identified = Column(Boolean, default=False, nullable=False)  # True when AssemblyAI matched real names

    # Relationships
    meeting = relationship("Meeting", back_populates="transcript")


class SpeakerMapping(Base):
    """Resolved identity for a raw transcript speaker label in one meeting."""
    __tablename__ = "speaker_mappings"
    __table_args__ = (
        UniqueConstraint("meeting_id", "speaker_label", name="uq_speaker_mappings_meeting_label"),
    )

    id = Column(Integer, primary_key=True, index=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), nullable=False, index=True)
    speaker_label = Column(String, nullable=False)
    display_name = Column(String, nullable=True)
    email = Column(String, nullable=True)
    confidence = Column(Float, default=0.0, nullable=False)
    source = Column(Enum(SpeakerMappingSource, values_callable=lambda e: [x.value for x in e]), nullable=False, index=True)
    reason = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    meeting = relationship("Meeting", back_populates="speaker_mappings")


class Summary(Base):
    """Summary model."""
    __tablename__ = "summaries"

    id = Column(Integer, primary_key=True, index=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), unique=True, nullable=False, index=True)
    summary_text = Column(Text, nullable=True)
    key_points = Column(JSONType, nullable=True)  # Array of strings
    follow_ups = Column(JSONType, nullable=True)  # Array of strings

    # Relationships
    meeting = relationship("Meeting", back_populates="summary")


class ActionItem(Base):
    """Action item model."""
    __tablename__ = "action_items"

    id = Column(Integer, primary_key=True, index=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), nullable=False, index=True)
    description = Column(Text, nullable=False)
    owner_name = Column(String, nullable=True)
    owner_email = Column(String, nullable=True)
    owner_confidence = Column(Float, nullable=True)
    owner_source = Column(Enum(ActionOwnerSource, values_callable=lambda e: [x.value for x in e]), nullable=True, index=True)
    owner_reason = Column(Text, nullable=True)
    due_date = Column(Date, nullable=True)
    status = Column(Enum(ActionItemStatus, values_callable=lambda e: [x.value for x in e]), default=ActionItemStatus.OPEN, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    # Relationships
    meeting = relationship("Meeting", back_populates="action_items")
