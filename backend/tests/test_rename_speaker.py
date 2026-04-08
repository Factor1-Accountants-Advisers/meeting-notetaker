"""Tests for PATCH /api/meetings/{id}/rename-speaker."""
import pytest
from datetime import datetime
from httpx import AsyncClient, ASGITransport
from sqlalchemy import JSON, event
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.api.dependencies import get_current_user
from app.models import User, Meeting, MeetingStatus, Transcript
from app.main import app

TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"


@pytest.fixture()
async def async_db():
    engine = create_async_engine(
        TEST_DATABASE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    for table in Base.metadata.tables.values():
        for column in table.columns:
            if isinstance(column.type, JSONB):
                column.type = JSON()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )
    async with session_factory() as session:
        yield session

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest.fixture()
async def seed_data(async_db: AsyncSession):
    user = User(id=1, email="test@example.com", name="Test User",
                azure_ad_id="test-id", role="user")
    async_db.add(user)
    await async_db.flush()

    meeting = Meeting(
        id=10, title="Test Meeting",
        scheduled_time=datetime.utcnow(),
        status=MeetingStatus.COMPLETE,
        audio_blob_url="audio/test.wav",
        user_id=1,
    )
    async_db.add(meeting)
    await async_db.flush()

    transcript = Transcript(
        meeting_id=10,
        full_text="Hello world",
        segments=[
            {"speaker": "Speaker A", "start": 0.0, "end": 2.0, "text": "Hello."},
            {"speaker": "Speaker B", "start": 2.0, "end": 4.0, "text": "World."},
            {"speaker": "Speaker A", "start": 4.0, "end": 6.0, "text": "Goodbye."},
        ],
        speaker_identified=False,
    )
    async_db.add(transcript)

    other_user = User(id=2, email="other@example.com", name="Other",
                      azure_ad_id="other-id", role="user")
    other_meeting = Meeting(
        id=20, title="Other Meeting",
        scheduled_time=datetime.utcnow(),
        status=MeetingStatus.COMPLETE,
        audio_blob_url="audio/other.wav",
        user_id=2,
    )
    async_db.add(other_user)
    async_db.add(other_meeting)
    await async_db.commit()
    return {"user": user, "meeting": meeting, "transcript": transcript}


@pytest.fixture()
async def client(async_db: AsyncSession, seed_data):
    async def override_db():
        yield async_db

    async def override_user():
        return seed_data["user"]

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_user

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        yield ac

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_rename_speaker_replaces_all_occurrences(client: AsyncClient, async_db: AsyncSession):
    resp = await client.patch(
        "/api/meetings/10/rename-speaker",
        json={"old_name": "Speaker A", "new_name": "John Smith"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["updated_count"] == 2  # Two segments had "Speaker A"

    # Verify DB persisted the change
    from sqlalchemy import select
    from app.models import Transcript
    result = await async_db.execute(select(Transcript).where(Transcript.meeting_id == 10))
    t = result.scalar_one()
    speakers = [seg["speaker"] for seg in t.segments]
    assert "Speaker A" not in speakers
    assert speakers.count("John Smith") == 2
    assert speakers.count("Speaker B") == 1


@pytest.mark.asyncio
async def test_rename_speaker_nonexistent_meeting_returns_404(client: AsyncClient):
    resp = await client.patch(
        "/api/meetings/999/rename-speaker",
        json={"old_name": "Speaker A", "new_name": "John"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_rename_speaker_other_users_meeting_returns_404(client: AsyncClient):
    resp = await client.patch(
        "/api/meetings/20/rename-speaker",
        json={"old_name": "Speaker A", "new_name": "John"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_rename_speaker_empty_new_name_returns_422(client: AsyncClient):
    resp = await client.patch(
        "/api/meetings/10/rename-speaker",
        json={"old_name": "Speaker A", "new_name": "   "},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_rename_zero_matches_returns_zero_count(client: AsyncClient):
    resp = await client.patch(
        "/api/meetings/10/rename-speaker",
        json={"old_name": "Speaker X", "new_name": "Nobody"},
    )
    assert resp.status_code == 200
    assert resp.json()["updated_count"] == 0
