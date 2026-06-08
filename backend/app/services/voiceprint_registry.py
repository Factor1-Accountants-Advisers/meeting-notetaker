"""Central voiceprint registry service.

This service stores provider voiceprint identifiers and consent/quality metadata.
It intentionally does not require or retain raw voice sample paths; raw audio
should be temporary unless a future retention policy explicitly allows it.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Iterable

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models import Meeting, User, Voiceprint, VoiceprintStatus


def normalize_email(email: str | None) -> str | None:
    """Normalize email for dedupe/lookups."""
    if not email:
        return None
    normalized = email.strip().lower()
    return normalized or None


def create_voiceprint_record(
    db: Session,
    *,
    user: User,
    provider_voiceprint_id: str,
    display_name: str,
    email: str | None = None,
    provider: str = "pyannote",
    sample_duration_seconds: float | None = None,
    sample_source: str | None = None,
    consent_recorded_at: datetime | None = None,
    metadata_json: dict[str, Any] | None = None,
    raw_sample_path: str | None = None,
) -> Voiceprint:
    """Create a voiceprint registry record.

    `raw_sample_path` exists only for explicit future retention/debug policies.
    Normal self-service onboarding should leave it as None after provider
    voiceprint creation succeeds.
    """
    voiceprint = Voiceprint(
        user_id=user.id,
        provider=provider,
        provider_voiceprint_id=provider_voiceprint_id,
        display_name=display_name.strip(),
        email=normalize_email(email) or normalize_email(user.email),
        status=VoiceprintStatus.ACTIVE,
        consent_recorded_at=consent_recorded_at,
        raw_sample_path=raw_sample_path,
        sample_duration_seconds=sample_duration_seconds,
        sample_source=sample_source,
        metadata_json=metadata_json,
    )
    db.add(voiceprint)
    db.commit()
    db.refresh(voiceprint)
    return voiceprint


def disable_voiceprint(
    db: Session,
    voiceprint: Voiceprint,
    *,
    reason: str | None = None,
) -> Voiceprint:
    """Disable a voiceprint without deleting the audit row."""
    voiceprint.status = VoiceprintStatus.DISABLED
    voiceprint.disabled_reason = reason
    voiceprint.updated_at = datetime.utcnow()
    db.add(voiceprint)
    db.commit()
    db.refresh(voiceprint)
    return voiceprint


def mark_voiceprint_deleted(
    db: Session,
    voiceprint: Voiceprint,
    *,
    reason: str | None = None,
) -> Voiceprint:
    """Soft-delete a voiceprint after provider-side deletion/revocation."""
    now = datetime.utcnow()
    voiceprint.status = VoiceprintStatus.DELETED
    voiceprint.disabled_reason = reason
    voiceprint.deleted_at = now
    voiceprint.updated_at = now
    db.add(voiceprint)
    db.commit()
    db.refresh(voiceprint)
    return voiceprint


def list_active_voiceprints(db: Session) -> list[Voiceprint]:
    """Return active consented voiceprints available for identification."""
    return (
        db.query(Voiceprint)
        .filter(Voiceprint.status == VoiceprintStatus.ACTIVE)
        .filter(Voiceprint.consent_recorded_at.isnot(None))
        .filter(Voiceprint.deleted_at.is_(None))
        .order_by(Voiceprint.id.asc())
        .all()
    )


def _meeting_candidate_emails(meeting: Meeting) -> list[str]:
    """Collect candidate emails from recorder/current user, organizer, attendees."""
    emails: list[str] = []

    if meeting.user and meeting.user.email:
        emails.append(meeting.user.email)

    hints = meeting.identity_hints or {}
    for key in ("current_user", "organizer"):
        value = hints.get(key)
        if isinstance(value, dict):
            emails.append(value.get("email"))

    for participant in meeting.participants or []:
        emails.append(participant.email)

    return _dedupe_emails(emails)


def _dedupe_emails(emails: Iterable[str | None]) -> list[str]:
    seen: set[str] = set()
    deduped: list[str] = []
    for email in emails:
        normalized = normalize_email(email)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(normalized)
    return deduped


def select_voiceprint_candidates_for_meeting(
    db: Session,
    meeting: Meeting,
    *,
    fallback_to_all_active: bool = False,
) -> list[Voiceprint]:
    """Select candidate voiceprints for one meeting.

    Prefer meeting-scoped participant/organizer/current-user voiceprints to
    avoid firm-wide false positives. When no meeting emails are available,
    callers may explicitly opt into all active voiceprints for fallback tests.
    """
    candidate_emails = _meeting_candidate_emails(meeting)
    if not candidate_emails:
        return list_active_voiceprints(db) if fallback_to_all_active else []

    candidates = (
        db.query(Voiceprint)
        .filter(Voiceprint.status == VoiceprintStatus.ACTIVE)
        .filter(Voiceprint.consent_recorded_at.isnot(None))
        .filter(Voiceprint.deleted_at.is_(None))
        .filter(or_(*[Voiceprint.email == email for email in candidate_emails]))
        .all()
    )
    by_email = {voiceprint.email: voiceprint for voiceprint in candidates if voiceprint.email}
    return [by_email[email] for email in candidate_emails if email in by_email]
