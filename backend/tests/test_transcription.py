"""Tests for transcription service.

Tests AssemblyAI-based transcription with speaker diarisation.
"""
import os
import tempfile
from datetime import datetime
from unittest.mock import MagicMock, patch, Mock

import pytest
from sqlalchemy.orm import Session

from app.models import Meeting, MeetingStatus, Transcript, User


class TestTranscriptionService:
    """Tests for the AssemblyAI transcription service."""

    def test_transcribe_audio_returns_segments(self, sample_audio_file):
        """Transcription should return text and speaker-labelled segments."""
        from app.services.transcription import transcribe_audio

        mock_utterances = [
            Mock(speaker="A", start=0, end=2500, text="Hello, this is a test."),
            Mock(speaker="B", start=3000, end=5000, text="Great, let's begin."),
        ]
        mock_transcript = Mock()
        mock_transcript.status = "completed"
        mock_transcript.text = "Hello, this is a test. Great, let's begin."
        mock_transcript.utterances = mock_utterances
        mock_transcript.error = None

        with patch("app.services.transcription.get_assemblyai_client") as mock_aai:
            aai_module = MagicMock()
            aai_module.TranscriptionConfig.return_value = Mock()
            aai_module.Transcriber.return_value.transcribe.return_value = mock_transcript
            aai_module.TranscriptStatus.error = "error"
            mock_aai.return_value = aai_module

            result = transcribe_audio(sample_audio_file)

        assert "text" in result
        assert "segments" in result
        assert len(result["segments"]) == 2
        aai_module.TranscriptionConfig.assert_called_once_with(
            speaker_labels=True,
            language_code="en",
            speech_models=["universal-2"],
        )

    def test_transcribe_audio_segments_have_required_fields(self, sample_audio_file):
        """Each segment should have speaker, start, end, and text fields."""
        from app.services.transcription import transcribe_audio

        mock_utterances = [
            Mock(speaker="A", start=0, end=2500, text="Hello."),
        ]
        mock_transcript = Mock()
        mock_transcript.status = "completed"
        mock_transcript.text = "Hello."
        mock_transcript.utterances = mock_utterances
        mock_transcript.error = None

        with patch("app.services.transcription.get_assemblyai_client") as mock_aai:
            aai_module = MagicMock()
            aai_module.TranscriptionConfig.return_value = Mock()
            aai_module.Transcriber.return_value.transcribe.return_value = mock_transcript
            aai_module.TranscriptStatus.error = "error"
            mock_aai.return_value = aai_module

            result = transcribe_audio(sample_audio_file)

        segment = result["segments"][0]
        assert "speaker" in segment
        assert "start" in segment
        assert "end" in segment
        assert "text" in segment
        assert isinstance(segment["start"], float)
        assert isinstance(segment["end"], float)

    def test_transcribe_audio_converts_ms_to_seconds(self, sample_audio_file):
        """AssemblyAI timestamps (ms) should be converted to seconds."""
        from app.services.transcription import transcribe_audio

        mock_utterances = [
            Mock(speaker="A", start=5000, end=10500, text="Test."),
        ]
        mock_transcript = Mock()
        mock_transcript.status = "completed"
        mock_transcript.text = "Test."
        mock_transcript.utterances = mock_utterances
        mock_transcript.error = None

        with patch("app.services.transcription.get_assemblyai_client") as mock_aai:
            aai_module = MagicMock()
            aai_module.TranscriptionConfig.return_value = Mock()
            aai_module.Transcriber.return_value.transcribe.return_value = mock_transcript
            aai_module.TranscriptStatus.error = "error"
            mock_aai.return_value = aai_module

            result = transcribe_audio(sample_audio_file)

        assert result["segments"][0]["start"] == 5.0
        assert result["segments"][0]["end"] == 10.5

    def test_transcribe_audio_handles_missing_file(self):
        """Should raise FileNotFoundError for missing audio files."""
        from app.services.transcription import transcribe_audio

        with pytest.raises(FileNotFoundError):
            transcribe_audio("/nonexistent/path/audio.wav")

    def test_transcribe_audio_handles_api_error(self, sample_audio_file):
        """Should raise ValueError when AssemblyAI returns an error."""
        from app.services.transcription import transcribe_audio

        mock_transcript = Mock()
        mock_transcript.status = "error"
        mock_transcript.error = "Audio file could not be processed"

        with patch("app.services.transcription.get_assemblyai_client") as mock_aai:
            aai_module = MagicMock()
            aai_module.TranscriptionConfig.return_value = Mock()
            aai_module.Transcriber.return_value.transcribe.return_value = mock_transcript
            aai_module.TranscriptStatus.error = "error"
            mock_aai.return_value = aai_module

            with pytest.raises(ValueError, match="AssemblyAI transcription failed"):
                transcribe_audio(sample_audio_file)


