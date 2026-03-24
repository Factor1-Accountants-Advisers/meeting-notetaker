"""Pytest fixtures for testing."""
import os
import tempfile
from datetime import datetime
from typing import AsyncGenerator, Generator
from unittest.mock import MagicMock, AsyncMock

import pytest
from sqlalchemy import create_engine, JSON
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.pool import StaticPool
from sqlalchemy.dialects.postgresql import JSONB

from app.core.database import Base
from app.models import User, Meeting, MeetingStatus, Transcript


# Use in-memory SQLite for tests (sync engine for Celery tasks)
TEST_DATABASE_URL = "sqlite:///:memory:"


# Configure JSONB to use JSON on SQLite
@pytest.fixture(scope="function", autouse=True)
def _configure_jsonb_for_sqlite():
    """Configure JSONB to compile as JSON on SQLite."""
    from sqlalchemy.ext.compiler import compiles

    @compiles(JSONB, 'sqlite')
    def compile_jsonb_sqlite(type_, compiler, **kw):
        return compiler.process(JSON(), **kw)


@pytest.fixture(scope="function")
def db_engine():
    """Create a test database engine."""
    engine = create_engine(
        TEST_DATABASE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    yield engine
    Base.metadata.drop_all(bind=engine)


@pytest.fixture(scope="function")
def db_session(db_engine) -> Generator[Session, None, None]:
    """Create a test database session."""
    SessionLocal = sessionmaker(bind=db_engine)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def test_user(db_session: Session) -> User:
    """Create a test user."""
    user = User(
        email="test@example.com",
        name="Test User",
        azure_ad_id="test-azure-id-123",
        role="user",
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


@pytest.fixture
def test_meeting(db_session: Session, test_user: User) -> Meeting:
    """Create a test meeting in processing status."""
    meeting = Meeting(
        title="Test Meeting",
        scheduled_time=datetime.utcnow(),
        status=MeetingStatus.PROCESSING,
        audio_blob_url="audio/2026/03/19/test_audio.wav",
        user_id=test_user.id,
    )
    db_session.add(meeting)
    db_session.commit()
    db_session.refresh(meeting)
    return meeting


@pytest.fixture
def sample_audio_file() -> Generator[str, None, None]:
    """Create a temporary sample audio file for testing."""
    # Create a minimal WAV file header (44 bytes) + some data
    # This is a valid WAV file structure
    wav_header = bytes([
        0x52, 0x49, 0x46, 0x46,  # "RIFF"
        0x24, 0x00, 0x00, 0x00,  # File size - 8
        0x57, 0x41, 0x56, 0x45,  # "WAVE"
        0x66, 0x6D, 0x74, 0x20,  # "fmt "
        0x10, 0x00, 0x00, 0x00,  # Chunk size (16)
        0x01, 0x00,              # Audio format (PCM)
        0x01, 0x00,              # Num channels (1)
        0x80, 0x3E, 0x00, 0x00,  # Sample rate (16000)
        0x00, 0x7D, 0x00, 0x00,  # Byte rate
        0x02, 0x00,              # Block align
        0x10, 0x00,              # Bits per sample (16)
        0x64, 0x61, 0x74, 0x61,  # "data"
        0x00, 0x00, 0x00, 0x00,  # Data size
    ])

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(wav_header)
        f.write(b"\x00" * 1000)  # Some silent audio data
        temp_path = f.name

    yield temp_path

    # Cleanup
    if os.path.exists(temp_path):
        os.unlink(temp_path)


@pytest.fixture
def mock_storage():
    """Mock storage backend."""
    storage = MagicMock()
    storage.download_file = AsyncMock(return_value="/tmp/test_audio.wav")
    storage.get_signed_url = AsyncMock(return_value="http://example.com/audio.wav")
    return storage


@pytest.fixture
def mock_whisper_result():
    """Mock Whisper transcription result."""
    return {
        "text": "Hello, this is a test meeting. We discussed the project timeline.",
        "segments": [
            {
                "id": 0,
                "start": 0.0,
                "end": 2.5,
                "text": "Hello, this is a test meeting.",
            },
            {
                "id": 1,
                "start": 2.5,
                "end": 5.0,
                "text": "We discussed the project timeline.",
            },
        ],
    }
