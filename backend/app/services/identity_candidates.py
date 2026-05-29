"""Reusable identity candidate pool builder."""
from typing import Any


def _normalise_email(email: Any) -> str:
    """Return a normalized email key for de-duplication and matching."""
    return (email or "").strip().lower() if isinstance(email, str) else ""


def _hint_payload(hints: dict[str, Any], key: str) -> dict[str, Any]:
    """Return a hint payload only when it has the expected dict shape."""
    value = hints.get(key)
    return value if isinstance(value, dict) else {}


def build_candidate_pool(
    participants: list,
    identity_hints: dict | None,
) -> list[dict[str, Any]]:
    """Build candidate identities from participants and meeting identity hints.

    Candidates are de-duplicated by email when an email is present. Candidates
    without email are preserved because there is no reliable key to merge them.
    The current user hint marks/adds the recorder; the organizer hint marks/adds
    the organizer. Malformed identity hints are ignored.
    """
    candidates: list[dict[str, Any]] = []
    seen_emails: set[str] = set()

    for participant in participants:
        email = _normalise_email(getattr(participant, "email", None))
        if email and email in seen_emails:
            continue

        candidates.append({
            "display_name": getattr(participant, "name", ""),
            "email": getattr(participant, "email", None),
            "is_organizer": bool(getattr(participant, "is_organizer", False)),
            "is_recorder": False,
        })
        if email:
            seen_emails.add(email)

    hints = identity_hints if isinstance(identity_hints, dict) else {}

    current_user = _hint_payload(hints, "current_user")
    current_user_name = current_user.get("name")
    if current_user_name:
        email = _normalise_email(current_user.get("email"))
        if email and email in seen_emails:
            for candidate in candidates:
                if _normalise_email(candidate.get("email")) == email:
                    candidate["is_recorder"] = True
        else:
            candidates.append({
                "display_name": current_user_name,
                "email": current_user.get("email"),
                "is_organizer": False,
                "is_recorder": True,
            })
            if email:
                seen_emails.add(email)

    organizer = _hint_payload(hints, "organizer")
    organizer_name = organizer.get("name")
    if organizer_name:
        email = _normalise_email(organizer.get("email"))
        if email and email in seen_emails:
            for candidate in candidates:
                if _normalise_email(candidate.get("email")) == email:
                    candidate["is_organizer"] = True
        else:
            candidates.append({
                "display_name": organizer_name,
                "email": organizer.get("email"),
                "is_organizer": True,
                "is_recorder": False,
            })
            if email:
                seen_emails.add(email)

    return candidates
