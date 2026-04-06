"""Database connection and session management.

Supports both PostgreSQL (asyncpg) and SQLite (aiosqlite).
SQLite is the default for local development — no external services needed.
"""
import os
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


async def create_tables():
    """Create all tables if they don't exist (used for SQLite dev mode)."""
    from app import models  # noqa: F401 — ensure models are imported
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


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
