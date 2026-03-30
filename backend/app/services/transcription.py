"""Transcription service using AssemblyAI.

Handles:
1. Downloading audio from blob storage
2. Uploading to AssemblyAI for transcription + speaker diarisation
3. Saving transcript to database
4. Updating meeting status

AssemblyAI performs transcription and speaker diarisation in a single API call,
eliminating the need for local Whisper and Pyannote models.

OWASP: No sensitive data logged, fail-closed on errors.
"""
import os
import logging
import tempfile
from typing import Dict, Any, List

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import Meeting, Transcript, MeetingStatus
from app.services.storage import get_storage

logger = logging.getLogger(__name__)


def get_assemblyai_client():
    """Configure and return the AssemblyAI module.

    Lazy import to avoid loading assemblyai on module import.
    """
    import assemblyai as aai
    aai.settings.api_key = settings.assemblyai_api_key
    return aai


def download_audio(blob_path: str) -> str:
    """Download audio file from blob storage to local temp file.

    Args:
        blob_path: Path to the audio file in blob storage

    Returns:
        Path to the downloaded local file

    Raises:
        FileNotFoundError: If blob doesn't exist
    """
    storage = get_storage()

    # Create temp directory for downloads
    temp_dir = tempfile.mkdtemp(prefix="meeting_audio_")
    filename = os.path.basename(blob_path)
    local_path = os.path.join(temp_dir, filename)

    try:
        # Download from storage
        downloaded_path = storage.download_file(blob_path, local_path)
        logger.info(f"Downloaded audio to: {local_path}")
        return downloaded_path
    except Exception as e:
        logger.error(f"Failed to download audio: {type(e).__name__}")
        raise FileNotFoundError(f"Could not download audio: {blob_path}")


def transcribe_audio(audio_path: str) -> Dict[str, Any]:
    """Transcribe audio file using AssemblyAI with speaker diarisation.

    Sends the audio to AssemblyAI's API which returns both the transcript
    and speaker labels in a single call.

    Args:
        audio_path: Path to the local audio file

    Returns:
        Dictionary with 'text' and 'segments' keys.
        Each segment has: speaker, start, end, text

    Raises:
        FileNotFoundError: If audio file doesn't exist
        ValueError: If transcription fails
    """
    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    aai = get_assemblyai_client()

    config = aai.TranscriptionConfig(
        speaker_labels=True,
        language_code="en",
        speech_models=["universal-2"],
    )

    transcriber = aai.Transcriber()

    logger.info(f"Starting AssemblyAI transcription: {audio_path}")
    transcript = transcriber.transcribe(audio_path, config=config)

    if transcript.status == aai.TranscriptStatus.error:
        raise ValueError(f"AssemblyAI transcription failed: {transcript.error}")

    # Build segments from utterances (speaker-labelled chunks)
    segments = []
    if transcript.utterances:
        for utterance in transcript.utterances:
            segments.append({
                "speaker": utterance.speaker,
                "start": utterance.start / 1000.0,  # ms -> seconds
                "end": utterance.end / 1000.0,
                "text": utterance.text.strip(),
            })

    logger.info(f"Transcription complete: {len(segments)} speaker segments")

    return {
        "text": transcript.text or "",
        "segments": segments,
    }


def save_transcript(
    db: Session,
    meeting_id: int,
    transcription_result: Dict[str, Any],
) -> Transcript:
    """Save transcription result to database.

    Args:
        db: Database session
        meeting_id: ID of the meeting
        transcription_result: Result from transcribe_audio()

    Returns:
        Created Transcript object
    """
    # Create transcript record
    transcript = Transcript(
        meeting_id=meeting_id,
        full_text=transcription_result["text"],
        segments=transcription_result["segments"],
    )

    db.add(transcript)

    # Update meeting status
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if meeting:
        meeting.status = MeetingStatus.TRANSCRIBING

    db.commit()
    db.refresh(transcript)

    logger.info(f"Saved transcript for meeting {meeting_id}")
    return transcript


def process_transcription(db: Session, meeting_id: int) -> Transcript:
    """Run the full transcription pipeline for a meeting.

    Uses AssemblyAI to transcribe audio with speaker diarisation
    in a single API call. No local ML models needed.

    Pipeline steps:
    1. Get meeting from database
    2. Download audio from blob storage
    3. Send to AssemblyAI (transcription + diarisation)
    4. Save transcript with speaker labels to database
    5. Update meeting status

    Args:
        db: Database session
        meeting_id: ID of the meeting to process

    Returns:
        Created Transcript object

    Raises:
        Exception: On any failure (meeting status set to FAILED)
    """
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()

    if not meeting:
        raise ValueError(f"Meeting not found: {meeting_id}")

    local_audio_path = None

    try:
        # Update status
        meeting.status = MeetingStatus.TRANSCRIBING
        db.commit()

        # Download audio
        logger.info(f"Downloading audio for meeting {meeting_id}")
        local_audio_path = download_audio(meeting.audio_blob_url)

        # Transcribe + diarise via AssemblyAI
        logger.info(f"Transcribing meeting {meeting_id} via AssemblyAI")
        transcription_result = transcribe_audio(local_audio_path)

        # Save results
        transcript = save_transcript(db, meeting_id, transcription_result)

        logger.info(f"Transcription pipeline complete for meeting {meeting_id}")
        return transcript

    except Exception as e:
        # Fail-closed: Set status to FAILED
        logger.error(f"Transcription pipeline failed for meeting {meeting_id}: {e}")
        meeting.status = MeetingStatus.FAILED
        db.commit()
        raise

    finally:
        # Cleanup temp file
        if local_audio_path and os.path.exists(local_audio_path):
            try:
                os.unlink(local_audio_path)
                # Also try to remove parent temp directory
                parent_dir = os.path.dirname(local_audio_path)
                if parent_dir.startswith(tempfile.gettempdir()):
                    os.rmdir(parent_dir)
            except Exception:
                pass  # Best effort cleanup
