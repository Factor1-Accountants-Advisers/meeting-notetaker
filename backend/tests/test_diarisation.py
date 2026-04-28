"""Tests for diarisation service.

Tests speaker label renaming and post-processing.
AssemblyAI handles the actual diarisation during transcription;
this module just renames generic labels to human-readable names.
"""
import pytest
from unittest.mock import Mock, patch, MagicMock
from sqlalchemy.orm import Session

from app.models import Meeting, Transcript, MeetingStatus


class TestSpeakerNaming:
    """Tests for humanising speaker labels."""

    def test_rename_speakers_with_participant_names(self):
        """Should map speaker IDs to participant names when available."""
        from app.services.diarisation import rename_speakers

        segments = [
            {"speaker": "A", "start": 0.0, "end": 5.0, "text": "Hello"},
            {"speaker": "B", "start": 5.0, "end": 10.0, "text": "Hi there"},
        ]

        speaker_mapping = {
            "A": "John Smith",
            "B": "Jane Doe",
        }

        renamed = rename_speakers(segments, speaker_mapping)

        assert renamed[0]["speaker"] == "John Smith"
        assert renamed[1]["speaker"] == "Jane Doe"

    def test_rename_speakers_fallback_to_speaker_numbers(self):
        """Should use 'Speaker 1', 'Speaker 2' if no mapping provided."""
        from app.services.diarisation import rename_speakers

        segments = [
            {"speaker": "A", "start": 0.0, "end": 5.0, "text": "Hello"},
            {"speaker": "B", "start": 5.0, "end": 10.0, "text": "Hi"},
            {"speaker": "C", "start": 10.0, "end": 15.0, "text": "Hey"},
        ]

        renamed = rename_speakers(segments, {})

        assert renamed[0]["speaker"] == "Speaker 1"
        assert renamed[1]["speaker"] == "Speaker 2"
        assert renamed[2]["speaker"] == "Speaker 3"

    def test_rename_speakers_handles_unknown(self):
        """Should preserve 'Unknown' speaker label."""
        from app.services.diarisation import rename_speakers

        segments = [
            {"speaker": "Unknown", "start": 0.0, "end": 5.0, "text": "Hello"},
        ]

        renamed = rename_speakers(segments, {})

        assert renamed[0]["speaker"] == "Unknown"

    def test_rename_speakers_preserves_segment_fields(self):
        """Renaming should not alter start, end, or text fields."""
        from app.services.diarisation import rename_speakers

        segments = [
            {"speaker": "A", "start": 1.5, "end": 3.5, "text": "Test message"},
        ]

        renamed = rename_speakers(segments)

        assert renamed[0]["start"] == 1.5
        assert renamed[0]["end"] == 3.5
        assert renamed[0]["text"] == "Test message"

    def test_rename_speakers_consistent_ordering(self):
        """Speakers should be numbered in order of first appearance."""
        from app.services.diarisation import rename_speakers

        segments = [
            {"speaker": "B", "start": 0.0, "end": 2.0, "text": "First"},
            {"speaker": "A", "start": 2.0, "end": 4.0, "text": "Second"},
            {"speaker": "B", "start": 4.0, "end": 6.0, "text": "Third"},
        ]

        renamed = rename_speakers(segments)

        # B appears first, so B = Speaker 1, A = Speaker 2
        assert renamed[0]["speaker"] == "Speaker 1"
        assert renamed[1]["speaker"] == "Speaker 2"
        assert renamed[2]["speaker"] == "Speaker 1"


