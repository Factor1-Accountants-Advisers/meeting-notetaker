"""Route tests for meeting speaker mapping endpoints."""
from datetime import datetime

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import JSON
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.api.dependencies import get_current_user
from app.core.database import Base, get_db
from app.main import app
from app.models import (
    ActionItem,
    ActionItemStatus,
    ActionOwnerSource,
    Meeting,
    MeetingStatus,
    Participant,
    SpeakerMapping,
    SpeakerMappingSource,
    Transcript,
    User,
)

TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"


@pytest.fixture()
async def async_db():
    """Create an async in-memory SQLite database for route tests."""
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
    """Seed users, owned/foreign meetings, transcripts, mappings, and actions."""
    user = User(
        id=1,
        email="owner@example.com",
        name="Owner User",
        azure_ad_id="owner-azure-id",
        role="user",
    )
    other_user = User(
        id=2,
        email="other@example.com",
        name="Other User",
        azure_ad_id="other-azure-id",
        role="user",
    )
    async_db.add_all([user, other_user])
    await async_db.flush()

    meeting = Meeting(
        id=1,
        title="Speaker Mapping Sync",
        scheduled_time=datetime(2026, 5, 1, 10, 0),
        status=MeetingStatus.COMPLETE,
        user_id=user.id,
        needs_speaker_review=True,
        speaker_mapping_quality=0.55,
        identity_hints={
            "current_user": {"name": "Owner User", "email": "owner@example.com"}
        },
    )
    other_meeting = Meeting(
        id=2,
        title="Private Other Meeting",
        scheduled_time=datetime(2026, 5, 1, 11, 0),
        status=MeetingStatus.COMPLETE,
        user_id=other_user.id,
    )
    async_db.add_all([meeting, other_meeting])
    await async_db.flush()

    async_db.add_all(
        [
            Participant(
                meeting_id=meeting.id,
                name="Alice Nguyen",
                email="alice@example.com",
            ),
            Participant(
                meeting_id=meeting.id,
                name="Bob Smith",
                email="bob@example.com",
            ),
        ]
    )

    transcript = Transcript(
        meeting_id=meeting.id,
        full_text="Speaker A: Prepare the report. Speaker B: I will review it.",
        segments=[
            {
                "speaker": "Speaker A",
                "start": 0.0,
                "end": 2.0,
                "text": "Prepare the report.",
            },
            {
                "speaker": "Speaker B",
                "start": 2.0,
                "end": 4.0,
                "text": "I will review it.",
            },
        ],
    )
    mapping = SpeakerMapping(
        meeting_id=meeting.id,
        speaker_label="Speaker A",
        display_name="Alice Nguyen",
        email="alice@example.com",
        confidence=0.55,
        source=SpeakerMappingSource.LLM_INFERENCE,
        reason="Initial inference",
    )
    action_item = ActionItem(
        meeting_id=meeting.id,
        description="Prepare the report",
        owner_name="Speaker A",
        status=ActionItemStatus.OPEN,
    )
    user_corrected_action = ActionItem(
        meeting_id=meeting.id,
        description="Human-assigned task",
        owner_name="Human Choice",
        owner_email="human@example.com",
        owner_confidence=1.0,
        owner_source=ActionOwnerSource.USER_CORRECTED,
        owner_reason="User set this owner manually",
        status=ActionItemStatus.OPEN,
    )
    async_db.add_all([transcript, mapping, action_item, user_corrected_action])
    await async_db.commit()

    return {
        "user": user,
        "meeting": meeting,
        "other_meeting": other_meeting,
        "action_item": action_item,
        "user_corrected_action": user_corrected_action,
    }


@pytest.fixture()
async def client(async_db: AsyncSession, seed_data):
    """Create an async test client with auth/db dependency overrides."""
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


