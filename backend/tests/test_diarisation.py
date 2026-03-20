"""Tests for diarisation service (TDD - written first).

Tests speaker diarisation using Pyannote and merging with transcripts.
Following TDD: write tests FIRST, watch them fail, then implement.
"""
import pytest
from unittest.mock import Mock, patch, MagicMock
from sqlalchemy.orm import Session

from app.models import Meeting, Transcript, MeetingStatus


class TestDiarisationService:
    """Tests for the core diarisation functions."""

    def test_run_diarisation_returns_speaker_segments(
        self,
        sample_audio_file: str,
    ):
        """Diarisation should return speaker-labelled time segments."""
        from app.services.diarisation import run_diarisation

        # Mock the Pyannote pipeline
        mock_diarisation_result = Mock()
        mock_diarisation_result.itertracks.return_value = [
            (Mock(start=0.0, end=5.0), None, "SPEAKER_00"),
            (Mock(start=5.0, end=12.0), None, "SPEAKER_01"),
            (Mock(start=12.0, end=18.0), None, "SPEAKER_00"),
        ]

        with patch("app.services.diarisation.get_diarisation_pipeline") as mock_pipeline:
            mock_pipeline.return_value = Mock(return_value=mock_diarisation_result)

            segments = run_diarisation(sample_audio_file)

        assert len(segments) == 3
        assert segments[0] == {"speaker": "SPEAKER_00", "start": 0.0, "end": 5.0}
        assert segments[1] == {"speaker": "SPEAKER_01", "start": 5.0, "end": 12.0}
        assert segments[2] == {"speaker": "SPEAKER_00", "start": 12.0, "end": 18.0}

    def test_run_diarisation_handles_missing_file(self):
        """Should raise FileNotFoundError for missing audio files."""
        from app.services.diarisation import run_diarisation

        with pytest.raises(FileNotFoundError):
            run_diarisation("/nonexistent/audio.wav")

    def test_run_diarisation_handles_empty_audio(
        self,
        sample_audio_file: str,
    ):
        """Should handle audio with no detected speakers."""
        from app.services.diarisation import run_diarisation

        mock_diarisation_result = Mock()
        mock_diarisation_result.itertracks.return_value = []

        with patch("app.services.diarisation.get_diarisation_pipeline") as mock_pipeline:
            mock_pipeline.return_value = Mock(return_value=mock_diarisation_result)

            segments = run_diarisation(sample_audio_file)

        assert segments == []


