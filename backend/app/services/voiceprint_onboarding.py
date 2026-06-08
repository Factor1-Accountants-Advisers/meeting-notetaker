"""Voiceprint onboarding workflow.

Production default: raw samples are temporary. The onboarding flow writes the
uploaded bytes to a private temp file, sends that file to the voiceprint
provider, stores only the returned provider voiceprint ID plus consent metadata,
and deletes the temp file in a finally block.
"""
from __future__ import annotations

import re
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Protocol
from uuid import uuid4

from sqlalchemy.orm import Session

from app.models import User, Voiceprint
from app.services.voiceprint_registry import create_voiceprint_record


class VoiceprintOnboardingError(ValueError):
    """Raised when a voiceprint sample cannot be onboarded safely."""


class VoiceprintProvider(Protocol):
    """Provider contract for creating one voiceprint from a local sample."""

    def create_voiceprint(self, sample_path: Path, *, label: str) -> str:
        """Create a provider voiceprint and return its provider ID/value."""


_ALLOWED_CONTENT_TYPES = {
    "audio/wav",
    "audio/wave",
    "audio/x-wav",
    "audio/mpeg",
    "audio/mp3",
    "audio/mp4",
    "audio/m4a",
    "audio/x-m4a",
    "application/octet-stream",  # some desktop uploads omit a useful audio type
}
_ALLOWED_SUFFIXES = {".wav", ".mp3", ".m4a", ".mp4", ".aac", ".flac", ".ogg"}
_MAX_SAMPLE_BYTES = 25 * 1024 * 1024


def onboard_voiceprint_sample(
    db: Session,
    *,
    user: User,
    sample_bytes: bytes,
    original_filename: str,
    content_type: str | None,
    provider: VoiceprintProvider,
    consent_recorded_at: datetime | None,
    temp_dir: str | Path | None = None,
    sample_duration_seconds: float | None = None,
    sample_source: str | None = None,
) -> Voiceprint:
    """Create a provider voiceprint from sample bytes and persist registry row.

    The raw sample is never persisted in the registry. The temp file is deleted
    whether provider creation succeeds or fails.
    """
    if consent_recorded_at is None:
        raise VoiceprintOnboardingError("Consent must be recorded before creating a voiceprint")
    if not sample_bytes:
        raise VoiceprintOnboardingError("Voice sample is empty")
    if len(sample_bytes) > _MAX_SAMPLE_BYTES:
        raise VoiceprintOnboardingError("Voice sample is too large")

    suffix = _safe_suffix(original_filename)
    normalized_content_type = (content_type or "application/octet-stream").split(";", 1)[0].strip().lower()
    if normalized_content_type not in _ALLOWED_CONTENT_TYPES and suffix not in _ALLOWED_SUFFIXES:
        raise VoiceprintOnboardingError("Unsupported voice sample format")

    temp_path = _write_temp_sample(sample_bytes, suffix=suffix, temp_dir=temp_dir)
    try:
        provider_voiceprint_id = provider.create_voiceprint(
            temp_path,
            label=user.name,
        )
        return create_voiceprint_record(
            db,
            user=user,
            provider_voiceprint_id=provider_voiceprint_id,
            display_name=user.name,
            email=user.email,
            sample_duration_seconds=sample_duration_seconds,
            sample_source=sample_source,
            consent_recorded_at=consent_recorded_at,
            raw_sample_path=None,
            metadata_json={
                "original_filename": _safe_filename(original_filename),
                "content_type": normalized_content_type,
            },
        )
    finally:
        _delete_temp_sample(temp_path)


def _write_temp_sample(
    sample_bytes: bytes,
    *,
    suffix: str,
    temp_dir: str | Path | None,
) -> Path:
    directory = Path(temp_dir) if temp_dir else Path(tempfile.gettempdir())
    directory.mkdir(parents=True, exist_ok=True)
    temp_path = directory / f"voiceprint-sample-{uuid4().hex}{suffix}"
    temp_path.write_bytes(sample_bytes)
    return temp_path


def _delete_temp_sample(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        # Do not mask provider errors; callers can alert on temp cleanup separately
        # if we add structured logging/metrics here later.
        pass


def _safe_suffix(filename: str) -> str:
    suffix = Path(filename or "sample.wav").suffix.lower()
    return suffix if suffix in _ALLOWED_SUFFIXES else ".wav"


def _safe_filename(filename: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", filename or "sample")
    return cleaned[:120] or "sample"
