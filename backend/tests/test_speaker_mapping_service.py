"""Tests for speaker mapping service."""

import pytest

from app.models import Meeting, SpeakerMapping, SpeakerMappingSource, Transcript
from app.services.speaker_mapping import (
    calculate_mapping_quality,
    extract_speaker_labels,
    refresh_speaker_mapping_diagnostics,
    should_require_review,
    upsert_speaker_mappings,
)


def test_extract_speaker_labels_returns_distinct_labels_in_order():
    segments = [
        {"speaker": " Speaker A ", "text": "Hello"},
        {"speaker": "Speaker B", "text": "Hi"},
        {"speaker": "Speaker A", "text": "Again"},
        {"speaker": "", "text": "No speaker"},
        {"text": "Missing speaker"},
        {"speaker": "Speaker C", "text": "Third"},
    ]

    assert extract_speaker_labels(segments) == ["Speaker A", "Speaker B", "Speaker C"]
    assert extract_speaker_labels(None) == []


def test_calculate_mapping_quality_averages_mapping_confidence():
    mappings = [
        SpeakerMapping(speaker_label="Speaker A", confidence=0.9, source=SpeakerMappingSource.LLM_INFERENCE),
        SpeakerMapping(speaker_label="Speaker B", confidence=0.7, source=SpeakerMappingSource.LLM_INFERENCE),
        SpeakerMapping(speaker_label="Speaker C", confidence=None, source=SpeakerMappingSource.LLM_INFERENCE),
    ]

    assert calculate_mapping_quality(mappings) == (0.9 + 0.7 + 0.0) / 3
    assert calculate_mapping_quality([]) is None


def test_upsert_preserves_user_corrected_mapping_when_applying_ai_mappings(db_session, test_meeting):
    corrected = SpeakerMapping(
        meeting_id=test_meeting.id,
        speaker_label="Speaker A",
        display_name="Human Choice",
        email="human@example.com",
        confidence=1.0,
        source=SpeakerMappingSource.USER_CORRECTED,
        reason="User fixed this",
    )
    db_session.add(corrected)
    db_session.commit()

    saved = upsert_speaker_mappings(
        db=db_session,
        meeting=test_meeting,
        proposed=[
            {
                "speaker_label": "Speaker A",
                "display_name": "AI Choice",
                "email": "ai@example.com",
                "confidence": 0.95,
                "reason": "AI guessed",
            },
            {
                "speaker_label": "Speaker B",
                "display_name": "New AI Choice",
                "email": "new@example.com",
                "confidence": 0.88,
                "reason": "AI inferred",
            },
        ],
        source=SpeakerMappingSource.LLM_INFERENCE,
    )

    db_session.refresh(test_meeting)
    mappings = {
        mapping.speaker_label: mapping
        for mapping in db_session.query(SpeakerMapping)
        .filter(SpeakerMapping.meeting_id == test_meeting.id)
        .all()
    }

    assert [mapping.speaker_label for mapping in saved] == ["Speaker A", "Speaker B"]
    assert mappings["Speaker A"].display_name == "Human Choice"
    assert mappings["Speaker A"].email == "human@example.com"
    assert mappings["Speaker A"].confidence == 1.0
    assert mappings["Speaker A"].source == SpeakerMappingSource.USER_CORRECTED
    assert mappings["Speaker B"].display_name == "New AI Choice"
    assert mappings["Speaker B"].source == SpeakerMappingSource.LLM_INFERENCE
    assert test_meeting.speaker_mapping_quality == (1.0 + 0.88) / 2


