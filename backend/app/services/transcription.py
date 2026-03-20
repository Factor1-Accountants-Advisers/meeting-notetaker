"""Transcription service using OpenAI Whisper.

Handles:
1. Downloading audio from blob storage
2. Running Whisper transcription
3. Saving transcript to database
4. Updating meeting status

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

# Whisper model (lazy loaded)
_whisper_model = None


def get_whisper_model():
    """Get or load the Whisper model.

    Lazy loading to avoid loading model on import.
    """
    global _whisper_model
    if _whisper_model is None:
        import whisper
        model_name = settings.whisper_model
        logger.info(f"Loading Whisper model: {model_name}")
        _whisper_model = whisper.load_model(model_name)
        logger.info(f"Whisper model loaded successfully")
    return _whisper_model


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
    """Transcribe audio file using Whisper.

    Args:
        audio_path: Path to the local audio file

    Returns:
        Dictionary with 'text' and 'segments' keys

    Raises:
        FileNotFoundError: If audio file doesn't exist
        ValueError: If audio file is invalid
    """
    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    try:
        model = get_whisper_model()

        logger.info(f"Starting transcription: {audio_path}")
        result = model.transcribe(
            audio_path,
            language="en",  # Can be made configurable
            task="transcribe",
            verbose=False,
        )

        # Extract segments with required fields
        segments = []
        for seg in result.get("segments", []):
            segments.append({
                "start": float(seg["start"]),
                "end": float(seg["end"]),
                "text": seg["text"].strip(),
            })

        logger.info(f"Transcription complete: {len(segments)} segments")

        return {
            "text": result.get("text", "").strip(),
            "segments": segments,
        }

    except Exception as e:
        logger.error(f"Transcription failed: {type(e).__name__}")
        if "Invalid" in str(e) or "not a valid" in str(e).lower():
            raise ValueError(f"Invalid audio file: {audio_path}")
        raise


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

    Pipeline steps:
    1. Get meeting from database
    2. Download audio from blob storage
    3. Run Whisper transcription
    4. Save transcript to database
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

        # Transcribe
        logger.info(f"Transcribing meeting {meeting_id}")
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