class TestDiarisationPipeline:
    """Tests for the diarisation post-processing pipeline."""

    def test_process_diarisation_renames_speakers(
        self,
        db_session: Session,
        test_meeting: Meeting,
    ):
        """Pipeline should rename speaker labels to human-readable names."""
        from app.services.diarisation import process_diarisation

        # Create a transcript with AssemblyAI-style speaker labels
        transcript = Transcript(
            meeting_id=test_meeting.id,
            full_text="Hello. I'm doing great.",
            segments=[
                {"speaker": "A", "start": 0.0, "end": 3.0, "text": "Hello."},
                {"speaker": "B", "start": 3.5, "end": 8.0, "text": "I'm doing great."},
            ],
        )
        db_session.add(transcript)
        db_session.commit()

        updated_transcript = process_diarisation(db_session, test_meeting.id)

        assert updated_transcript.segments[0]["speaker"] == "Speaker 1"
        assert updated_transcript.segments[1]["speaker"] == "Speaker 2"

    def test_process_diarisation_updates_status(
        self,
        db_session: Session,
        test_meeting: Meeting,
    ):
        """Pipeline should update meeting status to DIARISING."""
        from app.services.diarisation import process_diarisation

        transcript = Transcript(
            meeting_id=test_meeting.id,
            full_text="Test",
            segments=[{"speaker": "A", "start": 0.0, "end": 5.0, "text": "Test"}],
        )
        db_session.add(transcript)
        db_session.commit()

        process_diarisation(db_session, test_meeting.id)

        db_session.refresh(test_meeting)
        assert test_meeting.status == MeetingStatus.DIARISING

    def test_process_diarisation_fails_without_transcript(
        self,
        db_session: Session,
        test_meeting: Meeting,
    ):
        """Should raise error if transcript doesn't exist."""
        from app.services.diarisation import process_diarisation

        with pytest.raises(ValueError, match="Transcript not found"):
            process_diarisation(db_session, test_meeting.id)

    def test_process_diarisation_handles_empty_segments(
        self,
        db_session: Session,
        test_meeting: Meeting,
    ):
        """Should handle transcript with no segments gracefully."""
        from app.services.diarisation import process_diarisation

        transcript = Transcript(
            meeting_id=test_meeting.id,
            full_text="",
            segments=[],
        )
        db_session.add(transcript)
        db_session.commit()

        updated_transcript = process_diarisation(db_session, test_meeting.id)
        assert updated_transcript.segments == []


class TestDiarisationCeleryTask:
    """Tests for the Celery diarisation task."""

    def test_diarize_meeting_task_returns_speaker_count(
        self,
        db_session: Session,
        test_meeting: Meeting,
    ):
        """Celery task should return speaker count."""
        from app.services.pipeline import diarize_meeting

        transcript = Transcript(
            meeting_id=test_meeting.id,
            full_text="Test conversation",
            segments=[
                {"speaker": "A", "start": 0.0, "end": 5.0, "text": "Hello"},
                {"speaker": "B", "start": 5.0, "end": 10.0, "text": "Hi there"},
            ],
        )
        db_session.add(transcript)
        db_session.commit()

        with patch("app.services.pipeline.SyncSessionLocal") as mock_session:
            mock_session.return_value.__enter__ = Mock(return_value=db_session)
            mock_session.return_value.__exit__ = Mock(return_value=None)

            result = diarize_meeting(test_meeting.id)

        assert result["meeting_id"] == test_meeting.id
        assert result["status"] == "diarised"
        assert result["speaker_count"] == 2


