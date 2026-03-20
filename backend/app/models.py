"""SQLAlchemy database models."""
import enum
from datetime import datetime
from sqlalchemy import (
    Column,
    Integer,
    String,
    DateTime,
    ForeignKey,
    Enum,
    Text,
    Date,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import relationship

from app.core.database import Base


class MeetingStatus(str, enum.Enum):
    """Meeting processing status."""
    PROCESSING = "processing"
    TRANSCRIBING = "transcribing"
    DIARISING = "diarising"
    SUMMARISING = "summarising"
    COMPLETE = "complete"
    FAILED = "failed"


class ActionItemStatus(str, enum.Enum):
    """Action item status."""
    OPEN = "open"
    COMPLETE = "complete"


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


class Meeting(Base):
    """Meeting model."""
    __tablename__ = "meetings"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, nullable=False)
    scheduled_time = Column(DateTime, nullable=True)
    duration_seconds = Column(Integer, nullable=True)
    status = Column(Enum(MeetingStatus, values_callable=lambda e: [x.value for x in e]), default=MeetingStatus.PROCESSING, nullable=False, index=True)
    audio_blob_url = Column(String, nullable=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    # Relationships
    user = relationship("User", back_populates="meetings")
    participants = relationship("Participant", back_populates="meeting", cascade="all, delete-orphan")
    transcript = relationship("Transcript", back_populates="meeting", uselist=False, cascade="all, delete-orphan")
    summary = relationship("Summary", back_populates="meeting", uselist=False, cascade="all, delete-orphan")
    action_items = relationship("ActionItem", back_populates="meeting", cascade="all, delete-orphan")


class Participant(Base):
    """Meeting participant model."""
    __tablename__ = "participants"

    id = Column(Integer, primary_key=True, index=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), nullable=False, index=True)
    name = Column(String, nullable=False)
    email = Column(String, nullable=True)

    # Relationships
    meeting = relationship("Meeting", back_populates="participants")


class Transcript(Base):
    """Transcript model."""
    __tablename__ = "transcripts"

    id = Column(Integer, primary_key=True, index=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), unique=True, nullable=False, index=True)
    full_text = Column(Text, nullable=True)
    segments = Column(JSONB, nullable=True)  # Array of {speaker, start, end, text}

    # Relationships
    meeting = relationship("Meeting", back_populates="transcript")


class Summary(Base):
    """Summary model."""
    __tablename__ = "summaries"

    id = Column(Integer, primary_key=True, index=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), unique=True, nullable=False, index=True)
    summary_text = Column(Text, nullable=True)
    key_points = Column(JSONB, nullable=True)  # Array of strings
    follow_ups = Column(JSONB, nullable=True)  # Array of strings

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
    due_date = Column(Date, nullable=True)
    status = Column(Enum(ActionItemStatus, values_callable=lambda e: [x.value for x in e]), default=ActionItemStatus.OPEN, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    # Relationships
    meeting = relationship("Meeting", back_populates="action_items")
