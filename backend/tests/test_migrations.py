"""Tests that verify the database schema matches the expected state.

These tests run against an in-memory SQLite DB created from the SQLAlchemy
models (same as the test suite does) and confirm that columns introduced
by each migration are present and have the correct types.
"""
import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
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
    """Execute migration 004 against SQLite and verify its schema changes."""

    def test_upgrade_and_downgrade_on_sqlite(self):
        migration_path = (
            Path(__file__).resolve().parents[1]
            / "alembic"
            / "versions"
            / "004_add_speaker_mappings_and_owner_confidence.py"
        )
        assert migration_path.exists(), "migration 004 file is missing"

        spec = importlib.util.spec_from_file_location("migration_004", migration_path)
        assert spec is not None and spec.loader is not None
        migration = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(migration)

        engine = sa.create_engine("sqlite:///:memory:")
        metadata = sa.MetaData()
        sa.Table("meetings", metadata, sa.Column("id", sa.Integer(), primary_key=True))
        sa.Table("action_items", metadata, sa.Column("id", sa.Integer(), primary_key=True))
        metadata.create_all(engine)

        def run_migration(connection, function_name):
            context = MigrationContext.configure(connection)
            operations = Operations(context)
            original_op = getattr(migration, "op")
            setattr(migration, "op", operations)
            try:
                getattr(migration, function_name)()
            finally:
                setattr(migration, "op", original_op)

        def unique_index_column_sets(connection, table_name):
            unique_columns = []
            for row in connection.execute(text(f"PRAGMA index_list('{table_name}')")):
                # row fields: seq, name, unique, origin, partial
                if not row[2]:
                    continue
                columns = [
                    index_info[2]
                    for index_info in connection.execute(text(f"PRAGMA index_info('{row[1]}')"))
                ]
                unique_columns.append(columns)
            return unique_columns

        with engine.begin() as connection:
            run_migration(connection, "upgrade")

            inspector = inspect(connection)
            assert "speaker_mappings" in inspector.get_table_names()

            speaker_columns = {
                column["name"]: column
                for column in inspector.get_columns("speaker_mappings")
            }
            for column_name in ("created_at", "updated_at"):
                default = str(speaker_columns[column_name].get("default") or "").upper()
                assert "CURRENT_TIMESTAMP" in default
                assert "NOW()" not in default

            connection.execute(text("INSERT INTO meetings (id) VALUES (1)"))
            connection.execute(
                text(
                    "INSERT INTO speaker_mappings "
                    "(meeting_id, speaker_label, source) "
                    "VALUES (1, 'Speaker A', 'manual')"
                )
            )
            default_values = connection.execute(
                text(
                    "SELECT created_at, updated_at "
                    "FROM speaker_mappings "
                    "WHERE meeting_id = 1 AND speaker_label = 'Speaker A'"
                )
            ).one()
            assert default_values.created_at is not None
            assert default_values.updated_at is not None

            meeting_indexes = {index["name"] for index in inspector.get_indexes("meetings")}
            action_item_indexes = {
                index["name"] for index in inspector.get_indexes("action_items")
            }
            speaker_indexes = {
                index["name"] for index in inspector.get_indexes("speaker_mappings")
            }
            assert "ix_meetings_needs_speaker_review" in meeting_indexes
            assert "ix_action_items_owner_source" in action_item_indexes
            assert "ix_speaker_mappings_meeting_id" in speaker_indexes
            assert "ix_speaker_mappings_source" in speaker_indexes

            unique_constraints = inspector.get_unique_constraints("speaker_mappings")
            unique_column_sets = [
                constraint["column_names"] for constraint in unique_constraints
            ] + unique_index_column_sets(connection, "speaker_mappings")
            assert ["meeting_id", "speaker_label"] in unique_column_sets

            run_migration(connection, "downgrade")

            inspector = inspect(connection)
            assert "speaker_mappings" not in inspector.get_table_names()
            assert "owner_source" not in {
                column["name"] for column in inspector.get_columns("action_items")
            }
            assert "needs_speaker_review" not in {
                column["name"] for column in inspector.get_columns("meetings")
            }


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