class TestDiarisationWithSpeakerInference:
    """Tests for diarisation with LLM speaker inference."""

    def test_applies_llm_mapping_when_confident(
        self,
        db_session: Session,
        test_meeting_with_participants: Meeting,
    ):
        """Should replace Speaker N with real names when LLM is confident."""
        from app.services.diarisation import process_diarisation

        transcript = Transcript(
            meeting_id=test_meeting_with_participants.id,
            full_text="Thanks Melissa. No worries.",
            segments=[
                {"speaker": "A", "start": 0.0, "end": 3.0, "text": "Thanks Melissa, I agree with the plan."},
                {"speaker": "B", "start": 3.0, "end": 6.0, "text": "No worries, happy to help."},
            ],
        )
        db_session.add(transcript)
        db_session.commit()

        mock_mapping = {
            "Speaker 1": {
                "display_name": "Test User",
                "email": "test@example.com",
                "confidence": 0.95,
                "reasoning": "Speaker 2 is addressed as Melissa, so Speaker 1 is the other participant",
            },
            "Speaker 2": {
                "display_name": "Melissa Hall",
                "email": "melissa@example.com",
                "confidence": 0.9,
                "reasoning": "Addressed as Melissa by Speaker 1",
            },
        }

        with patch("app.services.diarisation.infer_speaker_identities", return_value=mock_mapping):
            updated = process_diarisation(db_session, test_meeting_with_participants.id)

        assert updated.segments[0]["speaker"] == "Test User"
        assert updated.segments[1]["speaker"] == "Melissa Hall"
        assert updated.segments[0]["raw_speaker"] == "A"
        assert updated.segments[1]["raw_speaker"] == "B"

    def test_keeps_generic_labels_when_inference_fails(
        self,
        db_session: Session,
        test_meeting_with_participants: Meeting,
    ):
        """Should keep Speaker N labels when LLM inference fails."""
        from app.services.diarisation import process_diarisation

        transcript = Transcript(
            meeting_id=test_meeting_with_participants.id,
            full_text="Hello. Hi.",
            segments=[
                {"speaker": "A", "start": 0.0, "end": 3.0, "text": "Hello."},
                {"speaker": "B", "start": 3.0, "end": 6.0, "text": "Hi."},
            ],
        )
        db_session.add(transcript)
        db_session.commit()

        with patch("app.services.diarisation.infer_speaker_identities", side_effect=Exception("API down")):
            updated = process_diarisation(db_session, test_meeting_with_participants.id)

        assert updated.segments[0]["speaker"] == "Speaker 1"
        assert updated.segments[1]["speaker"] == "Speaker 2"

    def test_keeps_generic_labels_when_no_candidates(
        self,
        db_session: Session,
        test_meeting: Meeting,
    ):
        """Should keep Speaker N labels when no identity hints exist."""
        from app.services.diarisation import process_diarisation

        transcript = Transcript(
            meeting_id=test_meeting.id,
            full_text="Hello. Hi.",
            segments=[
                {"speaker": "A", "start": 0.0, "end": 3.0, "text": "Hello."},
                {"speaker": "B", "start": 3.0, "end": 6.0, "text": "Hi."},
            ],
        )
        db_session.add(transcript)
        db_session.commit()

        updated = process_diarisation(db_session, test_meeting.id)

        assert updated.segments[0]["speaker"] == "Speaker 1"
        assert updated.segments[1]["speaker"] == "Speaker 2"

    def test_preserves_raw_speaker_on_all_segments(
        self,
        db_session: Session,
        test_meeting_with_participants: Meeting,
    ):
        """Every segment should have raw_speaker after diarisation."""
        from app.services.diarisation import process_diarisation

        transcript = Transcript(
            meeting_id=test_meeting_with_participants.id,
            full_text="Hello. Hi.",
            segments=[
                {"speaker": "A", "start": 0.0, "end": 3.0, "text": "Hello."},
                {"speaker": "B", "start": 3.0, "end": 6.0, "text": "Hi."},
            ],
        )
        db_session.add(transcript)
        db_session.commit()

        with patch("app.services.diarisation.infer_speaker_identities", return_value={}):
            updated = process_diarisation(db_session, test_meeting_with_participants.id)

        for seg in updated.segments:
            assert "raw_speaker" in seg

    def test_keeps_generic_labels_when_candidate_pool_fails(
        self,
        db_session: Session,
        test_meeting_with_participants: Meeting,
    ):
        """Should keep generic labels if build_candidate_pool raises (e.g., malformed identity_hints)."""
        from app.services.diarisation import process_diarisation

        transcript = Transcript(
            meeting_id=test_meeting_with_participants.id,
            full_text="Hello. Hi.",
            segments=[
                {"speaker": "A", "start": 0.0, "end": 3.0, "text": "Hello."},
                {"speaker": "B", "start": 3.0, "end": 6.0, "text": "Hi."},
            ],
        )
        db_session.add(transcript)
        db_session.commit()

        # Patch build_candidate_pool to raise — simulates malformed identity_hints
        with patch(
            "app.services.diarisation.build_candidate_pool",
            side_effect=AttributeError("identity_hints is not a dict"),
        ):
            updated = process_diarisation(db_session, test_meeting_with_participants.id)

        # Pipeline survives, segments fall back to generic labels
        assert updated.segments[0]["speaker"] == "Speaker 1"
        assert updated.segments[1]["speaker"] == "Speaker 2"

        # Meeting status must NOT be FAILED — defense-in-depth requirement
        db_session.refresh(test_meeting_with_participants)
        assert test_meeting_with_participants.status != MeetingStatus.FAILED


