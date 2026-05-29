"""Speaker mapping service.

Persists mappings from raw transcript speaker labels to resolved identities and
maintains meeting-level speaker review diagnostics.
"""

import math
from typing import Any, cast

from sqlalchemy.orm import Session

from app.models import Meeting, SpeakerMapping, SpeakerMappingSource, Transcript

DEFAULT_REVIEW_CONFIDENCE_THRESHOLD = 0.7


def _normalize_optional_string(value: Any) -> str | None:
    """Return stripped string value, treating blank/None values as missing."""
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _mapping_has_identity(mapping: SpeakerMapping) -> bool:
    """Return True when a mapping resolves to a non-blank identity."""
    return bool(
        _normalize_optional_string(cast(Any, mapping).display_name)
        or _normalize_optional_string(cast(Any, mapping).email)
    )


def _normalize_proposed_mappings(proposed: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Validate and normalize proposed mapping payloads.

    Duplicate labels are deterministic: labels are normalized first and the last
    proposal for a label wins while preserving first-seen label order.
    """
    normalized_by_label: dict[str, dict[str, Any]] = {}

    for item in proposed:
        label = _normalize_optional_string(item.get("speaker_label"))
        if label is None:
            raise ValueError("speaker_label must be a non-blank string")

        raw_confidence = item.get("confidence")
        if raw_confidence is None:
            raw_confidence = 0.0
        if isinstance(raw_confidence, str) and not raw_confidence.strip():
            raise ValueError("confidence must be a number between 0.0 and 1.0")

        try:
            confidence = float(raw_confidence)
        except (TypeError, ValueError) as exc:
            raise ValueError("confidence must be a number between 0.0 and 1.0") from exc

        if not math.isfinite(confidence) or confidence < 0.0 or confidence > 1.0:
            raise ValueError("confidence must be between 0.0 and 1.0")

        normalized_by_label[label] = {
            "speaker_label": label,
            "display_name": _normalize_optional_string(item.get("display_name")),
            "email": _normalize_optional_string(item.get("email")),
            "confidence": confidence,
            "reason": _normalize_optional_string(item.get("reason")),
        }

    return list(normalized_by_label.values())


def extract_speaker_labels(segments: list[dict] | None) -> list[str]:
    """Return distinct non-empty speaker labels from transcript segments in order."""
    labels: list[str] = []
    for segment in segments or []:
        label = (segment.get("speaker") or "").strip()
        if label and label not in labels:
            labels.append(label)
    return labels


def calculate_mapping_quality(mappings: list[SpeakerMapping]) -> float | None:
    """Calculate average confidence for persisted speaker mappings."""
    if not mappings:
        return None
    return sum(float(cast(Any, m).confidence or 0.0) for m in mappings) / len(mappings)


def should_require_review(
    labels: list[str],
    mappings_by_label: dict[str, SpeakerMapping],
    threshold: float = DEFAULT_REVIEW_CONFIDENCE_THRESHOLD,
) -> bool:
    """Return True when any transcript speaker label is unmapped or low confidence."""
    for label in labels:
        mapping = mappings_by_label.get(label)
        if mapping is None or not _mapping_has_identity(mapping):
            return True
        if (
            cast(Any, mapping).source != SpeakerMappingSource.USER_CORRECTED
            and float(cast(Any, mapping).confidence or 0.0) < threshold
        ):
            return True
    return False


def refresh_speaker_mapping_diagnostics(
    db: Session,
    meeting: Meeting,
    threshold: float = DEFAULT_REVIEW_CONFIDENCE_THRESHOLD,
) -> None:
    """Refresh meeting speaker mapping quality, review flag, and diagnostics."""
    transcript = meeting.transcript
    if transcript is None and meeting.id is not None:
        transcript = (
            db.query(Transcript)
            .filter(Transcript.meeting_id == meeting.id)
            .one_or_none()
        )

    has_transcript = transcript is not None
    transcript_labels = extract_speaker_labels(cast(Any, transcript).segments if transcript else [])
    mappings = (
        db.query(SpeakerMapping)
        .filter(SpeakerMapping.meeting_id == meeting.id)
        .order_by(SpeakerMapping.speaker_label)
        .all()
    )
    current_label_set = set(transcript_labels)
    current_mappings = (
        [mapping for mapping in mappings if cast(Any, mapping).speaker_label in current_label_set]
        if has_transcript
        else mappings
    )
    mappings_by_label = {cast(Any, mapping).speaker_label: mapping for mapping in current_mappings}

    labels = transcript_labels if has_transcript else [cast(Any, mapping).speaker_label for mapping in current_mappings]
    mapped_labels = [
        label
        for label in labels
        if label in mappings_by_label and _mapping_has_identity(mappings_by_label[label])
    ]
    unmapped_labels = [
        label
        for label in labels
        if label not in mappings_by_label or not _mapping_has_identity(mappings_by_label[label])
    ]
    low_confidence_labels = [
        label
        for label in labels
        if label in mappings_by_label
        and _mapping_has_identity(mappings_by_label[label])
        and cast(Any, mappings_by_label[label]).source != SpeakerMappingSource.USER_CORRECTED
        and float(cast(Any, mappings_by_label[label]).confidence or 0.0) < threshold
    ]

    meeting.speaker_mapping_quality = calculate_mapping_quality(current_mappings)
    meeting.needs_speaker_review = should_require_review(labels, mappings_by_label, threshold)
    meeting.diarization_diagnostics = {
        "speaker_labels": labels,
        "mapped_speaker_labels": mapped_labels,
        "unmapped_speaker_labels": unmapped_labels,
        "low_confidence_speaker_labels": low_confidence_labels,
        "mapped_speaker_count": len(mapped_labels),
        "speaker_mapping_threshold": threshold,
    }


def upsert_speaker_mappings(
    db: Session,
    meeting: Meeting,
    proposed: list[dict[str, Any]],
    source: SpeakerMappingSource,
    preserve_user_corrected: bool = True,
) -> list[SpeakerMapping]:
    """Create or update speaker mappings for a meeting.

    User-corrected mappings are preserved by default when applying automated
    mapping sources. Meeting diagnostics are refreshed and the transaction is
    committed before returning saved mappings.
    """
    normalized = _normalize_proposed_mappings(proposed)
    saved: list[SpeakerMapping] = []

    try:
        existing = {
            cast(Any, m).speaker_label: m
            for m in db.query(SpeakerMapping)
            .filter(SpeakerMapping.meeting_id == meeting.id)
            .all()
        }

        for item in normalized:
            label = item["speaker_label"]
            mapping = existing.get(label)
            if (
                mapping
                and preserve_user_corrected
                and cast(Any, mapping).source == SpeakerMappingSource.USER_CORRECTED
                and source != SpeakerMappingSource.USER_CORRECTED
            ):
                saved.append(mapping)
                continue

            if mapping is None:
                mapping = SpeakerMapping(
                    meeting_id=meeting.id,
                    speaker_label=label,
                    source=source,
                )
                db.add(mapping)
                existing[label] = mapping

            mapping.display_name = item["display_name"]
            mapping.email = item["email"]
            mapping.confidence = item["confidence"]
            mapping.source = source
            mapping.reason = item["reason"]
            saved.append(mapping)

        db.flush()
        refresh_speaker_mapping_diagnostics(db, meeting)
        db.add(meeting)
        db.commit()
    except Exception:
        db.rollback()
        raise

    db.refresh(meeting)
    for mapping in saved:
        db.refresh(mapping)
    return saved
