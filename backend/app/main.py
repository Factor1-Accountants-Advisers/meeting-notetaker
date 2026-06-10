from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.routers import action_items, health, meetings, people


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Meeting Notetaker API",
        version="0.1.0",
        docs_url="/docs" if settings.environment == "dev" else None,
    )

    # Electron renderer origin in dev (Vite). Tighten for production packaging.
    if settings.environment == "dev":
        app.add_middleware(
            CORSMiddleware,
            allow_origins=["http://localhost:5173"],
            allow_methods=["*"],
            allow_headers=["*"],
        )

    app.include_router(health.router)
    app.include_router(meetings.router, prefix=settings.api_v1_prefix)
    app.include_router(action_items.router, prefix=settings.api_v1_prefix)
    app.include_router(people.router, prefix=settings.api_v1_prefix)
    return app


app = create_app()
