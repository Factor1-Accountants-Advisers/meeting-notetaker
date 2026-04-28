"""Speaker diarisation service — speaker label post-processing.

AssemblyAI handles the actual diarisation during transcription.
This module reconciles two independent speaker-identification signals:

1. AssemblyAI Speaker Identification (acoustic match against known names)
2. LLM context inference (semantic match using conversational cues)

Reconciliation rules per speaker:
- AssemblyAI assigned a name              -> use AssemblyAI's name (deterministic wins)
- AssemblyAI fell back to a cluster ID    -> use LLM's name if confident, else generic
- No signal from either                   -> keep "Speaker N" placeholder

The LLM ALWAYS runs (when candidates exist) so it can fill gaps where
AssemblyAI's acoustic match failed for some speakers but succeeded for
others.

Raw AssemblyAI labels are preserved on every segment as `raw_speaker`
for auditability.
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


def _classify_assemblyai_label(
    label: str,
    candidate_names_lower: set[str],
) -> Optional[str]:
    """Decide whether an AssemblyAI label is a real name or a cluster ID.

    Returns the canonical candidate display_name when the label matches
    one of the known participants (case-insensitive), else None.
    """
    if not label:
        return None
    if label.lower() in candidate_names_lower:
        return label
    return None


def process_diarisation(db: Session, meeting_id: int) -> Transcript:
    """Reconcile AssemblyAI + LLM speaker signals into final speaker labels.

    Steps:
    1. Build candidate pool from participants + identity hints
    2. Classify each unique input label: AssemblyAI-assigned name vs cluster ID
    3. Normalize all labels to "Speaker N" so the LLM sees a consistent format
    4. Run LLM inference on the normalized transcript (always, when candidates exist)
    5. Reconcile per speaker: AssemblyAI name wins; LLM fills gaps for cluster IDs
    6. Apply final names to segments; preserve raw AssemblyAI label as raw_speaker
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

        if not segments:
            transcript.segments = []
            db.commit()
            db.refresh(transcript)
            return transcript

        # Step 1: Candidate pool (best-effort — never aborts the pipeline)
        candidates: list = []
        participants = db.query(Participant).filter(
            Participant.meeting_id == meeting_id
        ).all()
        try:
            candidates = build_candidate_pool(participants, meeting.identity_hints)
        except Exception as e:
            logger.warning(
                f"Meeting {meeting_id}: candidate pool failed, "
                f"keeping generic labels: {e}"
            )

        candidate_names_lower = {
            (c.get("display_name") or "").lower()
            for c in candidates
            if c.get("display_name")
        }

        # Step 2: Classify each unique input label as named vs cluster ID,
        # in order of first appearance (preserves "Speaker 1 = first to speak")
        unique_labels: list[str] = []
        for seg in segments:
            label = seg.get("speaker", "Unknown")
            if label not in unique_labels:
                unique_labels.append(label)

        assemblyai_assignments: Dict[str, Optional[str]] = {
            label: _classify_assemblyai_label(label, candidate_names_lower)
            for label in unique_labels
        }

        # Step 3: Normalize input labels -> "Speaker N" for the LLM
        raw_to_generic: Dict[str, str] = {
            label: f"Speaker {i + 1}" for i, label in enumerate(unique_labels)
        }

        normalized_segments = []
        for seg in segments:
            new_seg = seg.copy()
            raw = seg.get("speaker", "Unknown")
            new_seg["raw_speaker"] = raw
            new_seg["speaker"] = raw_to_generic.get(raw, raw)
            normalized_segments.append(new_seg)

        # Step 4: Always run LLM inference when candidates are available
        llm_mapping: Dict[str, dict] = {}
        if candidates and normalized_segments:
            try:
                llm_mapping = infer_speaker_identities(normalized_segments, candidates)
                if llm_mapping:
                    logger.info(
                        f"Meeting {meeting_id}: LLM mapped {len(llm_mapping)} speakers"
                    )
            except Exception as e:
                logger.warning(
                    f"Meeting {meeting_id}: LLM inference failed, "
                    f"falling back to AssemblyAI signal only: {e}"
                )

        # Step 5: Reconcile signals per speaker
        # - AssemblyAI named wins over LLM (deterministic > probabilistic)
        # - LLM fills gaps where AssemblyAI fell back to a cluster ID
        final_speaker_names: Dict[str, str] = {}
        final_speaker_meta: Dict[str, dict] = {}
        for raw, generic in raw_to_generic.items():
            assemblyai_name = assemblyai_assignments[raw]
            llm_match = llm_mapping.get(generic)

            if assemblyai_name:
                final_speaker_names[generic] = assemblyai_name
                if llm_match and llm_match["display_name"].lower() != assemblyai_name.lower():
                    logger.info(
                        f"Meeting {meeting_id}: speaker '{generic}' kept as "
                        f"'{assemblyai_name}' (AssemblyAI); LLM suggested "
                        f"'{llm_match['display_name']}' (conf={llm_match['confidence']:.2f})"
                    )
            elif llm_match:
                final_speaker_names[generic] = llm_match["display_name"]
                final_speaker_meta[generic] = {
                    "matched_email": llm_match.get("email"),
                    "match_confidence": llm_match["confidence"],
                }
                logger.info(
                    f"Meeting {meeting_id}: speaker '{generic}' = "
                    f"'{llm_match['display_name']}' (LLM, conf={llm_match['confidence']:.2f})"
                )
            else:
                final_speaker_names[generic] = generic

        # Step 6: Apply final names
        final_segments = []
        for seg in normalized_segments:
            new_seg = seg.copy()
            generic = seg["speaker"]
            new_seg["speaker"] = final_speaker_names.get(generic, generic)
            meta = final_speaker_meta.get(generic)
            if meta:
                new_seg["matched_email"] = meta["matched_email"]
                new_seg["match_confidence"] = meta["match_confidence"]
            final_segments.append(new_seg)

        unique_speakers = {seg.get("speaker") for seg in final_segments}
        logger.info(f"Meeting {meeting_id}: {len(unique_speakers)} speakers detected")

        transcript.segments = final_segments
        db.commit()
        db.refresh(transcript)

        return transcript

    except Exception as e:
        logger.error(f"Diarisation failed for meeting {meeting_id}: {e}")
        meeting.status = MeetingStatus.FAILED
        db.commit()
        raise