@pytest.mark.asyncio
async def test_get_speaker_mappings_for_owned_meeting_returns_mappings_and_quality_fields(
    client: AsyncClient,
):
    resp = await client.get("/api/meetings/1/speaker-mappings")

    assert resp.status_code == 200
    data = resp.json()
    assert data["needs_speaker_review"] is True
    assert data["speaker_mapping_quality"] == 0.55
    assert len(data["items"]) == 1
    item = data["items"][0]
    assert item["speaker_label"] == "Speaker A"
    assert item["display_name"] == "Alice Nguyen"
    assert item["email"] == "alice@example.com"
    assert item["confidence"] == 0.55
    assert item["source"] == "llm_inference"


@pytest.mark.asyncio
async def test_get_speaker_mappings_for_another_users_meeting_returns_404(
    client: AsyncClient,
):
    resp = await client.get("/api/meetings/2/speaker-mappings")

    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_put_user_corrected_mapping_creates_and_updates_mapping(
    client: AsyncClient,
):
    resp = await client.put(
        "/api/meetings/1/speaker-mappings",
        json=[
            {
                "speaker_label": "Speaker A",
                "display_name": "Alicia Nguyen",
                "email": "alicia@example.com",
                "confidence": 0.99,
                "reason": "User corrected Alice's display name",
            },
            {
                "speaker_label": "Speaker B",
                "display_name": "Bob Smith",
                "email": "bob@example.com",
                "confidence": 1.0,
            },
        ],
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["needs_speaker_review"] is False
    assert data["speaker_mapping_quality"] == pytest.approx(0.995)
    by_label = {item["speaker_label"]: item for item in data["items"]}
    assert by_label["Speaker A"]["display_name"] == "Alicia Nguyen"
    assert by_label["Speaker A"]["source"] == "user_corrected"
    assert by_label["Speaker B"]["display_name"] == "Bob Smith"
    assert by_label["Speaker B"]["source"] == "user_corrected"


@pytest.mark.asyncio
async def test_put_rejects_speaker_label_not_present_in_transcript(
    client: AsyncClient,
):
    resp = await client.put(
        "/api/meetings/1/speaker-mappings",
        json=[
            {
                "speaker_label": "Speaker Z",
                "display_name": "Zed Example",
                "email": "zed@example.com",
                "confidence": 1.0,
            }
        ],
    )

    assert resp.status_code == 422
    assert "not present in transcript" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_put_triggers_action_owner_reresolution(
    client: AsyncClient,
):
    resp = await client.put(
        "/api/meetings/1/speaker-mappings",
        json=[
            {
                "speaker_label": "Speaker A",
                "display_name": "Alice Resolved",
                "email": "alice.resolved@example.com",
                "confidence": 1.0,
            }
        ],
    )
    assert resp.status_code == 200

    action_resp = await client.get("/api/meetings/1/action-items")
    assert action_resp.status_code == 200
    actions = {item["description"]: item for item in action_resp.json()}
    resolved = actions["Prepare the report"]
    assert resolved["owner_name"] == "Alice Resolved"
    assert resolved["owner_email"] == "alice.resolved@example.com"
    assert resolved["owner_source"] == "speaker_mapping"
    assert resolved["owner_reason"].startswith("speaker_label=Speaker A;")

    preserved = actions["Human-assigned task"]
    assert preserved["owner_name"] == "Human Choice"
    assert preserved["owner_email"] == "human@example.com"
    assert preserved["owner_source"] == "user_corrected"


@pytest.mark.asyncio
async def test_post_resolve_action_owners_returns_updated_action_items(
    client: AsyncClient,
):
    put_resp = await client.put(
        "/api/meetings/1/speaker-mappings",
        json=[
            {
                "speaker_label": "Speaker A",
                "display_name": "Alice Resolved",
                "email": "alice.resolved@example.com",
                "confidence": 1.0,
            }
        ],
    )
    assert put_resp.status_code == 200

    resp = await client.post("/api/meetings/1/resolve-action-owners")

    assert resp.status_code == 200
    actions = {item["description"]: item for item in resp.json()}
    assert actions["Prepare the report"]["owner_name"] == "Alice Resolved"
    assert actions["Prepare the report"]["owner_source"] == "speaker_mapping"
    assert actions["Human-assigned task"]["owner_name"] == "Human Choice"
    assert actions["Human-assigned task"]["owner_source"] == "user_corrected"
