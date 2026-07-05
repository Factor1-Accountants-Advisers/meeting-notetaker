"""Recorder-track sanity checks.

A microphone stream can record digital silence without any capture error
(observed live: Bluetooth hands-free / exclusive-mode contention while a Teams
call holds the mic). The renderer warns during recording; this backend check
stamps the meeting at upload so a silent-recorder transcript says so instead of
quietly omitting the recorder's speech.
"""

from __future__ import annotations

import logging
import re
import shutil
import subprocess
from pathlib import Path

logger = logging.getLogger("notetaker.audio_checks")

# Encoded digital silence peaks around -91 dB; real speech peaks far above -60.
# The renderer's live twin of this check is SILENCE_RMS in
# src/renderer/src/lib/capture.ts (windowed RMS, different unit) — keep the two
# in mind together when tuning either.
SILENT_MAX_VOLUME_DB = -80.0

_MAX_VOLUME_RE = re.compile(r"max_volume:\s*(-?[\d.]+)\s*dB")


def parse_max_volume_db(ffmpeg_output: str) -> float | None:
    match = _MAX_VOLUME_RE.search(ffmpeg_output)
    return float(match.group(1)) if match else None


def max_volume_db(path: Path) -> float | None:
    """Peak volume of an audio file via ffmpeg volumedetect; None if unmeasurable."""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None or not path.exists():
        return None
    try:
        proc = subprocess.run(
            [ffmpeg, "-hide_banner", "-i", str(path), "-af", "volumedetect", "-f", "null", "-"],
            capture_output=True,
            text=True,
            # Full-file decode; callers run this in the background pipeline, so
            # a long recording may legitimately take minutes.
            timeout=300,
        )
    except (OSError, subprocess.TimeoutExpired):
        logger.warning("volumedetect failed for %s", path.name)
        return None
    return parse_max_volume_db(proc.stderr or "")


def is_silent(path: Path) -> bool | None:
    """True/False when measurable, None when ffmpeg or the file is unavailable."""
    peak = max_volume_db(path)
    if peak is None:
        return None
    return peak < SILENT_MAX_VOLUME_DB
