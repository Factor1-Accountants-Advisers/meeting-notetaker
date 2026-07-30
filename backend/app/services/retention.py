"""Raw-audio retention (requirements §6.2): delete stored audio after 30 days.

In production this is an Azure Blob lifecycle policy; this job is the local
stand-in and the safety net. Transcripts/summaries/action items are kept per
records policy — only audio is touched.
"""

import asyncio
import logging
import time
from pathlib import Path
from uuid import UUID

from app import store
from app.config import get_settings
from app.paths import audio_dir
from app.schemas import PipelineStatus

logger = logging.getLogger(__name__)

SWEEP_INTERVAL_S = 60 * 60  # hourly


def _meeting_id_for_audio(path: Path) -> UUID | None:
    """Return the meeting UUID encoded by the canonical audio filename."""
    try:
        return UUID(path.name.partition(".")[0])
    except ValueError:
        return None


def sweep_once() -> int:
    """Delete old audio only after its meeting is ready. Returns count.

    Failed and in-flight meetings keep their retry source regardless of file
    age. Unknown filenames are also retained because there is no meeting state
    proving that they are safe to remove.
    """
    settings = get_settings()
    cutoff = time.time() - settings.audio_retention_days * 24 * 3600
    deleted = 0
    if not audio_dir().exists():
        return 0
    for path in audio_dir().iterdir():
        if not path.is_file() or path.stat().st_mtime >= cutoff:
            continue
        meeting_id = _meeting_id_for_audio(path)
        meeting = store.MEETINGS.get(meeting_id) if meeting_id is not None else None
        if meeting is None or meeting.pipeline_status is not PipelineStatus.ready:
            continue
        path.unlink(missing_ok=True)
        deleted += 1
        store.add_audit(
            "system",
            "audio.retention_delete",
            path.name,
            after=f"deleted after {settings.audio_retention_days} days",
            meeting_id=meeting_id,
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