def test_marks_review_needed_when_major_labels_unmapped_or_low_confidence(db_session, test_meeting):
    transcript = Transcript(
        meeting_id=test_meeting.id,
        full_text="Speaker A and Speaker B talked",
        segments=[
            {"speaker": "Speaker A", "text": "Hello"},
            {"speaker": "Speaker B", "text": "Hi"},
            {"speaker": "Speaker C", "text": "Unmapped"},
        ],
    )
    db_session.add(transcript)
    db_session.commit()

    saved = upsert_speaker_mappings(
        db=db_session,
        meeting=test_meeting,
        proposed=[
            {
                "speaker_label": "Speaker A",
                "display_name": "Alice",
                "email": "alice@example.com",
                "confidence": 0.95,
            },
            {
                "speaker_label": "Speaker B",
                "display_name": "Bob",
                "email": "bob@example.com",
                "confidence": 0.65,
            },
        ],
        source=SpeakerMappingSource.LLM_INFERENCE,
    )

    db_session.refresh(test_meeting)
    assert should_require_review(
        ["Speaker A", "Speaker B", "Speaker C"],
        {mapping.speaker_label: mapping for mapping in saved},
    ) is True
    assert test_meeting.needs_speaker_review is True
    assert test_meeting.speaker_mapping_quality == (0.95 + 0.65) / 2
    assert test_meeting.diarization_diagnostics == {
        "detected_speaker_count": 3,
        "mapped_speaker_count": 2,
        "average_mapping_confidence": (0.95 + 0.65) / 2,
        "low_confidence_labels": ["Speaker B"],
        "speaker_labels": ["Speaker A", "Speaker B", "Speaker C"],
        "mapped_speaker_labels": ["Speaker A", "Speaker B"],
        "unmapped_speaker_labels": ["Speaker C"],
        "low_confidence_speaker_labels": ["Speaker B"],
        "speaker_mapping_threshold": 0.7,
    }


def test_identity_less_high_confidence_mapping_still_requires_review(db_session, test_meeting):
    transcript = Transcript(
        meeting_id=test_meeting.id,
        full_text="Speaker A talked",
        segments=[{"speaker": "Speaker A", "text": "Hello"}],
    )
    db_session.add(transcript)
    db_session.commit()

    saved = upsert_speaker_mappings(
        db=db_session,
        meeting=test_meeting,
        proposed=[
            {
                "speaker_label": "Speaker A",
                "display_name": None,
                "email": "   ",
                "confidence": 0.99,
                "reason": "   ",
            }
        ],
        source=SpeakerMappingSource.LLM_INFERENCE,
    )

    db_session.refresh(test_meeting)
    assert should_require_review(
        ["Speaker A"],
        {mapping.speaker_label: mapping for mapping in saved},
    ) is True
    assert test_meeting.needs_speaker_review is True
    assert test_meeting.diarization_diagnostics["mapped_speaker_labels"] == []
    assert test_meeting.diarization_diagnostics["unmapped_speaker_labels"] == ["Speaker A"]
    assert saved[0].email is None
    assert saved[0].reason is None


@pytest.mark.parametrize("speaker_label", ["", "   ", None])
def test_upsert_rejects_blank_speaker_labels(db_session, test_meeting, speaker_label):
    with pytest.raises(ValueError, match="speaker_label"):
        upsert_speaker_mappings(
            db=db_session,
            meeting=test_meeting,
            proposed=[{"speaker_label": speaker_label, "display_name": "Alice", "confidence": 0.9}],
            source=SpeakerMappingSource.LLM_INFERENCE,
        )

    assert db_session.query(SpeakerMapping).filter(SpeakerMapping.meeting_id == test_meeting.id).count() == 0


@pytest.mark.parametrize("confidence", [-0.01, 1.01, "nan", "inf", "-inf", ""])
def test_upsert_rejects_out_of_range_confidence(db_session, test_meeting, confidence):
    with pytest.raises(ValueError, match="confidence"):
        upsert_speaker_mappings(
            db=db_session,
            meeting=test_meeting,
            proposed=[{"speaker_label": "Speaker A", "display_name": "Alice", "confidence": confidence}],
            source=SpeakerMappingSource.LLM_INFERENCE,
        )

    assert db_session.query(SpeakerMapping).filter(SpeakerMapping.meeting_id == test_meeting.id).count() == 0


def test_upsert_duplicate_labels_last_normalized_value_wins(db_session, test_meeting):
    saved = upsert_speaker_mappings(
        db=db_session,
        meeting=test_meeting,
        proposed=[
            {
                "speaker_label": " Speaker A ",
                "display_name": "Alice First",
                "email": "first@example.com",
                "confidence": 0.4,
                "reason": "first",
            },
            {
                "speaker_label": "Speaker A",
                "display_name": "  Alice Last  ",
                "email": "  ",
                "confidence": 0.95,
                "reason": "  last reason  ",
            },
        ],
        source=SpeakerMappingSource.LLM_INFERENCE,
    )

    mappings = db_session.query(SpeakerMapping).filter(SpeakerMapping.meeting_id == test_meeting.id).all()
    assert len(saved) == 1
    assert len(mappings) == 1
    assert saved[0].speaker_label == "Speaker A"
    assert saved[0].display_name == "Alice Last"
    assert saved[0].email is None
    assert saved[0].confidence == 0.95
    assert saved[0].reason == "last reason"


