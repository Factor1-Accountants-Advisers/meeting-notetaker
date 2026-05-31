"""Database connection and session management.

Supports both PostgreSQL (asyncpg) and SQLite (aiosqlite).
SQLite is the default for local development — no external services needed.
"""
import os
from sqlalchemy import text
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import declarative_base

from app.core.config import settings

# Ensure SQLite parent directory exists
if settings.database_url.startswith("sqlite"):
    # Extract path from sqlite+aiosqlite:///./data/meetings.db
    db_path = settings.database_url.split("///", 1)[-1]
    os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)

# Create async engine
engine = create_async_engine(
    settings.database_url,
    echo=True if settings.environment == "development" else False,
    future=True,
    # SQLite needs these for concurrent access from async context
    **({
        "connect_args": {"check_same_thread": False},
    } if settings.database_url.startswith("sqlite") else {}),
)

# Create async session factory
AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False
)

# Base class for models
Base = declarative_base()


def _sqlite_table_exists(connection: Connection, table_name: str) -> bool:
    return connection.execute(
        text("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = :name"),
        {"name": table_name},
    ).first() is not None


def _sqlite_column_names(connection: Connection, table_name: str) -> set[str]:
    if not _sqlite_table_exists(connection, table_name):
        return set()
    return {row[1] for row in connection.execute(text(f"PRAGMA table_info('{table_name}')"))}


def _sqlite_index_names(connection: Connection, table_name: str) -> set[str]:
    if not _sqlite_table_exists(connection, table_name):
        return set()
    return {row[1] for row in connection.execute(text(f"PRAGMA index_list('{table_name}')"))}


def _sqlite_add_column_if_missing(
    connection: Connection,
    table_name: str,
    column_name: str,
    ddl: str,
) -> None:
    if column_name not in _sqlite_column_names(connection, table_name):
        connection.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {ddl}"))


def _sqlite_create_index_if_missing(
    connection: Connection,
    table_name: str,
    index_name: str,
    ddl: str,
) -> None:
    if index_name not in _sqlite_index_names(connection, table_name):
        connection.execute(text(ddl))


def upgrade_sqlite_schema(connection: Connection) -> None:
    """Idempotently add columns/tables missing from existing desktop SQLite DBs.

    SQLAlchemy create_all() creates tables for new local databases, but it does
    not ALTER existing SQLite tables. Packaged desktop installs keep a persistent
    SQLite DB under AppData, so startup must reconcile additive schema changes
    from recent migrations before the newer app code queries those columns.
    """
    if _sqlite_table_exists(connection, "meetings"):
        _sqlite_add_column_if_missing(
            connection,
            "meetings",
            "needs_speaker_review",
            "needs_speaker_review BOOLEAN NOT NULL DEFAULT 0",
        )
        _sqlite_add_column_if_missing(
            connection,
            "meetings",
            "speaker_review_completed_at",
            "speaker_review_completed_at DATETIME",
        )
        _sqlite_add_column_if_missing(
            connection,
            "meetings",
            "speaker_mapping_quality",
            "speaker_mapping_quality FLOAT",
        )
        _sqlite_add_column_if_missing(
            connection,
            "meetings",
            "diarization_diagnostics",
            "diarization_diagnostics JSON",
        )
        _sqlite_create_index_if_missing(
            connection,
            "meetings",
            "ix_meetings_needs_speaker_review",
            "CREATE INDEX ix_meetings_needs_speaker_review ON meetings (needs_speaker_review)",
        )

    if _sqlite_table_exists(connection, "action_items"):
        _sqlite_add_column_if_missing(
            connection,
            "action_items",
            "owner_confidence",
            "owner_confidence FLOAT",
        )
        _sqlite_add_column_if_missing(
            connection,
            "action_items",
            "owner_source",
            "owner_source VARCHAR(32)",
        )
        _sqlite_add_column_if_missing(
            connection,
            "action_items",
            "owner_reason",
            "owner_reason TEXT",
        )
        _sqlite_create_index_if_missing(
            connection,
            "action_items",
            "ix_action_items_owner_source",
            "CREATE INDEX ix_action_items_owner_source ON action_items (owner_source)",
        )

    if not _sqlite_table_exists(connection, "speaker_mappings"):
        connection.execute(text("""
            CREATE TABLE speaker_mappings (
                id INTEGER NOT NULL PRIMARY KEY,
                meeting_id INTEGER NOT NULL,
                speaker_label VARCHAR(64) NOT NULL,
                display_name VARCHAR(255),
                mapped_email VARCHAR(255),
                confidence FLOAT,
                source VARCHAR(32) NOT NULL DEFAULT 'system',
                reason TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(meeting_id) REFERENCES meetings (id) ON DELETE CASCADE,
                CONSTRAINT uq_speaker_mappings_meeting_label UNIQUE (meeting_id, speaker_label)
            )
        """))

    if _sqlite_table_exists(connection, "speaker_mappings"):
        _sqlite_create_index_if_missing(
            connection,
            "speaker_mappings",
            "ix_speaker_mappings_meeting_id",
            "CREATE INDEX ix_speaker_mappings_meeting_id ON speaker_mappings (meeting_id)",
        )
        _sqlite_create_index_if_missing(
            connection,
            "speaker_mappings",
            "ix_speaker_mappings_source",
            "CREATE INDEX ix_speaker_mappings_source ON speaker_mappings (source)",
        )


async def create_tables():
    """Create all tables if they don't exist (used for SQLite dev mode)."""
    from app import models  # noqa: F401 — ensure models are imported
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        if settings.database_url.startswith("sqlite"):
            await conn.run_sync(upgrade_sqlite_schema)


async def get_db() -> AsyncSession:
    """Dependency for getting async database sessions."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()
