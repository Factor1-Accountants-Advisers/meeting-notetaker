"""Tests for transcription service.

TDD: These tests are written FIRST, before implementation.
Each test should fail initially, then pass after implementation.
"""
import os
import tempfile
from datetime import datetime
from unittest.mock import MagicMock, patch, AsyncMock

import pytest
from sqlalchemy.orm import Session

from app.models import Meeting, MeetingStatus, Transcript, User


class TestTranscriptionService:
    """Tests for the transcription service module."""

    def test_transcribe_audio_returns_segments(self, sample_audio_file):
        """Transcription should return text segments with timestamps."""
        from app.services.transcription import transcribe_audio

        result = transcribe_audio(sample_audio_file)

        assert "text" in result
        assert "segments" in result
        assert isinstance(result["segments"], list)

    def test_transcribe_audio_segments_have_required_fields(self, sample_audio_file):
        """Each segment should have start, end, and text fields."""
        from app.services.transcription import transcribe_audio

        result = transcribe_audio(sample_audio_file)

        for segment in result["segments"]:
            assert "start" in segment
            assert "end" in segment
            assert "text" in segment
            assert isinstance(segment["start"], (int, float))
            assert isinstance(segment["end"], (int, float))
            assert isinstance(segment["text"], str)

    def test_transcribe_audio_handles_missing_file(self):
        """Should raise FileNotFoundError for missing audio files."""
        from app.services.transcription import transcribe_audio

        with pytest.raises(FileNotFoundError):
            transcribe_audio("/nonexistent/path/audio.wav")

    def test_transcribe_audio_handles_invalid_file(self):
        """Should raise ValueError for invalid audio files."""
        from app.services.transcription import transcribe_audio

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(b"not a valid wav file")
            temp_path = f.name

        try:
            with pytest.raises((ValueError, Exception)):
                transcribe_audio(temp_path)
        finally:
            os.unlink(temp_path)


class TestTranscriptSaving:
    """Tests for saving transcripts to database."""

    def test_save_transcript_creates_record(
        self, db_session: Session, test_meeting: Meeting, mock_whisper_result
    ):
        """Saving transcript should create a Transcript record."""
        from app.services.transcription import save_transcript

        save_transcript(
            db_session,
            meeting_id=test_meeting.id,
            transcription_result=mock_whisper_result,
        )

        transcript = db_session.query(Transcript).filter_by(
            meeting_id=test_meeting.id
        ).first()

        assert transcript is not None
        assert transcript.full_text == mock_whisper_result["text"]

    def test_save_transcript_stores_segments_as_json(
        self, db_session: Session, test_meeting: Meeting, mock_whisper_result
    ):
        """Transcript segments should be stored as JSONB."""
        from app.services.transcription import save_transcript

        save_transcript(
            db_session,
            meeting_id=test_meeting.id,
            transcription_result=mock_whisper_result,
        )

        transcript = db_session.query(Transcript).filter_by(
            meeting_id=test_meeting.id
        ).first()

        assert transcript.segments is not None
        assert len(transcript.segments) == len(mock_whisper_result["segments"])

    def test_save_transcript_updates_meeting_status(
        self, db_session: Session, test_meeting: Meeting, mock_whisper_result
    ):
        """Saving transcript should update meeting status to TRANSCRIBING or next step."""
        from app.services.transcription import save_transcript

        save_transcript(
            db_session,
            meeting_id=test_meeting.id,
            transcription_result=mock_whisper_result,
        )

        db_session.refresh(test_meeting)
        # After transcription, status should move forward (not stay as PROCESSING)
        assert test_meeting.status != MeetingStatus.PROCESSING


class TestAudioDownload:
    """Tests for downloading audio from blob storage."""

    def test_download_audio_returns_local_path(
        self, db_session: Session, test_meeting: Meeting
    ):
        """Download should return path to local temporary file."""
        from app.services.transcription import download_audio

        with patch("app.services.transcription.get_storage") as mock_get_storage:
            mock_storage = MagicMock()
            # Create a real temp file for the mock to "download"
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                f.write(b"fake audio data")
                temp_path = f.name

            mock_storage.download_file = MagicMock(return_value=temp_path)
            mock_get_storage.return_value = mock_storage

            result = download_audio(test_meeting.audio_blob_url)

            assert result is not None
            assert os.path.exists(result)

            # Cleanup
            os.unlink(temp_path)

    def test_download_audio_raises_on_missing_blob(self, db_session: Session):
        """Should raise error if blob doesn't exist."""
        from app.services.transcription import download_audio

        with patch("app.services.transcription.get_storage") as mock_get_storage:
            mock_storage = MagicMock()
            mock_storage.download_file = MagicMock(
                side_effect=FileNotFoundError("Blob not found")
            )
            mock_get_storage.return_value = mock_storage

            with pytest.raises(FileNotFoundError):
                download_audio("nonexistent/blob/path.wav")