def test_stale_mappings_excluded_from_current_transcript_quality(db_session, test_meeting):
    transcript = Transcript(
        meeting_id=test_meeting.id,
        full_text="Speaker A talked",
        segments=[{"speaker": "Speaker A", "text": "Hello"}],
    )
    db_session.add(transcript)
    db_session.add(
        SpeakerMapping(
            meeting_id=test_meeting.id,
            speaker_label="Stale Speaker",
            display_name="Stale",
            confidence=0.1,
            source=SpeakerMappingSource.LLM_INFERENCE,
        )
    )
    db_session.commit()

    upsert_speaker_mappings(
        db=db_session,
        meeting=test_meeting,
        proposed=[{"speaker_label": "Speaker A", "display_name": "Alice", "confidence": 0.9}],
        source=SpeakerMappingSource.LLM_INFERENCE,
    )

    db_session.refresh(test_meeting)
    assert test_meeting.speaker_mapping_quality == 0.9
    assert test_meeting.diarization_diagnostics["speaker_labels"] == ["Speaker A"]
    assert test_meeting.diarization_diagnostics["mapped_speaker_labels"] == ["Speaker A"]


def test_transcript_with_no_speaker_labels_excludes_stale_mappings_from_quality(db_session, test_meeting):
    transcript = Transcript(
        meeting_id=test_meeting.id,
        full_text="No diarized speaker labels are available",
        segments=[],
    )
    stale_mapping = SpeakerMapping(
        meeting_id=test_meeting.id,
        speaker_label="Stale Speaker",
        display_name="Stale",
        confidence=0.95,
        source=SpeakerMappingSource.LLM_INFERENCE,
    )
    db_session.add(transcript)
    db_session.add(stale_mapping)
    db_session.commit()

    refresh_speaker_mapping_diagnostics(db_session, test_meeting)
    db_session.add(test_meeting)
    db_session.commit()
    db_session.refresh(test_meeting)

    assert test_meeting.speaker_mapping_quality is None
    assert test_meeting.needs_speaker_review is False
    assert test_meeting.diarization_diagnostics == {
        "detected_speaker_count": 0,
        "mapped_speaker_count": 0,
        "average_mapping_confidence": None,
        "low_confidence_labels": [],
        "speaker_labels": [],
        "mapped_speaker_labels": [],
        "unmapped_speaker_labels": [],
        "low_confidence_speaker_labels": [],
        "speaker_mapping_threshold": 0.7,
    }


def test_marks_review_not_needed_when_all_labels_confidently_mapped(db_session, test_meeting):
    transcript = Transcript(
        meeting_id=test_meeting.id,
        full_text="Speaker A and Speaker B talked",
        segments=[
            {"speaker": "Speaker A", "text": "Hello"},
            {"speaker": "Speaker B", "text": "Hi"},
        ],
    )
    db_session.add(transcript)
    db_session.commit()

    upsert_speaker_mappings(
        db=db_session,
        meeting=test_meeting,
        proposed=[
            {
                "speaker_label": "Speaker A",
                "display_name": "Alice",
                "email": "alice@example.com",
                "confidence": 0.91,
            },
            {
                "speaker_label": "Speaker B",
                "display_name": "Bob",
                "email": "bob@example.com",
                "confidence": 0.7,
            },
        ],
        source=SpeakerMappingSource.LLM_INFERENCE,
    )

    db_session.refresh(test_meeting)
    assert test_meeting.needs_speaker_review is False
    assert test_meeting.speaker_mapping_quality == (0.91 + 0.7) / 2
    assert test_meeting.diarization_diagnostics == {
        "detected_speaker_count": 2,
        "mapped_speaker_count": 2,
        "average_mapping_confidence": (0.91 + 0.7) / 2,
        "low_confidence_labels": [],
        "speaker_labels": ["Speaker A", "Speaker B"],
        "mapped_speaker_labels": ["Speaker A", "Speaker B"],
        "unmapped_speaker_labels": [],
        "low_confidence_speaker_labels": [],
        "speaker_mapping_threshold": 0.7,
    }