class TestDiarisationReconciliation:
    """Tests for AssemblyAI + LLM signal reconciliation (Option A+).

    The LLM must always run as a verifier, even when AssemblyAI returned
    real names. AssemblyAI names win on conflict (deterministic > probabilistic);
    LLM fills gaps when AssemblyAI fell back to a cluster ID.
    """

    def test_llm_runs_even_when_assemblyai_returned_real_names(
        self,
        db_session: Session,
        test_meeting_with_participants: Meeting,
    ):
        """The bug fix: LLM must run even when input segments already have names."""
        from app.services.diarisation import process_diarisation

        transcript = Transcript(
            meeting_id=test_meeting_with_participants.id,
            full_text="Thanks Melissa. No worries.",
            segments=[
                {"speaker": "Test User", "start": 0.0, "end": 3.0, "text": "Thanks Melissa."},
                {"speaker": "Melissa Hall", "start": 3.0, "end": 6.0, "text": "No worries."},
            ],
        )
        db_session.add(transcript)
        db_session.commit()

        # LLM confirms AssemblyAI's choices
        mock_mapping = {
            "Speaker 1": {
                "display_name": "Test User",
                "email": "test@example.com",
                "confidence": 0.9,
                "reasoning": "Speaker 2 addressed as Melissa",
            },
            "Speaker 2": {
                "display_name": "Melissa Hall",
                "email": "melissa@example.com",
                "confidence": 0.95,
                "reasoning": "Addressed as Melissa",
            },
        }

        with patch(
            "app.services.diarisation.infer_speaker_identities",
            return_value=mock_mapping,
        ) as mock_llm:
            updated = process_diarisation(db_session, test_meeting_with_participants.id)

        # The LLM was actually invoked (the bug fix)
        assert mock_llm.called, "LLM inference should ALWAYS run when candidates exist"

        # AssemblyAI's names retained (both signals agree)
        assert updated.segments[0]["speaker"] == "Test User"
        assert updated.segments[1]["speaker"] == "Melissa Hall"

        # Raw labels preserved
        assert updated.segments[0]["raw_speaker"] == "Test User"
        assert updated.segments[1]["raw_speaker"] == "Melissa Hall"

    def test_assemblyai_name_wins_when_llm_disagrees(
        self,
        db_session: Session,
        test_meeting_with_participants: Meeting,
    ):
        """AssemblyAI's deterministic acoustic match beats LLM's text guess."""
        from app.services.diarisation import process_diarisation

        transcript = Transcript(
            meeting_id=test_meeting_with_participants.id,
            full_text="One thing on the audit.",
            segments=[
                {"speaker": "Melissa Hall", "start": 0.0, "end": 3.0, "text": "One thing on the audit."},
            ],
        )
        db_session.add(transcript)
        db_session.commit()

        # LLM confidently says it's Test User instead — AssemblyAI should still win
        mock_mapping = {
            "Speaker 1": {
                "display_name": "Test User",
                "email": "test@example.com",
                "confidence": 0.95,
                "reasoning": "Discusses the audit (LLM is wrong here)",
            },
        }

        with patch(
            "app.services.diarisation.infer_speaker_identities",
            return_value=mock_mapping,
        ):
            updated = process_diarisation(db_session, test_meeting_with_participants.id)

        # AssemblyAI wins on conflict
        assert updated.segments[0]["speaker"] == "Melissa Hall"
        assert updated.segments[0]["raw_speaker"] == "Melissa Hall"

    def test_llm_fills_gap_when_assemblyai_partial_success(
        self,
        db_session: Session,
        test_meeting_with_participants: Meeting,
    ):
        """The original bug case: AssemblyAI named one speaker, fell back to 'B' for the other.

        Before the fix: 'B' would pass through unchanged because speaker_identified=True
                        skipped the LLM step entirely.
        After the fix:  LLM runs, identifies 'B' as Melissa, fills the gap.
        """
        from app.services.diarisation import process_diarisation

        transcript = Transcript(
            meeting_id=test_meeting_with_participants.id,
            full_text="Thanks Melissa. No worries.",
            segments=[
                {"speaker": "Test User", "start": 0.0, "end": 3.0, "text": "Thanks Melissa, I agree."},
                {"speaker": "B", "start": 3.0, "end": 6.0, "text": "No worries Joseph, happy to help."},
            ],
        )
        db_session.add(transcript)
        db_session.commit()

        mock_mapping = {
            "Speaker 1": {
                "display_name": "Test User",
                "email": "test@example.com",
                "confidence": 0.9,
                "reasoning": "Addresses Melissa",
            },
            "Speaker 2": {
                "display_name": "Melissa Hall",
                "email": "melissa@example.com",
                "confidence": 0.95,
                "reasoning": "Addressed as Melissa by Speaker 1",
            },
        }

        with patch(
            "app.services.diarisation.infer_speaker_identities",
            return_value=mock_mapping,
        ):
            updated = process_diarisation(db_session, test_meeting_with_participants.id)

        # Test User retained (AssemblyAI got it right)
        assert updated.segments[0]["speaker"] == "Test User"
        # Melissa filled in by LLM (AssemblyAI fell back to 'B')
        assert updated.segments[1]["speaker"] == "Melissa Hall"
        # LLM-derived speaker carries confidence + email metadata
        assert updated.segments[1].get("matched_email") == "melissa@example.com"
        assert updated.segments[1].get("match_confidence") == 0.95
        # AssemblyAI-derived speaker does NOT carry LLM metadata
        assert "match_confidence" not in updated.segments[0]

    def test_unknown_label_falls_back_to_generic_when_llm_unsure(
        self,
        db_session: Session,
        test_meeting_with_participants: Meeting,
    ):
        """If neither AssemblyAI nor the LLM can name a speaker, keep generic 'Speaker N'."""
        from app.services.diarisation import process_diarisation

        transcript = Transcript(
            meeting_id=test_meeting_with_participants.id,
            full_text="Hi. Hello.",
            segments=[
                {"speaker": "A", "start": 0.0, "end": 3.0, "text": "Hi."},
                {"speaker": "B", "start": 3.0, "end": 6.0, "text": "Hello."},
            ],
        )
        db_session.add(transcript)
        db_session.commit()

        # LLM returns no confident matches
        with patch(
            "app.services.diarisation.infer_speaker_identities",
            return_value={},
        ):
            updated = process_diarisation(db_session, test_meeting_with_participants.id)

        assert updated.segments[0]["speaker"] == "Speaker 1"
        assert updated.segments[1]["speaker"] == "Speaker 2"
        assert updated.segments[0]["raw_speaker"] == "A"
        assert updated.segments[1]["raw_speaker"] == "B"
