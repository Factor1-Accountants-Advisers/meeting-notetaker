"""Tests for voiceprint onboarding sample handling."""
from datetime import datetime
from pathlib import Path

import pytest

from app.models import Voiceprint
from app.services.voiceprint_onboarding import (
    VoiceprintOnboardingError,
    onboard_voiceprint_sample,
)


class FakeVoiceprintProvider:
    def __init__(self, provider_voiceprint_id="vp_created", should_fail=False):
        self.provider_voiceprint_id = provider_voiceprint_id
        self.should_fail = should_fail
        self.seen_paths: list[Path] = []

    def create_voiceprint(self, sample_path: Path, *, label: str) -> str:
        self.seen_paths.append(sample_path)
        assert sample_path.exists()
        assert label
        if self.should_fail:
            raise RuntimeError("provider failed")
        return self.provider_voiceprint_id


def test_onboard_voiceprint_sample_deletes_temp_audio_and_stores_only_provider_id(db_session, test_user, tmp_path):
    provider = FakeVoiceprintProvider("vp_joseph_new")
    sample_bytes = b"fake-wav-bytes"

    voiceprint = onboard_voiceprint_sample(
        db_session,
        user=test_user,
        sample_bytes=sample_bytes,
        original_filename="joseph.wav",
        content_type="audio/wav",
        provider=provider,
        consent_recorded_at=datetime(2026, 6, 8, 8, 0, 0),
        temp_dir=tmp_path,
        sample_duration_seconds=20.67,
        sample_source="desktop_recorder",
    )

    assert voiceprint.provider_voiceprint_id == "vp_joseph_new"
    assert voiceprint.raw_sample_path is None
    assert voiceprint.sample_duration_seconds == 20.67
    assert voiceprint.sample_source == "desktop_recorder"
    assert voiceprint.consent_recorded_at is not None
    assert provider.seen_paths
    assert all(not path.exists() for path in provider.seen_paths)
    assert list(tmp_path.iterdir()) == []

    stored = db_session.query(Voiceprint).filter_by(provider_voiceprint_id="vp_joseph_new").one()
    assert stored.id == voiceprint.id


def test_onboard_voiceprint_sample_requires_consent(db_session, test_user, tmp_path):
    provider = FakeVoiceprintProvider()

    with pytest.raises(VoiceprintOnboardingError, match="Consent must be recorded"):
        onboard_voiceprint_sample(
            db_session,
            user=test_user,
            sample_bytes=b"fake-wav-bytes",
            original_filename="joseph.wav",
            content_type="audio/wav",
            provider=provider,
            consent_recorded_at=None,
            temp_dir=tmp_path,
        )

    assert db_session.query(Voiceprint).count() == 0
    assert provider.seen_paths == []


def test_onboard_voiceprint_sample_cleans_temp_audio_when_provider_fails(db_session, test_user, tmp_path):
    provider = FakeVoiceprintProvider(should_fail=True)

    with pytest.raises(RuntimeError, match="provider failed"):
        onboard_voiceprint_sample(
            db_session,
            user=test_user,
            sample_bytes=b"fake-wav-bytes",
            original_filename="joseph.wav",
            content_type="audio/wav",
            provider=provider,
            consent_recorded_at=datetime.utcnow(),
            temp_dir=tmp_path,
        )

    assert provider.seen_paths
    assert all(not path.exists() for path in provider.seen_paths)
    assert list(tmp_path.iterdir()) == []
    assert db_session.query(Voiceprint).count() == 0
