from fastapi import APIRouter

from app.config import get_settings

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict[str, str]:
    settings = get_settings()
    # app_version is the supervisor's adoption handshake (IN-484): a stale
    # orphaned backend reports the wrong (or no) version and gets replaced
    # instead of adopted.
    return {
        "status": "ok",
        "environment": settings.environment,
        "app_version": settings.app_version,
    }
