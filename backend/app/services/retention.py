"""Raw-audio retention (requirements §6.2): delete stored audio after 30 days.

In production this is an Azure Blob lifecycle policy; this job is the local
stand-in and the safety net. Transcripts/summaries/action items are kept per
records policy — only audio is touched.
"""

import asyncio
import logging
import time

from app import store
from app.config import get_settings
from app.paths import audio_dir

logger = logging.getLogger(__name__)

SWEEP_INTERVAL_S = 60 * 60  # hourly


def sweep_once() -> int:
    """Delete audio files older than the retention window. Returns count."""
    settings = get_settings()
    cutoff = time.time() - settings.audio_retention_days * 24 * 3600
    deleted = 0
    if not audio_dir().exists():
        return 0
    for path in audio_dir().iterdir():
        if path.is_file() and path.stat().st_mtime < cutoff:
            path.unlink(missing_ok=True)
            deleted += 1
            store.add_audit(
                "system",
                "audio.retention_delete",
                path.name,
                after=f"deleted after {settings.audio_retention_days} days",
            )
    if deleted:
        store.save_snapshot()
        logger.info("retention sweep deleted %d audio file(s)", deleted)
    return deleted


async def retention_loop() -> None:
    while True:
        try:
            sweep_once()
        except Exception:
            logger.exception("retention sweep failed")
        await asyncio.sleep(SWEEP_INTERVAL_S)
