"""Speaker diarisation service — speaker label post-processing.

AssemblyAI handles the actual diarisation during transcription.
This module handles:
1. Renaming generic speaker labels (A, B, C) to human-readable names
2. Updating the transcript in the database

OWASP: No sensitive data logged, fail-closed on errors.
"""
import logging
from typing import Dict, Any, List, Optional

from sqlalchemy.orm import Session

from app.models import Meeting, Transcript, MeetingStatus

logger = logging.getLogger(__name__)


def rename_speakers(
    segments: List[Dict[str, Any]],
    speaker_mapping: Optional[Dict[str, str]] = None,
) -> List[Dict[str, Any]]:
    """Rename speaker IDs to human-readable names.

    If speaker_mapping is provided, uses those names.
    Otherwise, converts "A" -> "Speaker 1", "B" -> "Speaker 2", etc.

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
    """Post-process speaker labels on an existing transcript.

    Since AssemblyAI provides speaker labels during transcription,
    this step just renames generic labels (A, B, C) to
    human-readable names (Speaker 1, Speaker 2, etc.).

    Args:
        db: Database session
        meeting_id: ID of the meeting to process

    Returns:
        Updated Transcript object

    Raises:
        ValueError: If meeting or transcript not found
        Exception: On any failure (meeting status set to FAILED)
    """
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()

    if not meeting:
        raise ValueError(f"Meeting not found: {meeting_id}")

    transcript = db.query(Transcript).filter(Transcript.meeting_id == meeting_id).first()

    if not transcript:
        raise ValueError(f"Transcript not found for meeting: {meeting_id}")

    try:
        # Update status
        meeting.status = MeetingStatus.DIARISING
        db.commit()

        # Rename speakers to human-readable names
        logger.info(f"Renaming speaker labels for meeting {meeting_id}")
        final_segments = rename_speakers(transcript.segments or [])

        # Count unique speakers
        speakers = {seg.get("speaker") for seg in final_segments}
        logger.info(f"Meeting {meeting_id}: {len(speakers)} speakers detected")

        # Update transcript
        transcript.segments = final_segments
        db.commit()
        db.refresh(transcript)

        logger.info(f"Diarisation post-processing complete for meeting {meeting_id}")
        return transcript

    except Exception as e:
        # Fail-closed: Set status to FAILED
        logger.error(f"Diarisation post-processing failed for meeting {meeting_id}: {e}")
        meeting.status = MeetingStatus.FAILED
        db.commit()
        raise
