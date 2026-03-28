"""Tests for retry endpoint and attendees validation."""
import pytest
from unittest.mock import patch, MagicMock
from httpx import AsyncClient, ASGITransport
from sqlalchemy import JSON, event
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.api.dependencies import get_current_user
from app.models import User, Meeting, MeetingStatus
from app.main import app

TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"


@pytest.fixture()
async def async_db():
    engine = create_async_engine(
        TEST_DATABASE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    @event.listens_for(engine.sync_engine, "connect")
    def _set_sqlite_json(dbapi_conn, connection_record):
        pass
    for table in Base.metadata.tables.values():
        for column in table.columns:
            if isinstance(column.type, JSONB):
                column.type = JSON()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        yield session
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest.fixture()
async def client(async_db: AsyncSession):
    user = User(id=1, email="test@example.com", name="Test User", azure_ad_id="test-azure-id-123", role="user")
    async_db.add(user)
    await async_db.flush()

    async def override_get_db():
        yield async_db

    async def override_get_current_user():
        return user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_retry_requeues_failed_meeting(client: AsyncClient, async_db: AsyncSession):
    """POST /api/meetings/{id}/retry should reset status and re-enqueue."""
    meeting = Meeting(
        title="Failed Meeting",
        status=MeetingStatus.FAILED,
        audio_blob_url="audio/test.wav",
        user_id=1,
    )
    async_db.add(meeting)
    await async_db.commit()
    await async_db.refresh(meeting)

    with patch("app.routers.meetings.process_meeting") as mock_task:
        mock_task.delay.return_value = MagicMock(id="mock-task-id")
        response = await client.post(f"/api/meetings/{meeting.id}/retry")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "processing"
    mock_task.delay.assert_called_once_with(meeting.id)


@pytest.mark.asyncio
async def test_retry_rejects_non_failed_meeting(client: AsyncClient, async_db: AsyncSession):
    """Cannot retry a meeting that isn't in FAILED state."""
    meeting = Meeting(
        title="Processing Meeting",
        status=MeetingStatus.PROCESSING,
        audio_blob_url="audio/test.wav",
        user_id=1,
    )
    async_db.add(meeting)
    await async_db.commit()
    await async_db.refresh(meeting)

    response = await client.post(f"/api/meetings/{meeting.id}/retry")
    assert response.status_code == 409


@pytest.mark.asyncio
async def test_upload_rejects_empty_attendees(client: AsyncClient):
    """POST /api/meetings/upload should reject requests with zero attendees."""
    import json
    from io import BytesIO

    # Minimal WAV header
    wav_header = bytes([
        0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
        0x57, 0x41, 0x56, 0x45, 0x66, 0x6D, 0x74, 0x20,
        0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
        0x80, 0x3E, 0x00, 0x00, 0x00, 0x7D, 0x00, 0x00,
        0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61,
        0x00, 0x00, 0x00, 0x00,
    ])
    audio = wav_header + b"\x00" * 1000

    metadata = json.dumps({
        "meeting_title": "Test Meeting",
        "attendees": [],
    })

    response = await client.post(
        "/api/meetings/upload",
        files={"audio_file": ("test.wav", BytesIO(audio), "audio/wav")},
        data={"metadata": metadata},
    )
    assert response.status_code == 422
