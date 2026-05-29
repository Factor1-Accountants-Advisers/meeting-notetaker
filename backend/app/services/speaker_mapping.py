"""Speaker mapping service.

Persists mappings from raw transcript speaker labels to resolved identities and
maintains meeting-level speaker review diagnostics.
"""

from typing import Any, cast

from sqlalchemy.orm import Session

from app.models import Meeting, SpeakerMapping, SpeakerMappingSource, Transcript

DEFAULT_REVIEW_CONFIDENCE_THRESHOLD = 0.7


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
        if mapping is None:
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

    transcript_labels = extract_speaker_labels(cast(Any, transcript).segments if transcript else [])
    mappings = (
        db.query(SpeakerMapping)
        .filter(SpeakerMapping.meeting_id == meeting.id)
        .order_by(SpeakerMapping.speaker_label)
        .all()
    )
    mappings_by_label = {cast(Any, mapping).speaker_label: mapping for mapping in mappings}

    labels = transcript_labels or [cast(Any, mapping).speaker_label for mapping in mappings]
    mapped_labels = [label for label in labels if label in mappings_by_label]
    unmapped_labels = [label for label in labels if label not in mappings_by_label]
    low_confidence_labels = [
        label
        for label in labels
        if label in mappings_by_label
        and cast(Any, mappings_by_label[label]).source != SpeakerMappingSource.USER_CORRECTED
        and float(cast(Any, mappings_by_label[label]).confidence or 0.0) < threshold
    ]

    meeting.speaker_mapping_quality = calculate_mapping_quality(mappings)
    meeting.needs_speaker_review = should_require_review(labels, mappings_by_label, threshold)
    meeting.diarization_diagnostics = {
        "speaker_labels": labels,
        "mapped_speaker_labels": mapped_labels,
        "unmapped_speaker_labels": unmapped_labels,
        "low_confidence_speaker_labels": low_confidence_labels,
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
    existing = {
        cast(Any, m).speaker_label: m
        for m in db.query(SpeakerMapping)
        .filter(SpeakerMapping.meeting_id == meeting.id)
        .all()
    }
    saved: list[SpeakerMapping] = []

    for item in proposed:
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

        mapping.display_name = item.get("display_name")
        mapping.email = item.get("email")
        mapping.confidence = float(item.get("confidence") or 0.0)
        mapping.source = source
        mapping.reason = item.get("reason")
        saved.append(mapping)

    db.flush()
    refresh_speaker_mapping_diagnostics(db, meeting)
    db.add(meeting)
    db.commit()
    db.refresh(meeting)
    for mapping in saved:
        db.refresh(mapping)
    return saved
