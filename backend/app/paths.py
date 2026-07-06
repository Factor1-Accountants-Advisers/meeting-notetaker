"""Data path resolver.

All call sites that need filesystem paths for audio, snapshots, voiceprints,
or the local SharePoint stand-in must go through this module.  When
``MN_DATA_DIR`` is set (packaged builds), every path derives from it.  When
unset (dev / WSL loop), the repo-relative ``backend/var/`` directory is used
so existing dev data and workflows are untouched.
"""

from pathlib import Path

from app.config import get_settings


def data_root() -> Path:
    """Top-level data directory (``backend/var`` or ``MN_DATA_DIR``)."""
    configured = get_settings().data_dir
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parents[1] / "var"


def audio_dir() -> Path:
    """Directory for raw meeting audio files."""
    return data_root() / "audio"


def snapshot_path() -> Path:
    """Path to the JSON snapshot (in-memory store persistence)."""
    return data_root() / "store.json"


def voiceprint_path() -> Path:
    """Path to the voiceprint registry JSON."""
    return data_root() / "voiceprints.json"


def local_sharepoint_dir() -> Path:
    """Directory for the local SharePoint stand-in (unconfigured drive id)."""
    return data_root() / "sharepoint"
