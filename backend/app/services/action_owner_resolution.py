"""Action item owner resolution service.

Resolves action item owner metadata from speaker mappings, meeting identity
candidates, and owner text extracted by the summarisation LLM.
"""

import math
from typing import Any, cast

from sqlalchemy.orm import Session

from app.models import ActionItem, ActionOwnerSource, Meeting, SpeakerMapping
from app.services.identity_candidates import build_candidate_pool

EXPLICIT_NAME_MATCH_CONFIDENCE = 0.8
LLM_EXTRACTION_CONFIDENCE = 0.5
AMBIGUOUS_CANDIDATE_CONFIDENCE = 0.4
SPEAKER_LABEL_REASON_PREFIX = "speaker_label="
UNASSIGNED_OWNER_TOKENS = {
    "",
    "unknown",
    "unassigned",
    "none",
    "no one",
    "nobody",
    "not assigned",
    "not specified",
    "n/a",
    "na",
    "null",
    "tbd",
    "to be determined",
}


def _normalize_optional_string(value: Any) -> str | None:
    """Return stripped string value, treating blank/None values as missing."""
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _normalize_match_key(value: Any) -> str:
    """Return a normalized key for exact case-insensitive name/label matching."""
    normalized = _normalize_optional_string(value)
    return normalized.casefold() if normalized is not None else ""


def _is_unassigned_owner(value: str | None) -> bool:
    """Return True when extracted owner text means no actionable assignee."""
    return _normalize_match_key(value) in UNASSIGNED_OWNER_TOKENS


def _mapping_has_display_name(mapping: SpeakerMapping) -> bool:
    """Return True when a speaker mapping has a usable display name."""
    return _normalize_optional_string(cast(Any, mapping).display_name) is not None


def _bounded_confidence(value: Any) -> float:
    """Return a finite confidence value clamped to the supported 0..1 range."""
    try:
        confidence = float(value if value is not None else 0.0)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(confidence):
        return 0.0
    return min(1.0, max(0.0, confidence))


def _speaker_label_from_mapping(mapping: SpeakerMapping, fallback: str) -> str:
    """Return the canonical speaker label for a mapping when available."""
    return _normalize_optional_string(cast(Any, mapping).speaker_label) or fallback


def _lookup_mapping(
    mappings_by_label: dict[str, SpeakerMapping],
    speaker_label: str | None,
) -> tuple[str, SpeakerMapping] | None:
    """Find a speaker mapping by label using trimmed, case-insensitive matching."""
    normalized_label = _normalize_optional_string(speaker_label)
    if normalized_label is None:
        return None

    mapping = mappings_by_label.get(normalized_label)
    if mapping is not None:
        return (_speaker_label_from_mapping(mapping, normalized_label), mapping)

    label_key = _normalize_match_key(normalized_label)
    for candidate_label, candidate_mapping in mappings_by_label.items():
        mapping_label = _speaker_label_from_mapping(candidate_mapping, str(candidate_label))
        if _normalize_match_key(mapping_label) == label_key:
            return (mapping_label, candidate_mapping)
        if _normalize_match_key(candidate_label) == label_key:
            return (mapping_label, candidate_mapping)
    return None


def _source_speaker_label_from_reason(owner_reason: str | None) -> str | None:
    """Recover the source speaker label stored in an owner reason prefix."""
    normalized_reason = _normalize_optional_string(owner_reason)
    if normalized_reason is None or not normalized_reason.startswith(
        SPEAKER_LABEL_REASON_PREFIX
    ):
        return None
    source_label = normalized_reason[len(SPEAKER_LABEL_REASON_PREFIX) :].split(";", 1)[
        0
    ]
    return _normalize_optional_string(source_label)


def _result(
    owner_name: str | None,
    owner_email: str | None,
    owner_confidence: float,
    owner_source: ActionOwnerSource,
    owner_reason: str,
) -> dict[str, Any]:
    """Build a normalized owner resolution payload."""
    return {
        "owner_name": owner_name,
        "owner_email": owner_email,
        "owner_confidence": owner_confidence,
        "owner_source": owner_source,
        "owner_reason": owner_reason,
    }


def _resolve_from_mapping(
    speaker_label: str,
    mapping: SpeakerMapping,
) -> dict[str, Any]:
    """Build a resolution payload from a speaker mapping."""
    return _result(
        owner_name=_normalize_optional_string(cast(Any, mapping).display_name),
        owner_email=_normalize_optional_string(cast(Any, mapping).email),
        owner_confidence=_bounded_confidence(cast(Any, mapping).confidence),
        owner_source=ActionOwnerSource.SPEAKER_MAPPING,
        owner_reason=(
            f"{SPEAKER_LABEL_REASON_PREFIX}{speaker_label}; "
            f"Resolved from speaker mapping for {speaker_label}"
        ),
    )


def _candidate_display_name(candidate: dict[str, Any]) -> str | None:
    """Return a candidate display name from supported candidate shapes."""
    return _normalize_optional_string(
        candidate.get("display_name")
        if candidate.get("display_name") is not None
        else candidate.get("name")
    )


def _candidate_email(candidate: dict[str, Any]) -> str | None:
    """Return a normalized candidate email."""
    return _normalize_optional_string(candidate.get("email"))


