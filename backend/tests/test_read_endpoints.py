"""Tests for Step 7: Read endpoints.

Tests the meeting list, meeting detail, transcript, and action item
endpoints using an async test client with dependency overrides.
"""
import pytest
from datetime import datetime, date
from httpx import AsyncClient, ASGITransport
from sqlalchemy import JSON, event
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.api.dependencies import get_current_user
from app.models import (
    User, Meeting, Participant, Transcript, Summary, ActionItem,
    MeetingStatus, ActionItemStatus,
)
from app.main import app


# ---------------------------------------------------------------------------
# Async test database setup
# ---------------------------------------------------------------------------

TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"


@pytest.fixture()
async def async_db():
    """Create an async in-memory SQLite database for testing."""
    engine = create_async_engine(
        TEST_DATABASE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    # Map JSONB to JSON for SQLite compatibility
    @event.listens_for(engine.sync_engine, "connect")
    def _set_sqlite_json(dbapi_conn, connection_record):
        pass

    # Replace JSONB with JSON in metadata for SQLite
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
    """Seed the test database with sample data and return key objects."""
    # User
    user = User(
        id=1,
        email="test@example.com",
        name="Test User",
        azure_ad_id="test-azure-id-123",
        role="user",
    )
    async_db.add(user)
    await async_db.flush()

    # Meeting 1 – complete with transcript + summary + action items
    m1 = Meeting(
        id=1,
        title="Q1 Planning",
        scheduled_time=datetime(2026, 3, 19, 9, 0),
        duration_seconds=1800,
        status=MeetingStatus.COMPLETE,
        audio_blob_url="audio/2026/03/19/abc123_meeting.wav",
        user_id=user.id,
    )
    async_db.add(m1)
    await async_db.flush()

    # Participants
    p1 = Participant(meeting_id=m1.id, name="Alice", email="alice@example.com")
    p2 = Participant(meeting_id=m1.id, name="Bob", email="bob@example.com")
    async_db.add_all([p1, p2])

    # Transcript
    transcript = Transcript(
        meeting_id=m1.id,
        full_text="Alice: Hello. Bob: Hi.",
        segments=[
            {"speaker": "Alice", "start": 0.0, "end": 1.5, "text": "Hello."},
            {"speaker": "Bob", "start": 1.5, "end": 3.0, "text": "Hi."},
        ],
    )
    async_db.add(transcript)

    # Summary
    summary = Summary(
        meeting_id=m1.id,
        summary_text="Brief planning meeting.",
        key_points=["Discussed Q1 goals", "Set deadlines"],
        follow_ups=["Review budget"],
    )
    async_db.add(summary)

    # Action items
    ai1 = ActionItem(
        meeting_id=m1.id,
        description="Prepare budget report",
        owner_name="Alice",
        owner_email="alice@example.com",
        due_date=date(2026, 3, 25),
        status=ActionItemStatus.OPEN,
    )
    ai2 = ActionItem(
        meeting_id=m1.id,
        description="Schedule follow-up",
        owner_name="Bob",
        owner_email="bob@example.com",
        due_date=date(2026, 4, 1),
        status=ActionItemStatus.OPEN,
    )
    async_db.add_all([ai1, ai2])

    # Meeting 2 – still processing (no transcript/summary)
    m2 = Meeting(
        id=2,
        title="Standup",
        scheduled_time=datetime(2026, 3, 19, 10, 0),
        status=MeetingStatus.PROCESSING,
        audio_blob_url="audio/2026/03/19/def456_standup.wav",
        user_id=user.id,
    )
    async_db.add(m2)

    await async_db.commit()
    return {"user": user, "meeting1": m1, "meeting2": m2}


@pytest.fixture()
async def client(async_db: AsyncSession, seed_data):
    """Create an async test client with dependency overrides."""
    user = seed_data["user"]

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


# ---------------------------------------------------------------------------
# GET /api/meetings — paginated list
# ---------------------------------------------------------------------------

class TestGetMeetings:
    """Tests for the meeting list endpoint."""

    @pytest.mark.asyncio
    async def test_list_meetings_returns_all(self, client: AsyncClient):
        resp = await client.get("/api/meetings")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 2
        assert len(data["items"]) == 2

    @pytest.mark.asyncio
    async def test_list_meetings_pagination(self, client: AsyncClient):
        resp = await client.get("/api/meetings?page=1&per_page=1")
        data = resp.json()
        assert len(data["items"]) == 1
        assert data["has_next"] is True
        assert data["page"] == 1

    @pytest.mark.asyncio
    async def test_list_meetings_filter_by_status(self, client: AsyncClient):
        resp = await client.get("/api/meetings?status=complete")
        data = resp.json()
        assert data["total"] == 1
        assert data["items"][0]["title"] == "Q1 Planning"

    @pytest.mark.asyncio
    async def test_list_meetings_ordered_newest_first(self, client: AsyncClient):
        resp = await client.get("/api/meetings")
        items = resp.json()["items"]
        # Meeting 2 was created after Meeting 1
        assert items[0]["id"] == 2
        assert items[1]["id"] == 1

    @pytest.mark.asyncio
    async def test_list_meetings_includes_participant_count(self, client: AsyncClient):
        resp = await client.get("/api/meetings")
        items = resp.json()["items"]
        # Find the completed meeting (has 2 participants)
        m1 = next(i for i in items if i["id"] == 1)
        assert m1["participant_count"] == 2

    @pytest.mark.asyncio
    async def test_list_meetings_includes_has_summary(self, client: AsyncClient):
        resp = await client.get("/api/meetings")
        items = resp.json()["items"]
        m1 = next(i for i in items if i["id"] == 1)
        m2 = next(i for i in items if i["id"] == 2)
        assert m1["has_summary"] is True
        assert m2["has_summary"] is False

    @pytest.mark.asyncio
    async def test_filter_by_date_from(self, client: AsyncClient):
        # m1 is scheduled 2026-03-19 09:00, m2 is 2026-03-19 10:00
        # date_from filters on created_at; both meetings were created in the same
        # session so use a far-future cutoff to verify the filter excludes all.
        resp = await client.get("/api/meetings?date_from=2099-01-01T00:00:00")
        data = resp.json()
        assert data["total"] == 0
        assert data["items"] == []

    @pytest.mark.asyncio
    async def test_filter_by_date_to(self, client: AsyncClient):
        # A date_to in the past should exclude all meetings.
        resp = await client.get("/api/meetings?date_to=2000-01-01T00:00:00")
        data = resp.json()
        assert data["total"] == 0
        assert data["items"] == []

    @pytest.mark.asyncio
    async def test_filter_by_date_range_returns_all(self, client: AsyncClient):
        # A wide range should return all meetings.
        resp = await client.get(
            "/api/meetings?date_from=2000-01-01T00:00:00&date_to=2099-01-01T00:00:00"
        )
        data = resp.json()
        assert data["total"] == 2


# ---------------------------------------------------------------------------
# GET /api/meetings/{id} — full detail
# ---------------------------------------------------------------------------

class TestGetMeetingDetail:
    """Tests for the meeting detail endpoint."""

    @pytest.mark.asyncio
    async def test_get_meeting_detail(self, client: AsyncClient):
        resp = await client.get("/api/meetings/1")
        assert resp.status_code == 200
        data = resp.json()
        assert data["title"] == "Q1 Planning"
        assert data["status"] == "complete"
        assert len(data["participants"]) == 2
        assert data["summary"] is not None
        assert data["summary"]["summary_text"] == "Brief planning meeting."
        assert len(data["action_items"]) == 2

    @pytest.mark.asyncio
    async def test_get_meeting_detail_includes_transcript(self, client: AsyncClient):
        resp = await client.get("/api/meetings/1")
        data = resp.json()
        assert data["transcript"] is not None
        assert len(data["transcript"]["segments"]) == 2

    @pytest.mark.asyncio
    async def test_get_meeting_not_found(self, client: AsyncClient):
        resp = await client.get("/api/meetings/999")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_get_processing_meeting(self, client: AsyncClient):
        resp = await client.get("/api/meetings/2")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "processing"
        assert data["transcript"] is None
        assert data["summary"] is None


# ---------------------------------------------------------------------------
# GET /api/meetings/{id}/transcript
# ---------------------------------------------------------------------------

class TestGetTranscript:
    """Tests for the transcript endpoint."""

    @pytest.mark.asyncio
    async def test_get_transcript(self, client: AsyncClient):
        resp = await client.get("/api/meetings/1/transcript")
        assert resp.status_code == 200
        data = resp.json()
        assert data["meeting_id"] == 1
        assert len(data["segments"]) == 2
        assert data["segments"][0]["speaker"] == "Alice"

    @pytest.mark.asyncio
    async def test_get_transcript_not_ready(self, client: AsyncClient):
        resp = await client.get("/api/meetings/2/transcript")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_get_transcript_meeting_not_found(self, client: AsyncClient):
        resp = await client.get("/api/meetings/999/transcript")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# GET /api/meetings/{id}/action-items
# ---------------------------------------------------------------------------

class TestGetMeetingActionItems:
    """Tests for meeting-scoped action items endpoint."""

    @pytest.mark.asyncio
    async def test_get_meeting_action_items(self, client: AsyncClient):
        resp = await client.get("/api/meetings/1/action-items")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 2
        descriptions = {item["description"] for item in data}
        assert "Prepare budget report" in descriptions

    @pytest.mark.asyncio
    async def test_get_meeting_action_items_empty(self, client: AsyncClient):
        resp = await client.get("/api/meetings/2/action-items")
        assert resp.status_code == 200
        assert resp.json() == []


# ---------------------------------------------------------------------------
# GET /api/action-items — cross-meeting action items
# ---------------------------------------------------------------------------

class TestGetAllActionItems:
    """Tests for the global action items endpoint."""

    @pytest.mark.asyncio
    async def test_list_all_action_items(self, client: AsyncClient):
        resp = await client.get("/api/action-items")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 2
        assert len(data["items"]) == 2

    @pytest.mark.asyncio
    async def test_filter_by_status(self, client: AsyncClient):
        resp = await client.get("/api/action-items?status=open")
        data = resp.json()
        assert data["total"] == 2  # both are open

    @pytest.mark.asyncio
    async def test_pagination(self, client: AsyncClient):
        resp = await client.get("/api/action-items?page=1&per_page=1")
        data = resp.json()
        assert len(data["items"]) == 1
        assert data["has_next"] is True


# ---------------------------------------------------------------------------
# PATCH /api/action-items/{id} — update action item
# ---------------------------------------------------------------------------

class TestPatchActionItem:
    """Tests for updating action items."""

    @pytest.mark.asyncio
    async def test_update_status(self, client: AsyncClient):
        resp = await client.patch(
            "/api/action-items/1",
            json={"status": "complete"}
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "complete"

    @pytest.mark.asyncio
    async def test_update_owner(self, client: AsyncClient):
        resp = await client.patch(
            "/api/action-items/1",
            json={"owner_name": "Charlie", "owner_email": "charlie@example.com"}
        )
        assert resp.status_code == 200
        assert resp.json()["owner_name"] == "Charlie"

    @pytest.mark.asyncio
    async def test_update_due_date(self, client: AsyncClient):
        resp = await client.patch(
            "/api/action-items/1",
            json={"due_date": "2026-04-15"}
        )
        assert resp.status_code == 200
        assert resp.json()["due_date"] == "2026-04-15"

    @pytest.mark.asyncio
    async def test_update_description(self, client: AsyncClient):
        resp = await client.patch(
            "/api/action-items/1",
            json={"description": "Updated budget report description"}
        )
        assert resp.status_code == 200
        assert resp.json()["description"] == "Updated budget report description"

    @pytest.mark.asyncio
    async def test_update_not_found(self, client: AsyncClient):
        resp = await client.patch(
            "/api/action-items/999",
            json={"status": "complete"}
        )
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_update_invalid_status(self, client: AsyncClient):
        resp = await client.patch(
            "/api/action-items/1",
            json={"status": "invalid_status"}
        )
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# POST /api/action-items — create action item
# ---------------------------------------------------------------------------

class TestPostActionItem:
    """Tests for creating action items."""

    @pytest.mark.asyncio
    async def test_create_action_item(self, client: AsyncClient):
        resp = await client.post(
            "/api/action-items",
            json={
                "meeting_id": 1,
                "description": "Draft follow-up notes",
                "owner_name": "Test User",
                "owner_email": "test@example.com",
                "due_date": "2026-04-15",
                "status": "open",
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["meeting_id"] == 1
        assert data["description"] == "Draft follow-up notes"
        assert data["owner_name"] == "Test User"
        assert data["owner_email"] == "test@example.com"
        assert data["due_date"] == "2026-04-15"
        assert data["status"] == "open"

    @pytest.mark.asyncio
    async def test_create_action_item_other_users_meeting_not_found(
        self,
        client: AsyncClient,
        async_db: AsyncSession,
    ):
        other_user = User(
            email="other@example.com",
            name="Other User",
            azure_ad_id="other-azure-id-456",
            role="user",
        )
        async_db.add(other_user)
        await async_db.flush()

        other_meeting = Meeting(
            title="Private Planning",
            scheduled_time=datetime(2026, 3, 20, 9, 0),
            status=MeetingStatus.COMPLETE,
            audio_blob_url="audio/2026/03/20/private.wav",
            user_id=other_user.id,
        )
        async_db.add(other_meeting)
        await async_db.commit()

        resp = await client.post(
            "/api/action-items",
            json={
                "meeting_id": other_meeting.id,
                "description": "Should not be created",
            },
        )
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_create_action_item_invalid_status(self, client: AsyncClient):
        resp = await client.post(
            "/api/action-items",
            json={
                "meeting_id": 1,
                "description": "Draft follow-up notes",
                "status": "invalid_status",
            },
        )
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# DELETE /api/action-items/{id} — delete action item
# ---------------------------------------------------------------------------

class TestDeleteActionItem:
    """Tests for deleting action items."""

    @pytest.mark.asyncio
    async def test_delete_action_item(self, client: AsyncClient):
        resp = await client.delete("/api/action-items/1")
        assert resp.status_code == 204

    @pytest.mark.asyncio
    async def test_delete_action_item_not_found(self, client: AsyncClient):
        resp = await client.delete("/api/action-items/999")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_delete_other_users_action_item_not_found(
        self,
        client: AsyncClient,
        async_db: AsyncSession,
    ):
        other_user = User(
            email="other@example.com",
            name="Other User",
            azure_ad_id="other-azure-id-456",
            role="user",
        )
        async_db.add(other_user)
        await async_db.flush()

        other_meeting = Meeting(
            title="Private Planning",
            scheduled_time=datetime(2026, 3, 20, 9, 0),
            status=MeetingStatus.COMPLETE,
            audio_blob_url="audio/2026/03/20/private.wav",
            user_id=other_user.id,
        )
        async_db.add(other_meeting)
        await async_db.flush()

        other_action_item = ActionItem(
            meeting_id=other_meeting.id,
            description="Should not be deleted",
            status=ActionItemStatus.OPEN,
        )
        async_db.add(other_action_item)
        await async_db.commit()

        resp = await client.delete(f"/api/action-items/{other_action_item.id}")
        assert resp.status_code == 404