class TestSegmentMerging:
    """Tests for merging speaker labels with transcript segments."""

    def test_merge_assigns_speaker_to_segments(self):
        """Each transcript segment should get a speaker label."""
        from app.services.diarisation import merge_speaker_segments

        transcript_segments = [
            {"start": 0.0, "end": 4.0, "text": "Hello, how are you?"},
            {"start": 5.5, "end": 10.0, "text": "I'm doing great, thanks."},
            {"start": 12.5, "end": 17.0, "text": "Let's discuss the project."},
        ]

        speaker_segments = [
            {"speaker": "SPEAKER_00", "start": 0.0, "end": 5.0},
            {"speaker": "SPEAKER_01", "start": 5.0, "end": 12.0},
            {"speaker": "SPEAKER_00", "start": 12.0, "end": 18.0},
        ]

        merged = merge_speaker_segments(transcript_segments, speaker_segments)

        assert len(merged) == 3
        assert merged[0]["speaker"] == "SPEAKER_00"
        assert merged[0]["text"] == "Hello, how are you?"
        assert merged[1]["speaker"] == "SPEAKER_01"
        assert merged[1]["text"] == "I'm doing great, thanks."
        assert merged[2]["speaker"] == "SPEAKER_00"
        assert merged[2]["text"] == "Let's discuss the project."

    def test_merge_handles_overlapping_speakers(self):
        """When segment overlaps multiple speakers, assign the one with most overlap."""
        from app.services.diarisation import merge_speaker_segments

        # Transcript segment from 4.0 to 7.0
        # SPEAKER_00: 0.0-5.0 (overlap = 1.0s)
        # SPEAKER_01: 5.0-12.0 (overlap = 2.0s) <- should win
        transcript_segments = [
            {"start": 4.0, "end": 7.0, "text": "This is a test."},
        ]

        speaker_segments = [
            {"speaker": "SPEAKER_00", "start": 0.0, "end": 5.0},
            {"speaker": "SPEAKER_01", "start": 5.0, "end": 12.0},
        ]

        merged = merge_speaker_segments(transcript_segments, speaker_segments)

        assert merged[0]["speaker"] == "SPEAKER_01"

    def test_merge_handles_no_speaker_overlap(self):
        """Segments with no speaker overlap should get 'Unknown' speaker."""
        from app.services.diarisation import merge_speaker_segments

        transcript_segments = [
            {"start": 20.0, "end": 25.0, "text": "Orphan segment."},
        ]

        speaker_segments = [
            {"speaker": "SPEAKER_00", "start": 0.0, "end": 5.0},
        ]

        merged = merge_speaker_segments(transcript_segments, speaker_segments)

        assert merged[0]["speaker"] == "Unknown"

    def test_merge_handles_empty_speakers(self):
        """If no speaker segments, all transcripts get 'Unknown'."""
        from app.services.diarisation import merge_speaker_segments

        transcript_segments = [
            {"start": 0.0, "end": 5.0, "text": "Hello"},
        ]

        merged = merge_speaker_segments(transcript_segments, [])

        assert merged[0]["speaker"] == "Unknown"

    def test_merge_preserves_original_fields(self):
        """Merged segments should preserve start, end, text from original."""
        from app.services.diarisation import merge_speaker_segments

        transcript_segments = [
            {"start": 0.0, "end": 5.0, "text": "Test message"},
        ]

        speaker_segments = [
            {"speaker": "SPEAKER_00", "start": 0.0, "end": 10.0},
        ]

        merged = merge_speaker_segments(transcript_segments, speaker_segments)

        assert merged[0]["start"] == 0.0
        assert merged[0]["end"] == 5.0
        assert merged[0]["text"] == "Test message"
        assert merged[0]["speaker"] == "SPEAKER_00"


class TestDiarisationPipeline:
    """Tests for the full diarisation pipeline."""

    def test_process_diarisation_updates_transcript(
        self,
        db_session: Session,
        test_meeting: Meeting,
    ):
        """Pipeline should update transcript with speaker labels."""
        from app.services.diarisation import process_diarisation

        # Create a transcript without speaker labels
        transcript = Transcript(
            meeting_id=test_meeting.id,
            full_text="Hello. I'm doing great.",
            segments=[
                {"start": 0.0, "end": 3.0, "text": "Hello."},
                {"start": 3.5, "end": 8.0, "text": "I'm doing great."},
            ],
        )
        db_session.add(transcript)
        db_session.commit()

        # Mock diarisation
        mock_speaker_segments = [
            {"speaker": "SPEAKER_00", "start": 0.0, "end": 3.5},
            {"speaker": "SPEAKER_01", "start": 3.5, "end": 10.0},
        ]

        with patch("app.services.diarisation.download_audio") as mock_download, \
             patch("app.services.diarisation.run_diarisation") as mock_diarize:
            mock_download.return_value = "/tmp/test.wav"
            mock_diarize.return_value = mock_speaker_segments

            updated_transcript = process_diarisation(db_session, test_meeting.id)

        assert updated_transcript.segments[0]["speaker"] == "SPEAKER_00"
        assert updated_transcript.segments[1]["speaker"] == "SPEAKER_01"

    def test_process_diarisation_updates_status(
        self,
        db_session: Session,
        test_meeting: Meeting,
    ):
        """Pipeline should update meeting status to DIARISING."""
        from app.services.diarisation import process_diarisation

        # Create transcript
        transcript = Transcript(
            meeting_id=test_meeting.id,
            full_text="Test",
            segments=[{"start": 0.0, "end": 5.0, "text": "Test"}],
        )
        db_session.add(transcript)
        db_session.commit()

        with patch("app.services.diarisation.download_audio") as mock_download, \
             patch("app.services.diarisation.run_diarisation") as mock_diarize:
            mock_download.return_value = "/tmp/test.wav"
            mock_diarize.return_value = [
                {"speaker": "SPEAKER_00", "start": 0.0, "end": 10.0}
            ]

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

    def test_process_diarisation_sets_failed_on_error(
        self,
        db_session: Session,
        test_meeting: Meeting,
    ):
        """Should set meeting status to FAILED on errors."""
        from app.services.diarisation import process_diarisation

        # Create transcript
        transcript = Transcript(
            meeting_id=test_meeting.id,
            full_text="Test",
            segments=[{"start": 0.0, "end": 5.0, "text": "Test"}],
        )
        db_session.add(transcript)
        db_session.commit()

        with patch("app.services.diarisation.download_audio") as mock_download:
            mock_download.side_effect = FileNotFoundError("Audio not found")

            with pytest.raises(FileNotFoundError):
                process_diarisation(db_session, test_meeting.id)

        db_session.refresh(test_meeting)
        assert test_meeting.status == MeetingStatus.FAILED


