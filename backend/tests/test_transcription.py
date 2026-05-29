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

    def test_save_transcript_updates_existing_record_on_rerun(
        self, db_session: Session, test_meeting: Meeting, mock_transcription_result
    ):
        """Saving transcript twice for one meeting should update, not insert a duplicate."""
        from app.services.transcription import save_transcript

        first = save_transcript(
            db_session,
            meeting_id=test_meeting.id,
            transcription_result=mock_transcription_result,
        )
        first_id = first.id

        updated_result = {
            "text": "Updated transcript text after retry",
            "segments": [
                {"speaker": "Melissa Hall", "start": 1.0, "end": 3.0, "text": "Updated text"}
            ],
            "speaker_identified": True,
        }

        second = save_transcript(
            db_session,
            meeting_id=test_meeting.id,
            transcription_result=updated_result,
        )

        transcripts = db_session.query(Transcript).filter_by(meeting_id=test_meeting.id).all()
        assert len(transcripts) == 1
        assert second.id == first_id
        assert transcripts[0].full_text == "Updated transcript text after retry"
        assert transcripts[0].segments == updated_result["segments"]
        assert transcripts[0].speaker_identified is True


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

    def test_process_transcription_rerun_updates_existing_transcript(
        self, db_session: Session, test_meeting: Meeting, sample_audio_file
    ):
        """Retrying the pipeline should update the existing transcript row cleanly."""
        from app.services.transcription import process_transcription

        first_result = {
            "text": "First transcript",
            "segments": [{"speaker": "A", "start": 0.0, "end": 1.0, "text": "First"}],
            "speaker_identified": False,
        }
        retry_result = {
            "text": "Retry transcript with corrected output",
            "segments": [{"speaker": "B", "start": 1.0, "end": 2.0, "text": "Retry"}],
            "speaker_identified": True,
        }

        with patch("app.services.transcription.download_audio", return_value=sample_audio_file), patch(
            "app.services.transcription.transcribe_audio",
            side_effect=[first_result, retry_result],
        ):
            first = process_transcription(db_session, test_meeting.id)
            first_id = first.id
            second = process_transcription(db_session, test_meeting.id)

        transcripts = db_session.query(Transcript).filter_by(meeting_id=test_meeting.id).all()
        assert len(transcripts) == 1
        assert second.id == first_id
        assert transcripts[0].full_text == "Retry transcript with corrected output"
        assert transcripts[0].segments == retry_result["segments"]
        assert transcripts[0].speaker_identified is True

    def test_process_transcription_marks_generic_speakers_for_review_without_rewriting_segments(
        self, db_session: Session, test_meeting_with_participants: Meeting, sample_audio_file
    ):
        """Generic diarization labels should produce diagnostics and require review."""
        from app.services.transcription import process_transcription

        original_segments = [
            {"speaker": "A", "start": 0.0, "end": 2.0, "text": "Full transcript"},
            {"speaker": "B", "start": 2.0, "end": 4.0, "text": "text here"},
            {"speaker": "A", "start": 4.0, "end": 5.0, "text": "again"},
        ]

        with patch("app.services.transcription.download_audio") as mock_download:
            mock_download.return_value = sample_audio_file

            with patch("app.services.transcription.transcribe_audio") as mock_transcribe:
                mock_transcribe.return_value = {
                    "text": "Full transcript text here again",
                    "segments": original_segments,
                    "speaker_identified": False,
                }

                process_transcription(db_session, test_meeting_with_participants.id)

        transcript = db_session.query(Transcript).filter_by(
            meeting_id=test_meeting_with_participants.id
        ).one()
        db_session.refresh(test_meeting_with_participants)

        assert test_meeting_with_participants.needs_speaker_review is True
        assert test_meeting_with_participants.diarization_diagnostics["detected_speaker_count"] == 2
        assert transcript.segments == original_segments

    def test_process_transcription_does_not_auto_map_duplicate_candidate_display_names(
        self, db_session: Session, test_meeting_with_participants: Meeting, sample_audio_file
    ):
        """An AssemblyAI name label matching duplicate candidate names is ambiguous and needs review."""
        from app.models import Participant, SpeakerMapping
        from app.services.transcription import process_transcription

        db_session.add(
            Participant(
                meeting_id=test_meeting_with_participants.id,
                name="Melissa Hall",
                email="duplicate-melissa@example.com",
                is_organizer=False,
            )
        )
        db_session.commit()

        segments = [
            {"speaker": "Melissa Hall", "start": 0.0, "end": 2.0, "text": "Ambiguous name"}
        ]

        with patch("app.services.transcription.download_audio", return_value=sample_audio_file), patch(
            "app.services.transcription.transcribe_audio",
            return_value={
                "text": "Ambiguous name",
                "segments": segments,
                "speaker_identified": True,
            },
        ):
            process_transcription(db_session, test_meeting_with_participants.id)

        mappings = db_session.query(SpeakerMapping).filter_by(
            meeting_id=test_meeting_with_participants.id,
            speaker_label="Melissa Hall",
        ).all()
        db_session.refresh(test_meeting_with_participants)

        assert mappings == []
        assert test_meeting_with_participants.needs_speaker_review is True
        assert test_meeting_with_participants.diarization_diagnostics["unmapped_speaker_labels"] == ["Melissa Hall"]

    def test_process_transcription_includes_organizer_and_user_names(
        self, db_session: Session, test_meeting_with_participants: Meeting, sample_audio_file
    ):
        """Should pass organizer and current user names to AssemblyAI."""
        from app.services.transcription import process_transcription

        with patch("app.services.transcription.download_audio") as mock_download:
            mock_download.return_value = sample_audio_file

            with patch("app.services.transcription.transcribe_audio") as mock_transcribe:
                mock_transcribe.return_value = {
                    "text": "Test",
                    "segments": [{"speaker": "A", "start": 0.0, "end": 1.0, "text": "Test"}],
                    "speaker_identified": False,
                }

                process_transcription(db_session, test_meeting_with_participants.id)

                # Verify name pool includes organizer and current user
                names = mock_transcribe.call_args.kwargs.get("participant_names", [])
                assert "Melissa Hall" in names
                assert "Test User" in names


    def test_process_transcription_includes_organizer_and_current_user_from_identity_hints(
        self, db_session: Session, test_user: User, sample_audio_file
    ):
        """Should add organizer and current_user names from identity_hints to the AssemblyAI name pool, even when they are not in the Participant table."""
        from app.models import Meeting, MeetingStatus, Participant
        from app.services.transcription import process_transcription
        from datetime import datetime

        # Create a meeting whose identity_hints reference names that are NOT in the participants table
        meeting = Meeting(
            title="Identity Hints Enrichment Test",
            scheduled_time=datetime.utcnow(),
            status=MeetingStatus.PROCESSING,
            audio_blob_url="audio/2026/04/06/identity_hints_test.wav",
            user_id=test_user.id,
            identity_hints={
                "current_user": {
                    "name": "Outside Recorder",
                    "email": "recorder@external.example.com",
                    "is_current_user": True,
                },
                "organizer": {
                    "name": "Outside Organizer",
                    "email": "organizer@external.example.com",
                    "is_organizer": True,
                },
                "source_event_id": "evt-strong-test",
            },
        )
        db_session.add(meeting)
        db_session.flush()

        # Add ONE participant who is NEITHER the organizer NOR the current user
        only_participant = Participant(
            meeting_id=meeting.id,
            name="Other Attendee",
            email="other@example.com",
            is_organizer=False,
        )
        db_session.add(only_participant)
        db_session.commit()
        db_session.refresh(meeting)

        with patch("app.services.transcription.download_audio") as mock_download:
            mock_download.return_value = sample_audio_file

            with patch("app.services.transcription.transcribe_audio") as mock_transcribe:
                mock_transcribe.return_value = {
                    "text": "Test",
                    "segments": [{"speaker": "A", "start": 0.0, "end": 1.0, "text": "Test"}],
                    "speaker_identified": False,
                }

                process_transcription(db_session, meeting.id)

                names = mock_transcribe.call_args.kwargs.get("participant_names", [])

                # The participant must still be there
                assert "Other Attendee" in names, f"Expected 'Other Attendee' in {names}"

                # These can ONLY come from identity_hints enrichment — they are not Participants
                assert "Outside Organizer" in names, f"Expected 'Outside Organizer' in {names}"
                assert "Outside Recorder" in names, f"Expected 'Outside Recorder' in {names}"

    def test_process_transcription_survives_malformed_identity_hints(
        self, db_session: Session, test_user: User, sample_audio_file
    ):
        """Malformed identity_hints (non-dict shape) must NOT abort transcription.

        The JSON column has no schema enforcement on its internal shape, so a
        list/string/garbage value could appear. The enrichment must degrade
        gracefully and let transcription continue with the participant-only name pool.
        """
        from app.models import Meeting, MeetingStatus, Participant
        from app.services.transcription import process_transcription
        from datetime import datetime

        meeting = Meeting(
            title="Malformed Hints Test",
            scheduled_time=datetime.utcnow(),
            status=MeetingStatus.PROCESSING,
            audio_blob_url="audio/2026/04/06/malformed_hints.wav",
            user_id=test_user.id,
            # Garbage shape — not a dict. Could be a stringified value, an array, anything.
            identity_hints=["not", "a", "dict"],
        )
        db_session.add(meeting)
        db_session.flush()

        participant = Participant(
            meeting_id=meeting.id,
            name="Real Attendee",
            email="real@example.com",
            is_organizer=False,
        )
        db_session.add(participant)
        db_session.commit()
        db_session.refresh(meeting)

        with patch("app.services.transcription.download_audio") as mock_download:
            mock_download.return_value = sample_audio_file

            with patch("app.services.transcription.transcribe_audio") as mock_transcribe:
                mock_transcribe.return_value = {
                    "text": "Test",
                    "segments": [{"speaker": "A", "start": 0.0, "end": 1.0, "text": "Test"}],
                    "speaker_identified": False,
                }

                # Must not raise — pipeline continues, status does not become FAILED.
                process_transcription(db_session, meeting.id)

                names = mock_transcribe.call_args.kwargs.get("participant_names", [])
                assert names == ["Real Attendee"], (
                    f"Expected only the participant name, got {names}"
                )

        db_session.refresh(meeting)
        assert meeting.status != MeetingStatus.FAILED


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
