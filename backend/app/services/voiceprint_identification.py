"""Apply pyannote voiceprint speaker identification to transcripts."""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Protocol, cast

from sqlalchemy.orm import Session

from app.models import Meeting, Transcript, Voiceprint
from app.services.voiceprint_registry import select_voiceprint_candidates_for_meeting

logger = logging.getLogger(__name__)

DEFAULT_CONFIDENCE_THRESHOLD = 0.7
MIN_OVERLAP_SECONDS = 0.25


class SpeakerIdentificationProvider(Protocol):
    """Provider contract for known-speaker identification on a meeting audio file."""

    def identify_speakers(
        self,
        audio_path: str | Path,
        *,
        voiceprints: list[dict[str, str]],
        num_speakers: int | None = None,
    ) -> list[dict[str, Any]]:
        """Return identity segments with start/end/display_name/email/confidence."""


def apply_voiceprint_identification(
    db: Session,
    *,
    meeting: Meeting,
    transcript: Transcript,
    local_audio_path: str | Path,
    provider: SpeakerIdentificationProvider,
    confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
) -> Transcript:
    """Run provider identification and merge identities into a transcript.

    This is best-effort. When no voiceprint candidates are available, it records
    diagnostics and leaves transcript segments untouched.
    """
    candidates = select_voiceprint_candidates_for_meeting(db, meeting)
    diagnostics = _diagnostics_dict(meeting)
    diagnostics["voiceprint_candidate_count"] = len(candidates)

    if not candidates:
        diagnostics["voiceprint_identification_enabled"] = False
        cast(Any, meeting).diarization_diagnostics = diagnostics
        db.add(meeting)
        db.commit()
        db.refresh(transcript)
        return transcript

    provider_payload = [_voiceprint_payload(candidate) for candidate in candidates]
    try:
        identity_segments = provider.identify_speakers(
            local_audio_path,
            voiceprints=provider_payload,
            num_speakers=None,
        )
    except Exception as exc:
        logger.warning(
            "Meeting %s: voiceprint identification failed; keeping transcript labels: %s",
            meeting.id,
            type(exc).__name__,
        )
        diagnostics["voiceprint_identification_enabled"] = False
        diagnostics["voiceprint_identification_error"] = type(exc).__name__
        cast(Any, meeting).diarization_diagnostics = diagnostics
        db.add(meeting)
        db.commit()
        db.refresh(transcript)
        return transcript

    merged_segments, merge_diagnostics = merge_identity_segments_into_transcript(
        cast(list[dict[str, Any]], transcript.segments or []),
        identity_segments,
        confidence_threshold=confidence_threshold,
    )
    diagnostics.update(merge_diagnostics)
    diagnostics["voiceprint_identity_segment_count"] = len(identity_segments)
    cast(Any, meeting).diarization_diagnostics = diagnostics
    transcript.segments = merged_segments
    transcript.speaker_identified = bool(merge_diagnostics["voiceprint_named_segment_count"])
    db.add(transcript)
    db.add(meeting)
    db.commit()
    db.refresh(transcript)
    return transcript


def merge_identity_segments_into_transcript(
    transcript_segments: list[dict[str, Any]],
    identity_segments: list[dict[str, Any]],
    *,
    confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Merge pyannote identity segments onto transcript segments by overlap.

    Wrong names are worse than unknowns: only high-confidence overlaps rewrite
    `speaker`. Lower confidence/absence leaves the original speaker label intact
    and marks the segment for review.
    """
    normalized_identities = [_normalize_identity(segment) for segment in identity_segments]
    merged: list[dict[str, Any]] = []
    named_count = 0
    low_confidence_count = 0
    unmatched_count = 0

    for segment in transcript_segments:
        new_segment = dict(segment)
        original_speaker = str(new_segment.get("speaker") or "Unknown")
        new_segment.setdefault("raw_speaker", original_speaker)

        best = _best_identity_for_segment(new_segment, normalized_identities)
        if best is None:
            unmatched_count += 1
            new_segment["speaker_review_required"] = True
            new_segment["speaker_review_reason"] = "no_voiceprint_match"
            merged.append(new_segment)
            continue

        if float(best["confidence"]) < confidence_threshold:
            low_confidence_count += 1
            new_segment["speaker_review_required"] = True
            new_segment["speaker_review_reason"] = "low_voiceprint_confidence"
            new_segment["voiceprint_candidate"] = best.get("display_name")
            new_segment["match_confidence"] = round(float(best["confidence"]), 4)
            merged.append(new_segment)
            continue

        display_name = best.get("display_name")
        if not display_name:
            unmatched_count += 1
            new_segment["speaker_review_required"] = True
            new_segment["speaker_review_reason"] = "voiceprint_missing_display_name"
            merged.append(new_segment)
            continue

        named_count += 1
        new_segment["speaker"] = display_name
        new_segment["matched_email"] = best.get("email")
        new_segment["match_confidence"] = round(float(best["confidence"]), 4)
        new_segment["speaker_source"] = "pyannote"
        new_segment["speaker_review_required"] = False
        merged.append(new_segment)

    diagnostics = {
        "voiceprint_identification_enabled": bool(identity_segments),
        "voiceprint_named_segment_count": named_count,
        "voiceprint_low_confidence_segment_count": low_confidence_count,
        "voiceprint_unmatched_segment_count": unmatched_count,
        "voiceprint_confidence_threshold": confidence_threshold,
    }
    return merged, diagnostics


def _voiceprint_payload(voiceprint: Voiceprint) -> dict[str, str]:
    return {
        "label": str(cast(Any, voiceprint).display_name),
        "voiceprint": str(cast(Any, voiceprint).provider_voiceprint_id),
        "email": str(cast(Any, voiceprint).email or ""),
    }


def _diagnostics_dict(meeting: Meeting) -> dict[str, Any]:
    current = cast(Any, meeting).diarization_diagnostics
    return dict(current) if isinstance(current, dict) else {}


def _normalize_identity(segment: dict[str, Any]) -> dict[str, Any]:
    confidence = segment.get("confidence", 0.0)
    if isinstance(confidence, (int, float)) and confidence > 1.0:
        confidence = float(confidence) / 100.0
    try:
        confidence = float(confidence)
    except (TypeError, ValueError):
        confidence = 0.0
    return {
        "start": float(segment.get("start", 0.0) or 0.0),
        "end": float(segment.get("end", 0.0) or 0.0),
        "display_name": segment.get("display_name") or segment.get("label") or segment.get("speaker"),
        "email": segment.get("email"),
        "confidence": max(0.0, min(1.0, confidence)),
    }


def _best_identity_for_segment(
    transcript_segment: dict[str, Any],
    identity_segments: list[dict[str, Any]],
) -> dict[str, Any] | None:
    start = float(transcript_segment.get("start", 0.0) or 0.0)
    end = float(transcript_segment.get("end", 0.0) or 0.0)
    duration = max(0.0, end - start)
    best: dict[str, Any] | None = None
    best_score = 0.0

    for identity in identity_segments:
        overlap = max(0.0, min(end, identity["end"]) - max(start, identity["start"]))
        if overlap < MIN_OVERLAP_SECONDS:
            continue
        overlap_ratio = overlap / duration if duration > 0 else 0.0
        score = overlap_ratio * float(identity["confidence"])
        if score > best_score:
            best = identity
            best_score = score

    return best