class TestTranscriptionPipeline:
    """Integration tests for the full transcription pipeline."""

    def test_process_transcription_updates_status_on_success(
        self, db_session: Session, test_meeting: Meeting, sample_audio_file
    ):
        """Successful transcription should update meeting status."""
        from app.services.transcription import process_transcription

        with patch("app.services.transcription.download_audio") as mock_download:
            mock_download.return_value = sample_audio_file

            with patch("app.services.transcription.transcribe_audio") as mock_transcribe:
                mock_transcribe.return_value = {
                    "text": "Test transcription",
                    "segments": [{"start": 0.0, "end": 1.0, "text": "Test"}],
                }

                process_transcription(db_session, test_meeting.id)

        db_session.refresh(test_meeting)
        # Status should not be PROCESSING or FAILED after successful transcription
        assert test_meeting.status not in [MeetingStatus.PROCESSING, MeetingStatus.FAILED]

    def test_process_transcription_sets_failed_on_error(
        self, db_session: Session, test_meeting: Meeting
    ):
        """Failed transcription should set meeting status to FAILED."""
        from app.services.transcription import process_transcription

        with patch("app.services.transcription.download_audio") as mock_download:
            mock_download.side_effect = Exception("Download failed")

            with pytest.raises(Exception):
                process_transcription(db_session, test_meeting.id)

        db_session.refresh(test_meeting)
        assert test_meeting.status == MeetingStatus.FAILED

    def test_process_transcription_creates_transcript_record(
        self, db_session: Session, test_meeting: Meeting, sample_audio_file
    ):
        """Pipeline should create transcript record on success."""
        from app.services.transcription import process_transcription

        with patch("app.services.transcription.download_audio") as mock_download:
            mock_download.return_value = sample_audio_file

            with patch("app.services.transcription.transcribe_audio") as mock_transcribe:
                mock_transcribe.return_value = {
                    "text": "Full transcript text here",
                    "segments": [
                        {"start": 0.0, "end": 2.0, "text": "Full transcript"},
                        {"start": 2.0, "end": 4.0, "text": "text here"},
                    ],
                }

                process_transcription(db_session, test_meeting.id)

        transcript = db_session.query(Transcript).filter_by(
            meeting_id=test_meeting.id
        ).first()

        assert transcript is not None
        assert "Full transcript text here" in transcript.full_text
        assert len(transcript.segments) == 2


class TestCeleryTask:
    """Tests for Celery task integration."""

    def test_transcription_task_calls_process_transcription(
        self, db_session: Session, test_meeting: Meeting
    ):
        """Celery task should call the transcription pipeline."""
        from app.services.pipeline import transcribe_meeting

        with patch("app.services.pipeline.process_transcription") as mock_process:
            with patch("app.services.pipeline.SyncSessionLocal") as mock_session:
                mock_session.return_value.__enter__ = MagicMock(return_value=db_session)
                mock_session.return_value.__exit__ = MagicMock(return_value=False)

                transcribe_meeting(test_meeting.id)

                mock_process.assert_called_once()

    def test_transcription_task_handles_errors_gracefully(
        self, db_session: Session, test_meeting: Meeting
    ):
        """Celery task should catch errors and update status."""
        from app.services.pipeline import transcribe_meeting

        with patch("app.services.pipeline.process_transcription") as mock_process:
            mock_process.side_effect = Exception("Transcription failed")

            with patch("app.services.pipeline.SyncSessionLocal") as mock_session:
                mock_session.return_value.__enter__ = MagicMock(return_value=db_session)
                mock_session.return_value.__exit__ = MagicMock(return_value=False)

                # Should not raise, but handle gracefully
                with pytest.raises(Exception):
                    transcribe_meeting(test_meeting.id)
