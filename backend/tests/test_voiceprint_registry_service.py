"""Tests for central voiceprint registry behavior."""
from datetime import datetime

from app.models import Meeting, MeetingStatus, Participant, User, VoiceprintStatus
from app.services.voiceprint_registry import (
    create_voiceprint_record,
    disable_voiceprint,
    list_active_voiceprints,
    select_voiceprint_candidates_for_meeting,
)


def _create_user(db_session, *, email: str, name: str, azure_ad_id: str) -> User:
    user = User(email=email, name=name, azure_ad_id=azure_ad_id, role="user")
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


def test_create_voiceprint_record_stores_provider_id_without_raw_audio_path(db_session):
    user = _create_user(
        db_session,
        email="joseph@example.com",
        name="Joseph Miguel Guerrero",
        azure_ad_id="az-joseph",
    )

    voiceprint = create_voiceprint_record(
        db_session,
        user=user,
        provider_voiceprint_id="vp_joseph_123",
        display_name="Joseph Miguel Guerrero",
        email="Joseph@Example.com",
        sample_duration_seconds=20.67,
        sample_source="self_service_recorder",
        consent_recorded_at=datetime(2026, 6, 8, 7, 0, 0),
        metadata_json={"microphone": "sound_recorder"},
    )

    assert voiceprint.id is not None
    assert voiceprint.provider == "pyannote"
    assert voiceprint.provider_voiceprint_id == "vp_joseph_123"
    assert voiceprint.status == VoiceprintStatus.ACTIVE
    assert voiceprint.email == "joseph@example.com"
    assert voiceprint.sample_source == "self_service_recorder"
    assert voiceprint.raw_sample_path is None
    assert voiceprint.metadata_json == {"microphone": "sound_recorder"}


def test_list_active_voiceprints_excludes_disabled_deleted_and_without_consent(db_session):
    active_user = _create_user(db_session, email="active@example.com", name="Active", azure_ad_id="az-active")
    disabled_user = _create_user(db_session, email="disabled@example.com", name="Disabled", azure_ad_id="az-disabled")
    no_consent_user = _create_user(db_session, email="noconsent@example.com", name="No Consent", azure_ad_id="az-noconsent")

    active = create_voiceprint_record(
        db_session,
        user=active_user,
        provider_voiceprint_id="vp_active",
        display_name="Active",
        email="active@example.com",
        consent_recorded_at=datetime.utcnow(),
    )
    disabled = create_voiceprint_record(
        db_session,
        user=disabled_user,
        provider_voiceprint_id="vp_disabled",
        display_name="Disabled",
        email="disabled@example.com",
        consent_recorded_at=datetime.utcnow(),
    )
    disable_voiceprint(db_session, disabled, reason="offboarded")
    create_voiceprint_record(
        db_session,
        user=no_consent_user,
        provider_voiceprint_id="vp_no_consent",
        display_name="No Consent",
        email="noconsent@example.com",
        consent_recorded_at=None,
    )

    active_voiceprints = list_active_voiceprints(db_session)

    assert [vp.provider_voiceprint_id for vp in active_voiceprints] == [active.provider_voiceprint_id]


def test_select_voiceprint_candidates_for_meeting_uses_attendee_emails_and_dedupes(db_session):
    owner = _create_user(db_session, email="owner@example.com", name="Owner", azure_ad_id="az-owner")
    ben = _create_user(db_session, email="ben@example.com", name="Benjamin", azure_ad_id="az-ben")
    david = _create_user(db_session, email="david@example.com", name="David", azure_ad_id="az-david")
    unrelated = _create_user(db_session, email="other@example.com", name="Other", azure_ad_id="az-other")

    for user in (owner, ben, david, unrelated):
        create_voiceprint_record(
            db_session,
            user=user,
            provider_voiceprint_id=f"vp_{user.email.split('@')[0]}",
            display_name=user.name,
            email=user.email.upper(),
            consent_recorded_at=datetime.utcnow(),
        )

    meeting = Meeting(
        title="IAS Sync",
        status=MeetingStatus.PROCESSING,
        user_id=owner.id,
        identity_hints={
            "current_user": {"email": "OWNER@example.com", "name": "Owner"},
            "organizer": {"email": "david@example.com", "name": "David"},
        },
    )
    db_session.add(meeting)
    db_session.flush()
    db_session.add_all([
        Participant(meeting_id=meeting.id, name="Benjamin", email="BEN@example.com"),
        Participant(meeting_id=meeting.id, name="David", email="david@example.com", is_organizer=True),
        Participant(meeting_id=meeting.id, name="No Voiceprint", email="missing@example.com"),
    ])
    db_session.commit()
    db_session.refresh(meeting)

    candidates = select_voiceprint_candidates_for_meeting(db_session, meeting)

    assert [candidate.email for candidate in candidates] == [
        "owner@example.com",
        "david@example.com",
        "ben@example.com",
    ]
    assert [candidate.provider_voiceprint_id for candidate in candidates] == [
        "vp_owner",
        "vp_david",
        "vp_ben",
    ]
