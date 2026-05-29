"""Action item owner resolution service.

Resolves action item owner metadata from speaker mappings, meeting identity
candidates, and owner text extracted by the summarisation LLM.
"""

from typing import Any, cast

from sqlalchemy.orm import Session

from app.models import ActionItem, ActionOwnerSource, Meeting, SpeakerMapping
from app.services.identity_candidates import build_candidate_pool

EXPLICIT_NAME_MATCH_CONFIDENCE = 0.8
LLM_EXTRACTION_CONFIDENCE = 0.5
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
        owner_confidence=float(cast(Any, mapping).confidence or 0.0),
        owner_source=ActionOwnerSource.SPEAKER_MAPPING,
        owner_reason=f"Resolved from speaker mapping for {speaker_label}",
    )


def _candidate_display_name(candidate: dict[str, Any]) -> str | None:
    """Return a candidate display name from supported candidate shapes."""
    return _normalize_optional_string(
        candidate.get("display_name")
        if candidate.get("display_name") is not None
        else candidate.get("name")
    )


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
        mapping = mappings_by_label.get(normalized_speaker_label)
        if mapping is not None and _mapping_has_display_name(mapping):
            return _resolve_from_mapping(normalized_speaker_label, mapping)

    normalized_owner = _normalize_optional_string(extracted_owner)
    if normalized_owner is not None:
        mapping = mappings_by_label.get(normalized_owner)
        if mapping is not None and _mapping_has_display_name(mapping):
            return _resolve_from_mapping(normalized_owner, mapping)

    if normalized_owner is not None and not _is_unassigned_owner(normalized_owner):
        owner_key = _normalize_match_key(normalized_owner)
        for candidate in candidates:
            display_name = _candidate_display_name(candidate)
            if display_name is not None and _normalize_match_key(display_name) == owner_key:
                return _result(
                    owner_name=display_name,
                    owner_email=_normalize_optional_string(candidate.get("email")),
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
    mappings_by_label = {
        cast(Any, mapping).speaker_label: mapping
        for mapping in mappings
        if _normalize_optional_string(cast(Any, mapping).speaker_label) is not None
    }
    candidates = build_candidate_pool(list(cast(Any, meeting).participants), cast(Any, meeting).identity_hints)

    try:
        for action_item in action_items:
            if cast(Any, action_item).owner_source == ActionOwnerSource.USER_CORRECTED:
                continue

            current_owner_name = _normalize_optional_string(cast(Any, action_item).owner_name)
            speaker_label = current_owner_name if current_owner_name in mappings_by_label else None
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
