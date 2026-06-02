"""Regression tests for idempotent SQLite schema upgrades on existing desktop DBs."""

import sqlalchemy as sa
from sqlalchemy import inspect

from app.core.database import upgrade_sqlite_schema


def test_upgrade_sqlite_schema_adds_review_columns_to_existing_desktop_db():
    engine = sa.create_engine("sqlite:///:memory:")
    metadata = sa.MetaData()
    sa.Table("meetings", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    sa.Table("action_items", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    metadata.create_all(engine)

    with engine.begin() as connection:
        upgrade_sqlite_schema(connection)
        inspector = inspect(connection)

        meeting_columns = {column["name"] for column in inspector.get_columns("meetings")}
        action_item_columns = {column["name"] for column in inspector.get_columns("action_items")}

        assert "speaker_mappings" in inspector.get_table_names()
        assert {
            "processing_error",
            "needs_speaker_review",
            "speaker_review_completed_at",
            "speaker_mapping_quality",
            "diarization_diagnostics",
        }.issubset(meeting_columns)
        assert {"owner_confidence", "owner_source", "owner_reason"}.issubset(action_item_columns)

        # Idempotent: startup can run this on every app launch.
        upgrade_sqlite_schema(connection)