class TestDiarisationCeleryTask:
    """Tests for the Celery diarisation task."""

    def test_diarize_meeting_task_returns_speaker_count(
        self,
        db_session: Session,
        test_meeting: Meeting,
    ):
        """Celery task should return speaker count."""
        from app.services.pipeline import diarize_meeting

        # Create transcript
        transcript = Transcript(
            meeting_id=test_meeting.id,
            full_text="Test conversation",
            segments=[
                {"start": 0.0, "end": 5.0, "text": "Hello"},
                {"start": 5.0, "end": 10.0, "text": "Hi there"},
            ],
        )
        db_session.add(transcript)
        db_session.commit()

        with patch("app.services.diarisation.download_audio") as mock_download, \
             patch("app.services.diarisation.run_diarisation") as mock_diarize:
            mock_download.return_value = "/tmp/test.wav"
            mock_diarize.return_value = [
                {"speaker": "SPEAKER_00", "start": 0.0, "end": 5.0},
                {"speaker": "SPEAKER_01", "start": 5.0, "end": 10.0},
            ]

            # Note: In tests we call the function directly, not as Celery task
            with patch("app.services.pipeline.SyncSessionLocal") as mock_session:
                mock_session.return_value.__enter__ = Mock(return_value=db_session)
                mock_session.return_value.__exit__ = Mock(return_value=None)

                # Call the task function directly
                result = diarize_meeting(test_meeting.id)

        assert result["meeting_id"] == test_meeting.id
        assert result["status"] == "diarised"
        assert result["speaker_count"] == 2


class TestSpeakerNaming:
    """Tests for humanising speaker labels."""

    def test_rename_speakers_with_participant_names(self):
        """Should map speaker IDs to participant names when available."""
        from app.services.diarisation import rename_speakers

        segments = [
            {"speaker": "SPEAKER_00", "start": 0.0, "end": 5.0, "text": "Hello"},
            {"speaker": "SPEAKER_01", "start": 5.0, "end": 10.0, "text": "Hi there"},
        ]

        # Mapping from speaker ID to participant name
        speaker_mapping = {
            "SPEAKER_00": "John Smith",
            "SPEAKER_01": "Jane Doe",
        }

        renamed = rename_speakers(segments, speaker_mapping)

        assert renamed[0]["speaker"] == "John Smith"
        assert renamed[1]["speaker"] == "Jane Doe"

    def test_rename_speakers_fallback_to_speaker_numbers(self):
        """Should use 'Speaker 1', 'Speaker 2' if no mapping provided."""
        from app.services.diarisation import rename_speakers

        segments = [
            {"speaker": "SPEAKER_00", "start": 0.0, "end": 5.0, "text": "Hello"},
            {"speaker": "SPEAKER_01", "start": 5.0, "end": 10.0, "text": "Hi"},
            {"speaker": "SPEAKER_02", "start": 10.0, "end": 15.0, "text": "Hey"},
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
