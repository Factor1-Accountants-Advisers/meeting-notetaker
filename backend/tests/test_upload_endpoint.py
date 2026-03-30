"""Regression tests for the meeting upload endpoint."""
import json

import pytest
from httpx import AsyncClient, ASGITransport
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.dependencies import get_current_user
from app.core.database import Base, get_db
from app.main import app
from app.models import Meeting, Participant, User


TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"


@pytest.fixture()
async def async_db():
    engine = create_async_engine(
        TEST_DATABASE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

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
async def upload_client(async_db: AsyncSession, monkeypatch: pytest.MonkeyPatch):
    user = User(
        id=1,
        email="test@example.com",
        name="Test User",
        azure_ad_id="test-azure-id-123",
        role="user",
    )
    async_db.add(user)
    await async_db.commit()

    class FakeStorage:
        async def upload_file(self, file, filename: str, content_type: str) -> str:
            return f"audio/test/{filename}"

    class FakeTask:
        id = "fake-task-id"

    class FakeProcessMeeting:
        @staticmethod
        def delay(meeting_id: int):
            return FakeTask()

    async def override_get_db():
        yield async_db

    async def override_get_current_user():
        return user

    monkeypatch.setattr("app.routers.meetings.get_storage", lambda: FakeStorage())
    monkeypatch.setattr("app.routers.meetings.process_meeting", FakeProcessMeeting())

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, async_db

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_upload_accepts_timezone_aware_scheduled_time(upload_client):
    client, db = upload_client

    metadata = {
        "meeting_title": "AI Mission Catch Up",
        "attendees": [{"name": "Joseph Miguel Guerrero", "email": "joseph@factor1.com.au"}],
        "scheduled_time": "2026-03-30T11:00:00+08:00",
    }

    response = await client.post(
        "/api/meetings/upload",
        files={
            "audio_file": ("meeting.wav", b"RIFF0000WAVEfmt ", "audio/wav"),
            "metadata": (None, json.dumps(metadata)),
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "processing"

    meeting = await db.get(Meeting, payload["meeting_id"])
    assert meeting is not None
    assert meeting.scheduled_time is not None
    assert meeting.scheduled_time.tzinfo is None
    assert meeting.scheduled_time.isoformat() == "2026-03-30T03:00:00"

    participants = (
        await db.execute(
            Participant.__table__.select().where(Participant.meeting_id == meeting.id)
        )
    ).all()
    assert len(participants) == 1
