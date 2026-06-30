"""Per-meeting access checks (decision #7).

Keyed by display name until Entra ID subjects replace the X-MN-User header.
Meetings without access records stay open (dev/legacy data); enforcement
hardens automatically once records exist for everything.
"""

from uuid import UUID

from fastapi import HTTPException, status

from app import store
from app.schemas import AccessRole

_RANK = {AccessRole.viewer: 1, AccessRole.editor: 2, AccessRole.owner: 3}


def can_see(meeting_id: UUID, actor: str) -> bool:
    entries = store.ACCESS.get(meeting_id)
    if not entries:
        return True
    return any(e.user == actor for e in entries)


def require(meeting_id: UUID, actor: str, minimum: AccessRole) -> None:
    """Raise unless the actor holds at least `minimum` on the meeting.

    Hidden meetings 404 (don't reveal existence); insufficient role 403.
    """
    entries = store.ACCESS.get(meeting_id)
    if not entries:
        return
    entry = next((e for e in entries if e.user == actor), None)
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")
    if _RANK[entry.role] < _RANK[minimum]:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            f"This action needs {minimum.value} access",
        )
