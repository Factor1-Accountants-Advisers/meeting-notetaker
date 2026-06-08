"""FastAPI application entry point."""
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.core.config import settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan events for startup and shutdown."""
    # Startup: auto-create tables for SQLite (no Alembic needed in dev)
    if settings.database_url.startswith("sqlite"):
        from app.core.database import create_tables
        await create_tables()
    yield


# Create FastAPI app
app = FastAPI(
    title="Meeting Note-Taker API",
    description="AI-powered meeting transcription and summarisation API",
    version="1.0.0",
    lifespan=lifespan,
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if settings.environment == "development" else [],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
from app.routers import users, meetings, action_items, voiceprints
app.include_router(users.router)
app.include_router(meetings.router)
app.include_router(action_items.router)
app.include_router(voiceprints.router)


# Serve local audio files when using LocalFileStorage
_storage_mode = (settings.storage_backend or "").lower()
if _storage_mode != "minio" and not settings.azure_storage_connection_string:
    _audio_dir = os.path.abspath(
        settings.local_storage_dir or os.path.join(os.getcwd(), "data", "audio")
    )
    os.makedirs(_audio_dir, exist_ok=True)
    app.mount("/api/audio", StaticFiles(directory=_audio_dir), name="audio-files")


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "environment": settings.environment,
        "version": "1.0.0"
    }


@app.get("/")
async def root():
    """Root endpoint."""
    return {
        "message": "Meeting Note-Taker API",
        "docs": "/docs",
        "health": "/health"
    }
