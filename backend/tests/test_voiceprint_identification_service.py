"""Tests for applying voiceprint speaker identification to transcript segments."""
from datetime import datetime

from app.models import Meeting, MeetingStatus, Participant, Transcript, User, VoiceprintStatus
from app.services.voiceprint_identification import (
    apply_voiceprint_identification,
    merge_identity_segments_into_transcript,
)
from app.services.voiceprint_registry import create_voiceprint_record


class FakeIdentificationProvider:
    def __init__(self, identity_segments):
        self.identity_segments = identity_segments
        self.calls = []

    def identify_speakers(self, audio_path, *, voiceprints, num_speakers=None):
        self.calls.append({
            "audio_path": audio_path,
            "voiceprints": voiceprints,
            "num_speakers": num_speakers,
        })
        return self.identity_segments


def test_merge_identity_segments_names_high_confidence_segments_and_preserves_raw_speaker():
    transcript_segments = [
        {"speaker": "A", "start": 0.0, "end": 4.0, "text": "I will send the report."},
        {"speaker": "B", "start": 4.0, "end": 8.0, "text": "I will review it."},
        {"speaker": "A", "start": 8.0, "end": 9.0, "text": "Tiny segment."},
    ]
    identity_segments = [
        {
            "start": 0.0,
            "end": 4.2,
            "display_name": "Joseph Miguel Guerrero",
            "email": "joseph@example.com",
            "confidence": 0.92,
        },
        {
            "start": 4.0,
            "end": 8.0,
            "display_name": "Benjamin Bryant",
            "email": "ben@example.com",
            "confidence": 0.68,
        },
    ]

    merged, diagnostics = merge_identity_segments_into_transcript(
        transcript_segments,
        identity_segments,
        confidence_threshold=0.7,
    )

    assert merged[0]["speaker"] == "Joseph Miguel Guerrero"
    assert merged[0]["raw_speaker"] == "A"
    assert merged[0]["matched_email"] == "joseph@example.com"
    assert merged[0]["match_confidence"] == 0.92
    assert merged[0]["speaker_source"] == "pyannote"

    # Low provider confidence remains generic but carries review metadata.
    assert merged[1]["speaker"] == "B"
    assert merged[1]["raw_speaker"] == "B"
    assert merged[1]["speaker_review_required"] is True
    assert merged[1]["speaker_review_reason"] == "low_voiceprint_confidence"

    assert merged[2]["speaker"] == "A"
    assert merged[2]["speaker_review_required"] is True
    assert merged[2]["speaker_review_reason"] == "no_voiceprint_match"

    assert diagnostics["voiceprint_identification_enabled"] is True
    assert diagnostics["voiceprint_named_segment_count"] == 1
    assert diagnostics["voiceprint_low_confidence_segment_count"] == 1
    assert diagnostics["voiceprint_unmatched_segment_count"] == 1


def test_apply_voiceprint_identification_selects_candidates_and_updates_transcript_and_diagnostics(db_session):
    owner = User(email="joseph@example.com", name="Joseph Miguel Guerrero", azure_ad_id="az-joseph", role="user")
    ben = User(email="ben@example.com", name="Benjamin Bryant", azure_ad_id="az-ben", role="user")
    unrelated = User(email="other@example.com", name="Other Person", azure_ad_id="az-other", role="user")
    db_session.add_all([owner, ben, unrelated])
    db_session.commit()

    for user, provider_id in [(owner, "vp_joseph"), (ben, "vp_ben"), (unrelated, "vp_other")]:
        create_voiceprint_record(
            db_session,
            user=user,
            provider_voiceprint_id=provider_id,
            display_name=user.name,
            email=user.email,
            consent_recorded_at=datetime.utcnow(),
        )

    meeting = Meeting(
        title="Voiceprint Test",
        status=MeetingStatus.TRANSCRIBING,
        user_id=owner.id,
        identity_hints={"current_user": {"email": "joseph@example.com", "name": "Joseph Miguel Guerrero"}},
    )
    db_session.add(meeting)
    db_session.flush()
    db_session.add(Participant(meeting_id=meeting.id, name="Benjamin Bryant", email="ben@example.com"))
    transcript = Transcript(
        meeting_id=meeting.id,
        full_text="Hello. Hi.",
        segments=[
            {"speaker": "A", "start": 0.0, "end": 3.0, "text": "Hello."},
            {"speaker": "B", "start": 3.0, "end": 6.0, "text": "Hi."},
        ],
    )
    db_session.add(transcript)
    db_session.commit()
    db_session.refresh(meeting)
    db_session.refresh(transcript)

    provider = FakeIdentificationProvider([
        {"start": 0.0, "end": 3.0, "display_name": "Joseph Miguel Guerrero", "email": "joseph@example.com", "confidence": 0.9},
        {"start": 3.0, "end": 6.0, "display_name": "Benjamin Bryant", "email": "ben@example.com", "confidence": 0.91},
    ])

    updated = apply_voiceprint_identification(
        db_session,
        meeting=meeting,
        transcript=transcript,
        local_audio_path="/tmp/fake-meeting.wav",
        provider=provider,
    )

    assert [call_vp["label"] for call_vp in provider.calls[0]["voiceprints"]] == [
        "Joseph Miguel Guerrero",
        "Benjamin Bryant",
    ]
    assert [segment["speaker"] for segment in updated.segments] == [
        "Joseph Miguel Guerrero",
        "Benjamin Bryant",
    ]
    assert updated.speaker_identified is True
    assert meeting.diarization_diagnostics["voiceprint_candidate_count"] == 2
    assert meeting.diarization_diagnostics["voiceprint_identification_enabled"] is True
    assert meeting.diarization_diagnostics["voiceprint_named_segment_count"] == 2


def test_apply_voiceprint_identification_skips_when_no_candidates(db_session, test_user):
    meeting = Meeting(title="No Candidates", status=MeetingStatus.TRANSCRIBING, user_id=test_user.id)
    db_session.add(meeting)
    db_session.flush()
    transcript = Transcript(
        meeting_id=meeting.id,
        full_text="Hello.",
        segments=[{"speaker": "A", "start": 0.0, "end": 1.0, "text": "Hello."}],
    )
    db_session.add(transcript)
    db_session.commit()
    db_session.refresh(meeting)
    db_session.refresh(transcript)

    provider = FakeIdentificationProvider([])
    updated = apply_voiceprint_identification(
        db_session,
        meeting=meeting,
        transcript=transcript,
        local_audio_path="/tmp/fake.wav",
        provider=provider,
    )

    assert provider.calls == []
    assert updated.segments == [{"speaker": "A", "start": 0.0, "end": 1.0, "text": "Hello."}]
    assert meeting.diarization_diagnostics["voiceprint_candidate_count"] == 0
    assert meeting.diarization_diagnostics["voiceprint_identification_enabled"] is False