def resolve_action_owner(
    extracted_owner: str | None,
    speaker_label: str | None,
    candidates: list[dict[str, Any]],
    mappings_by_label: dict[str, SpeakerMapping],
) -> dict[str, Any]:
    """Resolve owner metadata for one action item.

    Resolution precedence:
    1. Speaker label mapping with a display name.
    2. Extracted owner text that itself matches a speaker label mapping.
    3. Exact case-insensitive match against identity candidate display names.
    4. Preserve non-empty/non-unknown LLM owner text as name-only.
    5. Unassigned.
    """
    normalized_speaker_label = _normalize_optional_string(speaker_label)
    if normalized_speaker_label is not None:
        mapping_match = _lookup_mapping(mappings_by_label, normalized_speaker_label)
        if mapping_match is not None:
            matched_label, mapping = mapping_match
            if _mapping_has_display_name(mapping):
                return _resolve_from_mapping(matched_label, mapping)

    normalized_owner = _normalize_optional_string(extracted_owner)
    if normalized_owner is not None:
        mapping_match = _lookup_mapping(mappings_by_label, normalized_owner)
        if mapping_match is not None:
            matched_label, mapping = mapping_match
            if _mapping_has_display_name(mapping):
                return _resolve_from_mapping(matched_label, mapping)

    if normalized_owner is not None and not _is_unassigned_owner(normalized_owner):
        owner_key = _normalize_match_key(normalized_owner)

        email_matches = [
            candidate
            for candidate in candidates
            if _candidate_email(candidate) is not None
            and _normalize_match_key(_candidate_email(candidate)) == owner_key
        ]
        if email_matches:
            candidate = email_matches[0]
            display_name = _candidate_display_name(candidate)
            return _result(
                owner_name=display_name,
                owner_email=_candidate_email(candidate),
                owner_confidence=EXPLICIT_NAME_MATCH_CONFIDENCE,
                owner_source=ActionOwnerSource.EXPLICIT_NAME_MATCH,
                owner_reason="Exact case-insensitive match to participant/candidate email",
            )

        display_name_matches = [
            candidate
            for candidate in candidates
            if _candidate_display_name(candidate) is not None
            and _normalize_match_key(_candidate_display_name(candidate)) == owner_key
        ]
        matching_emails = [
            _normalize_match_key(_candidate_email(candidate))
            for candidate in display_name_matches
        ]
        has_single_shared_non_empty_email = (
            len(set(matching_emails)) == 1 and matching_emails[0] != ""
        )
        if len(display_name_matches) > 1 and not has_single_shared_non_empty_email:
            return _result(
                owner_name=normalized_owner,
                owner_email=None,
                owner_confidence=AMBIGUOUS_CANDIDATE_CONFIDENCE,
                owner_source=ActionOwnerSource.LLM_EXTRACTION,
                owner_reason=(
                    "Ambiguous duplicate candidate name without one shared email; "
                    "preserved LLM owner text"
                ),
            )

        if display_name_matches:
            candidate = display_name_matches[0]
            display_name = _candidate_display_name(candidate)
            return _result(
                owner_name=display_name,
                owner_email=_candidate_email(candidate),
                owner_confidence=EXPLICIT_NAME_MATCH_CONFIDENCE,
                owner_source=ActionOwnerSource.EXPLICIT_NAME_MATCH,
                owner_reason="Exact case-insensitive match to participant/candidate name",
            )

        return _result(
            owner_name=normalized_owner,
            owner_email=None,
            owner_confidence=LLM_EXTRACTION_CONFIDENCE,
            owner_source=ActionOwnerSource.LLM_EXTRACTION,
            owner_reason="Preserved owner text from LLM extraction; no matching candidate found",
        )

    return _result(
        owner_name=None,
        owner_email=None,
        owner_confidence=0.0,
        owner_source=ActionOwnerSource.UNASSIGNED,
        owner_reason="No actionable owner extracted",
    )


def resolve_action_item_owners_for_meeting(db: Session, meeting_id: int) -> list[ActionItem]:
    """Resolve and persist owner metadata for action items in a meeting.

    User-corrected owner assignments are never overwritten. All other action
    items are updated in a single transaction and returned in id order.
    """
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).one_or_none()
    if meeting is None:
        raise ValueError(f"Meeting {meeting_id} not found")

    action_items = (
        db.query(ActionItem)
        .filter(ActionItem.meeting_id == meeting_id)
        .order_by(ActionItem.id)
        .all()
    )
    mappings = (
        db.query(SpeakerMapping)
        .filter(SpeakerMapping.meeting_id == meeting_id)
        .order_by(SpeakerMapping.speaker_label)
        .all()
    )
    mappings_by_label: dict[str, SpeakerMapping] = {}
    for mapping in mappings:
        mapping_label = _normalize_optional_string(cast(Any, mapping).speaker_label)
        if mapping_label is not None:
            mappings_by_label[mapping_label] = mapping
    candidates = build_candidate_pool(
        list(cast(Any, meeting).participants), cast(Any, meeting).identity_hints
    )

    try:
        for action_item in action_items:
            if cast(Any, action_item).owner_source == ActionOwnerSource.USER_CORRECTED:
                continue

            current_owner_name = _normalize_optional_string(cast(Any, action_item).owner_name)
            speaker_label = None
            if cast(Any, action_item).owner_source == ActionOwnerSource.SPEAKER_MAPPING:
                speaker_label = _source_speaker_label_from_reason(
                    cast(Any, action_item).owner_reason
                )
            if (
                speaker_label is None
                and _lookup_mapping(mappings_by_label, current_owner_name) is not None
            ):
                speaker_label = current_owner_name
            resolved = resolve_action_owner(
                extracted_owner=current_owner_name,
                speaker_label=speaker_label,
                candidates=candidates,
                mappings_by_label=mappings_by_label,
            )
            action_item.owner_name = resolved["owner_name"]
            action_item.owner_email = resolved["owner_email"]
            action_item.owner_confidence = resolved["owner_confidence"]
            action_item.owner_source = resolved["owner_source"]
            action_item.owner_reason = resolved["owner_reason"]

        db.commit()
    except Exception:
        db.rollback()
        raise

    for action_item in action_items:
        db.refresh(action_item)
    return action_items