class TestTranscriptSaving:
    """Tests for saving transcripts to database."""

    def test_save_transcript_creates_record(
        self, db_session: Session, test_meeting: Meeting, mock_transcription_result
    ):
        """Saving transcript should create a Transcript record."""
        from app.services.transcription import save_transcript

        save_transcript(
            db_session,
            meeting_id=test_meeting.id,
            transcription_result=mock_transcription_result,
        )

        transcript = db_session.query(Transcript).filter_by(
            meeting_id=test_meeting.id
        ).first()

        assert transcript is not None
        assert transcript.full_text == mock_transcription_result["text"]

    def test_save_transcript_stores_segments_as_json(
        self, db_session: Session, test_meeting: Meeting, mock_transcription_result
    ):
        """Transcript segments should be stored as JSONB."""
        from app.services.transcription import save_transcript

        save_transcript(
            db_session,
            meeting_id=test_meeting.id,
            transcription_result=mock_transcription_result,
        )

        transcript = db_session.query(Transcript).filter_by(
            meeting_id=test_meeting.id
        ).first()

        assert transcript.segments is not None
        assert len(transcript.segments) == len(mock_transcription_result["segments"])

    def test_save_transcript_updates_meeting_status(
        self, db_session: Session, test_meeting: Meeting, mock_transcription_result
    ):
        """Saving transcript should update meeting status to TRANSCRIBING."""
        from app.services.transcription import save_transcript

        save_transcript(
            db_session,
            meeting_id=test_meeting.id,
            transcription_result=mock_transcription_result,
        )

        db_session.refresh(test_meeting)
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
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                f.write(b"fake audio data")
                temp_path = f.name

            mock_storage.download_file = MagicMock(return_value=temp_path)
            mock_get_storage.return_value = mock_storage

            result = download_audio(test_meeting.audio_blob_url)

            assert result is not None
            assert os.path.exists(result)

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
                    "segments": [{"speaker": "A", "start": 0.0, "end": 1.0, "text": "Test"}],
                }

                process_transcription(db_session, test_meeting.id)

        db_session.refresh(test_meeting)
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
        """Pipeline should create transcript record with speaker labels."""
        from app.services.transcription import process_transcription

        with patch("app.services.transcription.download_audio") as mock_download:
            mock_download.return_value = sample_audio_file

            with patch("app.services.transcription.transcribe_audio") as mock_transcribe:
                mock_transcribe.return_value = {
                    "text": "Full transcript text here",
                    "segments": [
                        {"speaker": "A", "start": 0.0, "end": 2.0, "text": "Full transcript"},
                        {"speaker": "B", "start": 2.0, "end": 4.0, "text": "text here"},
                    ],
                }

                process_transcription(db_session, test_meeting.id)

        transcript = db_session.query(Transcript).filter_by(
            meeting_id=test_meeting.id
        ).first()

        assert transcript is not None
        assert "Full transcript text here" in transcript.full_text
        assert len(transcript.segments) == 2
        assert transcript.segments[0]["speaker"] == "A"


class TestCeleryTask:
    """Tests for Celery task integration."""

    def test_transcription_task_calls_process_transcription(
        self, db_session: Session, test_meeting: Meeting
    ):
        """Celery task should call the transcription pipeline."""
        from app.services.pipeline import transcribe_meeting

        with patch("app.services.transcription.process_transcription") as mock_process:
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

        with patch("app.services.transcription.process_transcription") as mock_process:
            mock_process.side_effect = Exception("Transcription failed")

            with patch("app.services.pipeline.SyncSessionLocal") as mock_session:
                mock_session.return_value.__enter__ = MagicMock(return_value=db_session)
                mock_session.return_value.__exit__ = MagicMock(return_value=False)

                with pytest.raises(Exception):
                    transcribe_meeting(test_meeting.id)
