"""Speaker diarisation service — speaker label post-processing.

AssemblyAI handles the actual diarisation during transcription.
This module handles:
1. Renaming generic speaker labels (A, B, C) to human-readable names
2. LLM-based speaker inference to map generic labels to real participants
3. Preserving raw speaker IDs for auditability
"""
import logging
from typing import Dict, Any, List, Optional

from sqlalchemy.orm import Session

from app.models import Meeting, Participant, Transcript, MeetingStatus
from app.services.speaker_inference import build_candidate_pool, infer_speaker_identities

logger = logging.getLogger(__name__)


def rename_speakers(
    segments: List[Dict[str, Any]],
    speaker_mapping: Optional[Dict[str, str]] = None,
) -> List[Dict[str, Any]]:
    """Rename speaker IDs to human-readable names.

    If speaker_mapping is provided, uses those names.
    Otherwise, converts "A" -> "Speaker 1", "B" -> "Speaker 2", etc.
    """
    if speaker_mapping is None:
        speaker_mapping = {}

    seen_speakers = []
    for seg in segments:
        speaker = seg.get("speaker", "Unknown")
        if speaker not in seen_speakers and speaker != "Unknown":
            seen_speakers.append(speaker)

    auto_mapping = {}
    for i, speaker in enumerate(seen_speakers):
        if speaker not in speaker_mapping:
            auto_mapping[speaker] = f"Speaker {i + 1}"

    full_mapping = {**auto_mapping, **speaker_mapping}

    renamed = []
    for seg in segments:
        new_seg = seg.copy()
        speaker = seg.get("speaker", "Unknown")
        new_seg["raw_speaker"] = speaker  # Preserve original
        if speaker in full_mapping:
            new_seg["speaker"] = full_mapping[speaker]
        renamed.append(new_seg)

    return renamed


def process_diarisation(db: Session, meeting_id: int) -> Transcript:
    """Post-process speaker labels with identity-aware matching.

    Steps:
    1. Rename generic labels (A, B) to Speaker 1, Speaker 2
    2. If identity hints exist, run LLM inference to map speakers to real names
    3. Apply confident mappings; keep Speaker N for uncertain matches
    4. Preserve raw_speaker on every segment
    """
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if not meeting:
        raise ValueError(f"Meeting not found: {meeting_id}")

    transcript = db.query(Transcript).filter(
        Transcript.meeting_id == meeting_id
    ).first()
    if not transcript:
        raise ValueError(f"Transcript not found for meeting: {meeting_id}")

    try:
        meeting.status = MeetingStatus.DIARISING
        db.commit()

        segments = transcript.segments or []

        if transcript.speaker_identified:
            # AssemblyAI already mapped to real names
            logger.info(f"Meeting {meeting_id}: AssemblyAI speaker ID used, skipping rename")
            final_segments = [
                {**seg, "raw_speaker": seg.get("raw_speaker", seg.get("speaker", "Unknown"))}
                for seg in segments
            ]
        else:
            # Step 1: Generic rename (A → Speaker 1, B → Speaker 2)
            final_segments = rename_speakers(segments)

            # Step 2: LLM inference if we have identity context
            participants = db.query(Participant).filter(
                Participant.meeting_id == meeting_id
            ).all()

            candidates = build_candidate_pool(participants, meeting.identity_hints)

            if candidates and final_segments:
                try:
                    speaker_mapping = infer_speaker_identities(final_segments, candidates)

                    if speaker_mapping:
                        logger.info(
                            f"Meeting {meeting_id}: LLM mapped {len(speaker_mapping)} speakers"
                        )
                        for seg in final_segments:
                            match = speaker_mapping.get(seg["speaker"])
                            if match:
                                seg["speaker"] = match["display_name"]
                                seg["matched_email"] = match.get("email")
                                seg["match_confidence"] = match["confidence"]
                except Exception as e:
                    logger.warning(
                        f"Meeting {meeting_id}: speaker inference failed, "
                        f"keeping generic labels: {e}"
                    )

        speakers = {seg.get("speaker") for seg in final_segments}
        logger.info(f"Meeting {meeting_id}: {len(speakers)} speakers: {speakers}")

        transcript.segments = final_segments
        db.commit()
        db.refresh(transcript)

        return transcript

    except Exception as e:
        logger.error(f"Diarisation failed for meeting {meeting_id}: {e}")
        meeting.status = MeetingStatus.FAILED
        db.commit()
        raise
