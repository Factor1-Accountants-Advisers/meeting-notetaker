"""FastAPI application entry point."""
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan events for startup and shutdown."""
    # Startup: Initialize resources
    # (Database connection is handled by SQLAlchemy's pool)
    yield
    # Shutdown: Clean up resources
    # (Database connections are automatically closed by SQLAlchemy)


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
from app.routers import users, meetings, action_items
app.include_router(users.router)
app.include_router(meetings.router)
app.include_router(action_items.router)


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
