"""Reusable identity candidate pool builder."""
from typing import Any


def _normalise_email(email: Any) -> str:
    """Return a normalized email key for de-duplication and matching."""
    return (email or "").strip().lower() if isinstance(email, str) else ""


def _hint_payload(hints: dict[str, Any], key: str) -> dict[str, Any]:
    """Return a hint payload only when it has the expected dict shape."""
    value = hints.get(key)
    return value if isinstance(value, dict) else {}


def _hint_name(payload: dict[str, Any]) -> str:
    """Return a stripped hint name, or an empty string for malformed names."""
    name = payload.get("name")
    return name.strip() if isinstance(name, str) else ""


def _hint_email(payload: dict[str, Any]) -> str | None:
    """Return a hint email only when it is a string or None."""
    email = payload.get("email")
    return email if isinstance(email, str) or email is None else None


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
    candidates_by_email: dict[str, dict[str, Any]] = {}

    for participant in participants:
        email = _normalise_email(getattr(participant, "email", None))
        if email and email in seen_emails:
            candidates_by_email[email]["is_organizer"] = (
                candidates_by_email[email]["is_organizer"]
                or bool(getattr(participant, "is_organizer", False))
            )
            continue

        candidate = {
            "display_name": getattr(participant, "name", ""),
            "email": getattr(participant, "email", None),
            "is_organizer": bool(getattr(participant, "is_organizer", False)),
            "is_recorder": False,
        }
        candidates.append(candidate)
        if email:
            seen_emails.add(email)
            candidates_by_email[email] = candidate

    hints = identity_hints if isinstance(identity_hints, dict) else {}

    current_user = _hint_payload(hints, "current_user")
    current_user_name = _hint_name(current_user)
    if current_user_name:
        current_user_email = _hint_email(current_user)
        email = _normalise_email(current_user_email)
        if email and email in seen_emails:
            candidates_by_email[email]["is_recorder"] = True
        else:
            candidate = {
                "display_name": current_user_name,
                "email": current_user_email,
                "is_organizer": False,
                "is_recorder": True,
            }
            candidates.append(candidate)
            if email:
                seen_emails.add(email)
                candidates_by_email[email] = candidate

    organizer = _hint_payload(hints, "organizer")
    organizer_name = _hint_name(organizer)
    if organizer_name:
        organizer_email = _hint_email(organizer)
        email = _normalise_email(organizer_email)
        if email and email in seen_emails:
            candidates_by_email[email]["is_organizer"] = True
        else:
            candidate = {
                "display_name": organizer_name,
                "email": organizer_email,
                "is_organizer": True,
                "is_recorder": False,
            }
            candidates.append(candidate)
            if email:
                seen_emails.add(email)
                candidates_by_email[email] = candidate

    return candidates
