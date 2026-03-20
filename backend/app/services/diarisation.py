"""Speaker diarisation service using Pyannote.

Handles:
1. Running Pyannote speaker diarisation on audio
2. Merging speaker labels with transcript segments by timestamp overlap
3. Updating transcript with speaker-labelled segments

OWASP: No sensitive data logged, fail-closed on errors.
Requires HF_TOKEN environment variable for Pyannote access.
"""
import os
import logging
from typing import Dict, Any, List, Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import Meeting, Transcript, MeetingStatus
from app.services.transcription import download_audio

logger = logging.getLogger(__name__)

# Pyannote pipeline (lazy loaded)
_diarisation_pipeline = None


def get_diarisation_pipeline():
    """Get or load the Pyannote diarisation pipeline.

    Lazy loading to avoid loading model on import.
    Requires HF_TOKEN environment variable.
    """
    global _diarisation_pipeline
    if _diarisation_pipeline is None:
        from pyannote.audio import Pipeline
        import torch

        hf_token = settings.hf_token
        if not hf_token:
            raise ValueError("HF_TOKEN environment variable required for Pyannote")

        logger.info("Loading Pyannote speaker-diarization-3.1 pipeline...")
        _diarisation_pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            use_auth_token=hf_token,
        )

        # Use GPU if available
        if torch.cuda.is_available():
            _diarisation_pipeline.to(torch.device("cuda"))
            logger.info("Pyannote pipeline loaded on GPU")
        else:
            logger.info("Pyannote pipeline loaded on CPU")

    return _diarisation_pipeline


def run_diarisation(audio_path: str) -> List[Dict[str, Any]]:
    """Run speaker diarisation on an audio file.

    Args:
        audio_path: Path to the local audio file

    Returns:
        List of speaker segments: [{"speaker": "SPEAKER_00", "start": 0.0, "end": 5.0}, ...]

    Raises:
        FileNotFoundError: If audio file doesn't exist
    """
    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    try:
        pipeline = get_diarisation_pipeline()

        logger.info(f"Starting diarisation: {audio_path}")
        diarisation = pipeline(audio_path)

        # Convert Pyannote output to our segment format
        segments = []
        for turn, _, speaker in diarisation.itertracks(yield_label=True):
            segments.append({
                "speaker": speaker,
                "start": float(turn.start),
                "end": float(turn.end),
            })

        logger.info(f"Diarisation complete: {len(segments)} speaker segments")
        return segments

    except Exception as e:
        logger.error(f"Diarisation failed: {type(e).__name__}")
        raise


def merge_speaker_segments(
    transcript_segments: List[Dict[str, Any]],
    speaker_segments: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Merge transcript segments with speaker labels.

    For each transcript segment, finds the speaker with the most
    overlap in the speaker segments.

    Args:
        transcript_segments: Whisper output with start, end, text
        speaker_segments: Pyannote output with speaker, start, end

    Returns:
        Merged segments with speaker, start, end, text
    """
    merged = []

    for tseg in transcript_segments:
        t_start = tseg["start"]
        t_end = tseg["end"]

        # Find speaker with most overlap
        best_speaker = "Unknown"
        best_overlap = 0.0

        for sseg in speaker_segments:
            s_start = sseg["start"]
            s_end = sseg["end"]

            # Calculate overlap
            overlap_start = max(t_start, s_start)
            overlap_end = min(t_end, s_end)
            overlap = max(0.0, overlap_end - overlap_start)

            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = sseg["speaker"]

        merged.append({
            "speaker": best_speaker,
            "start": t_start,
            "end": t_end,
            "text": tseg["text"],
        })

    return merged


def rename_speakers(
    segments: List[Dict[str, Any]],
    speaker_mapping: Optional[Dict[str, str]] = None,
) -> List[Dict[str, Any]]:
    """Rename speaker IDs to human-readable names.

    If speaker_mapping is provided, uses those names.
    Otherwise, converts SPEAKER_00 -> "Speaker 1", etc.

    Args:
        segments: Segments with speaker field
        speaker_mapping: Optional mapping of speaker IDs to names

    Returns:
        Segments with renamed speakers
    """
    if speaker_mapping is None:
        speaker_mapping = {}

    # Build auto-naming for speakers not in mapping
    seen_speakers = []
    for seg in segments:
        speaker = seg.get("speaker", "Unknown")
        if speaker not in seen_speakers and speaker != "Unknown":
            seen_speakers.append(speaker)

    # Create auto-names for speakers without mapping
    auto_mapping = {}
    for i, speaker in enumerate(seen_speakers):
        if speaker not in speaker_mapping:
            auto_mapping[speaker] = f"Speaker {i + 1}"

    # Merge mappings (explicit takes precedence)
    full_mapping = {**auto_mapping, **speaker_mapping}

    # Apply renaming
    renamed = []
    for seg in segments:
        new_seg = seg.copy()
        speaker = seg.get("speaker", "Unknown")
        if speaker in full_mapping:
            new_seg["speaker"] = full_mapping[speaker]
        renamed.append(new_seg)

    return renamed


def process_diarisation(db: Session, meeting_id: int) -> Transcript:
    """Run the full diarisation pipeline for a meeting.

    Pipeline steps:
    1. Get transcript from database
    2. Download audio from blob storage
    3. Run Pyannote diarisation
    4. Merge speaker labels with transcript segments
    5. Update transcript in database
    6. Update meeting status

    Args:
        db: Database session
        meeting_id: ID of the meeting to process

    Returns:
        Updated Transcript object

    Raises:
        ValueError: If transcript not found
        Exception: On any failure (meeting status set to FAILED)
    """
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()

    if not meeting:
        raise ValueError(f"Meeting not found: {meeting_id}")

    transcript = db.query(Transcript).filter(Transcript.meeting_id == meeting_id).first()

    if not transcript:
        raise ValueError(f"Transcript not found for meeting: {meeting_id}")

    local_audio_path = None

    try:
        # Update status
        meeting.status = MeetingStatus.DIARISING
        db.commit()

        # Download audio
        logger.info(f"Downloading audio for diarisation: meeting {meeting_id}")
        local_audio_path = download_audio(meeting.audio_blob_url)

        # Run diarisation
        logger.info(f"Running diarisation for meeting {meeting_id}")
        speaker_segments = run_diarisation(local_audio_path)

        # Merge speaker labels with transcript
        logger.info(f"Merging speaker labels for meeting {meeting_id}")
        merged_segments = merge_speaker_segments(
            transcript.segments or [],
            speaker_segments,
        )

        # Rename speakers to human-readable names
        # TODO: In future, could match against participant names
        final_segments = rename_speakers(merged_segments)

        # Update transcript
        transcript.segments = final_segments
        db.commit()
        db.refresh(transcript)

        logger.info(f"Diarisation pipeline complete for meeting {meeting_id}")
        return transcript

    except Exception as e:
        # Fail-closed: Set status to FAILED
        logger.error(f"Diarisation pipeline failed for meeting {meeting_id}: {e}")
        meeting.status = MeetingStatus.FAILED
        db.commit()
        raise

    finally:
        # Cleanup temp file
        if local_audio_path and os.path.exists(local_audio_path):
            try:
                os.unlink(local_audio_path)
                parent_dir = os.path.dirname(local_audio_path)
                if parent_dir.startswith("/tmp"):
                    os.rmdir(parent_dir)
            except Exception:
                pass  # Best effort cleanup
