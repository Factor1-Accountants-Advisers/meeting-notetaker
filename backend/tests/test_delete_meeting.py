"""Tests for DELETE /api/meetings/{id}."""
import pytest
from datetime import datetime
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

    meeting = Meeting(id=10, title="Deletable Meeting",
                      scheduled_time=datetime.utcnow(),
                      status=MeetingStatus.COMPLETE,
                      audio_blob_url="audio/test.wav", user_id=1)
    async_db.add(meeting)

    other_user = User(id=2, email="other@example.com", name="Other User",
                      azure_ad_id="other-id", role="user")
    other_meeting = Meeting(id=20, title="Other Meeting",
                            scheduled_time=datetime.utcnow(),
                            status=MeetingStatus.COMPLETE,
                            audio_blob_url="audio/other.wav", user_id=2)
    async_db.add(other_user)
    async_db.add(other_meeting)
    await async_db.commit()
    return {"user": user, "meeting": meeting, "other_meeting": other_meeting}


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
async def test_delete_own_meeting(client: AsyncClient):
    resp = await client.delete("/api/meetings/10")
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_delete_nonexistent_returns_404(client: AsyncClient):
    resp = await client.delete("/api/meetings/999")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_other_users_meeting_returns_404(client: AsyncClient):
    resp = await client.delete("/api/meetings/20")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_is_permanent(client: AsyncClient):
    await client.delete("/api/meetings/10")
    resp = await client.get("/api/meetings/10")
    assert resp.status_code == 404
