import asyncio
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from app import store
from app.config import get_settings
from app.routers import action_items, health, meetings, people, search
from app.services.pipeline import reconcile_interrupted_pipelines
from app.services.retention import retention_loop


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    reconcile_interrupted_pipelines()
    task = asyncio.create_task(retention_loop())
    yield
    task.cancel()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Meeting Notetaker API",
        version="0.1.0",
        docs_url="/docs" if settings.environment == "dev" else None,
        lifespan=lifespan,
    )

    # Electron renderer origin in dev (Vite). Tighten for production packaging.
    if settings.environment == "dev":
        app.add_middleware(
            CORSMiddleware,
            allow_origins=["http://localhost:5173"],
            allow_methods=["*"],
            allow_headers=["*"],
        )

    @app.middleware("http")
    async def snapshot_after_mutation(request: Request, call_next) -> Response:  # type: ignore[no-untyped-def]
        response = await call_next(request)
        # Persist store state after any successful mutation (Postgres stand-in).
        if request.method != "GET" and response.status_code < 400:
            store.save_snapshot()
        return response

    app.include_router(health.router)
    app.include_router(meetings.router, prefix=settings.api_v1_prefix)
    app.include_router(action_items.router, prefix=settings.api_v1_prefix)
    app.include_router(people.router, prefix=settings.api_v1_prefix)
    app.include_router(search.router, prefix=settings.api_v1_prefix)
    return app


app = create_app()
