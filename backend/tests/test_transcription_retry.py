"""Tests for guarded diarization retry behavior."""
from unittest.mock import patch

from sqlalchemy.orm import Session

from app.models import Meeting, Transcript


def test_transcribe_audio_accepts_speakers_expected(sample_audio_file):
    """AssemblyAI config should receive an exact speaker-count hint when provided."""
    from unittest.mock import MagicMock, Mock

    from app.services.transcription import transcribe_audio

    mock_transcript = Mock()
    mock_transcript.status = "completed"
    mock_transcript.text = "Hello. Hi."
    mock_transcript.utterances = [
        Mock(speaker="A", start=0, end=1000, text="Hello."),
        Mock(speaker="B", start=1000, end=2000, text="Hi."),
    ]
    mock_transcript.error = None

    with patch("app.services.transcription.get_assemblyai_client") as mock_aai:
        aai_module = MagicMock()
        aai_module.TranscriptionConfig.return_value = Mock()
        aai_module.Transcriber.return_value.transcribe.return_value = mock_transcript
        aai_module.TranscriptStatus.error = "error"
        mock_aai.return_value = aai_module

        transcribe_audio(sample_audio_file, speakers_expected=2)

    aai_module.TranscriptionConfig.assert_called_once_with(
        speaker_labels=True,
        language_code="en",
        speech_models=["universal-2"],
        speakers_expected=2,
    )


def test_process_transcription_retries_two_participant_under_detection(
    db_session: Session,
    test_meeting_with_participants: Meeting,
    sample_audio_file,
):
    """Two attendees with one detected speaker should retry with speakers_expected=2."""
    from app.services.transcription import process_transcription

    first_result = {
        "text": "One merged transcript",
        "segments": [
            {"speaker": "A", "start": 0.0, "end": 2.0, "text": "Joseph says hello."},
            {"speaker": "A", "start": 2.0, "end": 4.0, "text": "Daniel replies."},
        ],
        "speaker_identified": False,
    }
    retry_result = {
        "text": "Separated transcript",
        "segments": [
            {"speaker": "A", "start": 0.0, "end": 2.0, "text": "Joseph says hello."},
            {"speaker": "B", "start": 2.0, "end": 4.0, "text": "Daniel replies."},
        ],
        "speaker_identified": False,
    }

    with patch("app.services.transcription.download_audio", return_value=sample_audio_file), patch(
        "app.services.transcription.transcribe_audio",
        side_effect=[first_result, retry_result],
    ) as mock_transcribe:
        process_transcription(db_session, test_meeting_with_participants.id)

    assert mock_transcribe.call_count == 2
    assert mock_transcribe.call_args_list[0].kwargs.get("speakers_expected") is None
    assert mock_transcribe.call_args_list[1].kwargs["speakers_expected"] == 2

    transcript = db_session.query(Transcript).filter_by(
        meeting_id=test_meeting_with_participants.id
    ).one()
    db_session.refresh(test_meeting_with_participants)

    assert transcript.full_text == "Separated transcript"
    assert {segment["speaker"] for segment in transcript.segments} == {"A", "B"}
    diagnostics = test_meeting_with_participants.diarization_diagnostics
    assert diagnostics["detected_speaker_count"] == 2
    assert diagnostics["expected_speaker_count"] == 2
    assert diagnostics["diarization_retry_used"] is True
    assert diagnostics["diarization_retry_reason"] == "under_detection_retry_improved"


def test_process_transcription_keeps_original_when_retry_does_not_improve(
    db_session: Session,
    test_meeting_with_participants: Meeting,
    sample_audio_file,
):
    """A forced retry must not replace the original if it still detects one speaker."""
    from app.services.transcription import process_transcription

    first_result = {
        "text": "Original merged transcript",
        "segments": [{"speaker": "A", "start": 0.0, "end": 4.0, "text": "Merged."}],
        "speaker_identified": False,
    }
    retry_result = {
        "text": "Still merged transcript",
        "segments": [{"speaker": "A", "start": 0.0, "end": 4.0, "text": "Still merged."}],
        "speaker_identified": False,
    }

    with patch("app.services.transcription.download_audio", return_value=sample_audio_file), patch(
        "app.services.transcription.transcribe_audio",
        side_effect=[first_result, retry_result],
    ):
        process_transcription(db_session, test_meeting_with_participants.id)

    transcript = db_session.query(Transcript).filter_by(
        meeting_id=test_meeting_with_participants.id
    ).one()
    db_session.refresh(test_meeting_with_participants)

    assert transcript.full_text == "Original merged transcript"
    diagnostics = test_meeting_with_participants.diarization_diagnostics
    assert diagnostics["detected_speaker_count"] == 1
    assert diagnostics["expected_speaker_count"] == 2
    assert diagnostics["diarization_retry_used"] is False
    assert diagnostics["diarization_retry_reason"] == "retry_did_not_improve_speaker_count"


def test_process_transcription_keeps_original_when_retry_fails(
    db_session: Session,
    test_meeting_with_participants: Meeting,
    sample_audio_file,
):
    """Retry errors should not fail the whole meeting when the first transcript succeeded."""
    from app.services.transcription import process_transcription

    first_result = {
        "text": "Original merged transcript",
        "segments": [{"speaker": "A", "start": 0.0, "end": 4.0, "text": "Merged."}],
        "speaker_identified": False,
    }

    with patch("app.services.transcription.download_audio", return_value=sample_audio_file), patch(
        "app.services.transcription.transcribe_audio",
        side_effect=[first_result, RuntimeError("AssemblyAI retry failed")],
    ):
        process_transcription(db_session, test_meeting_with_participants.id)

    transcript = db_session.query(Transcript).filter_by(
        meeting_id=test_meeting_with_participants.id
    ).one()
    db_session.refresh(test_meeting_with_participants)

    assert transcript.full_text == "Original merged transcript"
    assert test_meeting_with_participants.status.value != "failed"
    diagnostics = test_meeting_with_participants.diarization_diagnostics
    assert diagnostics["detected_speaker_count"] == 1
    assert diagnostics["expected_speaker_count"] == 2
    assert diagnostics["diarization_retry_used"] is False
    assert diagnostics["diarization_retry_reason"] == "retry_failed"
