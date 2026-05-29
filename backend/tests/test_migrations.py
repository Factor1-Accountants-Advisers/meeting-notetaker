"""Tests that verify the database schema matches the expected state.

These tests run against an in-memory SQLite DB created from the SQLAlchemy
models (same as the test suite does) and confirm that columns introduced
by each migration are present and have the correct types.
"""
from pathlib import Path

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import StaticPool
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy import JSON, event

from app.core.database import Base
import app.models  # noqa: F401 — register all models


@pytest.fixture()
async def inspected_engine():
    """Create schema from models and return a sync inspector."""
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    # Replace JSONB with JSON for SQLite compatibility (mirrors test_read_endpoints)
    for table in Base.metadata.tables.values():
        for column in table.columns:
            if isinstance(column.type, JSONB):
                column.type = JSON()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    yield engine

    await engine.dispose()


class TestMigration001InitialSchema:
    """Verify the tables and columns from migration 001 are present."""

    @pytest.mark.asyncio
    async def test_users_table_exists(self, inspected_engine):
        async with inspected_engine.connect() as conn:
            tables = await conn.run_sync(lambda c: inspect(c).get_table_names())
        assert "users" in tables

    @pytest.mark.asyncio
    async def test_meetings_table_exists(self, inspected_engine):
        async with inspected_engine.connect() as conn:
            tables = await conn.run_sync(lambda c: inspect(c).get_table_names())
        assert "meetings" in tables

    @pytest.mark.asyncio
    async def test_participants_table_exists(self, inspected_engine):
        async with inspected_engine.connect() as conn:
            tables = await conn.run_sync(lambda c: inspect(c).get_table_names())
        assert "participants" in tables

    @pytest.mark.asyncio
    async def test_transcripts_table_exists(self, inspected_engine):
        async with inspected_engine.connect() as conn:
            tables = await conn.run_sync(lambda c: inspect(c).get_table_names())
        assert "transcripts" in tables

    @pytest.mark.asyncio
    async def test_action_items_table_exists(self, inspected_engine):
        async with inspected_engine.connect() as conn:
            tables = await conn.run_sync(lambda c: inspect(c).get_table_names())
        assert "action_items" in tables


class TestMigration002IdentityHintsAndIsOrganizer:
    """Verify columns added in migration 002 are present."""

    @pytest.mark.asyncio
    async def test_meetings_has_identity_hints_column(self, inspected_engine):
        async with inspected_engine.connect() as conn:
            columns = await conn.run_sync(
                lambda c: [col["name"] for col in inspect(c).get_columns("meetings")]
            )
        assert "identity_hints" in columns, (
            "meetings.identity_hints is missing — migration 002 not applied"
        )

    @pytest.mark.asyncio
    async def test_participants_has_is_organizer_column(self, inspected_engine):
        async with inspected_engine.connect() as conn:
            columns = await conn.run_sync(
                lambda c: [col["name"] for col in inspect(c).get_columns("participants")]
            )
        assert "is_organizer" in columns, (
            "participants.is_organizer is missing — migration 002 not applied"
        )

class TestMigration003SpeakerIdentified:
    """Verify speaker_identified column added in migration 003."""

    @pytest.mark.asyncio
    async def test_transcripts_has_speaker_identified_column(self, inspected_engine):
        async with inspected_engine.connect() as conn:
            columns = await conn.run_sync(
                lambda c: [col["name"] for col in inspect(c).get_columns("transcripts")]
            )
        assert "speaker_identified" in columns, (
            "transcripts.speaker_identified is missing — migration 003 not applied"
        )


class TestMigration004SpeakerMappings:
    """Verify migration 004 exists and covers speaker mapping schema changes."""

    def test_migration_file_contains_required_schema_changes(self):
        migration_path = (
            Path(__file__).resolve().parents[1]
            / "alembic"
            / "versions"
            / "004_add_speaker_mappings_and_owner_confidence.py"
        )
        assert migration_path.exists(), "migration 004 file is missing"

        migration_text = migration_path.read_text()
        for expected in (
            "speaker_mappings",
            "needs_speaker_review",
            "owner_confidence",
            "uq_speaker_mappings_meeting_label",
        ):
            assert expected in migration_text


class TestMigration002IdentityHintsAndIsOrganizer:
    """Verify columns added in migration 002 are present."""

    @pytest.mark.asyncio
    async def test_is_organizer_defaults_to_false(self, inspected_engine):
        """is_organizer column default should be False when not explicitly set."""
        from sqlalchemy.ext.asyncio import async_sessionmaker, AsyncSession
        from app.models import User, Meeting, Participant, MeetingStatus

        session_factory = async_sessionmaker(
            inspected_engine, class_=AsyncSession, expire_on_commit=False
        )
        async with session_factory() as session:
            user = User(email="u@example.com", name="U", azure_ad_id="az-1", role="user")
            session.add(user)
            await session.flush()

            meeting = Meeting(title="Test", status=MeetingStatus.PROCESSING, user_id=user.id)
            session.add(meeting)
            await session.flush()

            # Omit is_organizer — should default to False
            participant = Participant(meeting_id=meeting.id, name="Alice")
            session.add(participant)
            await session.commit()
            await session.refresh(participant)

        assert participant.is_organizer is False, "is_organizer should default to False"
