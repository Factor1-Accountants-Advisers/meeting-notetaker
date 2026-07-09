"""In-memory store seeded with the same placeholder data as the renderer.

Stands in for Azure PostgreSQL until the DB work lands; routers depend on this
module's functions, so swapping in a real repository is contained.

State is snapshotted to var/store.json after every mutation (see main.py
middleware + the pipeline) so it survives backend restarts. Delete the file
to reset to the seeds.
"""

import json
from datetime import date, datetime, timezone
from pathlib import Path
from uuid import UUID, uuid5, NAMESPACE_URL

from app.paths import snapshot_path
from app.schemas import (
    AccessRole,
    ActionItem,
    PipelineStatus,
    ActionItemStatus,
    AuditEntry,
    Meeting,
    MeetingAccessEntry,
    MeetingParticipant,
    MeetingSource,
    MeetingStatus,
    PersonEnrollment,
    Priority,
    TranscriptSegment,
)


AUDIT_LOG: list["AuditEntry"] = []


def add_audit(
    actor: str,
    action: str,
    target: str,
    before: str | None = None,
    after: str | None = None,
    meeting_id: UUID | None = None,
) -> None:
    from datetime import datetime, timezone
    from uuid import uuid4

    AUDIT_LOG.append(
        AuditEntry(
            id=uuid4(),
            meeting_id=meeting_id,
            actor=actor,
            action=action,
            target=target,
            before=before,
            after=after,
            at=datetime.now(timezone.utc),
        )
    )


def _mid(slug: str) -> UUID:
    return uuid5(NAMESPACE_URL, f"mn:meeting:{slug}")


def _aid(slug: str) -> UUID:
    return uuid5(NAMESPACE_URL, f"mn:action:{slug}")


MEETINGS: dict[UUID, Meeting] = {}

# Decision #7: private to participants by default; owner can share.
ACCESS: dict[UUID, list[MeetingAccessEntry]] = {}

SUMMARIES: dict[UUID, str] = {}

# Rich-text (HTML) rendering of the summary, used for email delivery. Kept
# separate from the plain-text SUMMARIES so search/UI stay plain and legacy
# snapshots without this key still load.
SUMMARY_HTML: dict[UUID, str] = {}

PARTICIPANTS: dict[UUID, list[MeetingParticipant]] = {}

TRANSCRIPTS: dict[UUID, list[TranscriptSegment]] = {}

ACTION_ITEMS: dict[UUID, ActionItem] = {}

PEOPLE: list[PersonEnrollment] = []


# ---------------------------------------------------------------------------
# Snapshot persistence (Postgres stand-in durability)
# ---------------------------------------------------------------------------

def save_snapshot() -> None:
    snapshot_path().parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "meetings": {str(k): v.model_dump(mode="json") for k, v in MEETINGS.items()},
        "action_items": {str(k): v.model_dump(mode="json") for k, v in ACTION_ITEMS.items()},
        "summaries": {str(k): v for k, v in SUMMARIES.items()},
        "summary_html": {str(k): v for k, v in SUMMARY_HTML.items()},
        "participants": {
            str(k): [p.model_dump(mode="json") for p in v] for k, v in PARTICIPANTS.items()
        },
        "transcripts": {
            str(k): [s.model_dump(mode="json") for s in v] for k, v in TRANSCRIPTS.items()
        },
        "access": {
            str(k): [a.model_dump(mode="json") for a in v] for k, v in ACCESS.items()
        },
        "people": [p.model_dump(mode="json") for p in PEOPLE],
        "audit_log": [e.model_dump(mode="json") for e in AUDIT_LOG],
    }
    tmp = snapshot_path().with_suffix(".tmp")
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    tmp.replace(snapshot_path())


def load_snapshot() -> bool:
    if not snapshot_path().exists():
        return False
    try:
        raw = json.loads(snapshot_path().read_text(encoding="utf-8"))
        meetings = {UUID(k): Meeting.model_validate(v) for k, v in raw["meetings"].items()}
        items = {UUID(k): ActionItem.model_validate(v) for k, v in raw["action_items"].items()}
        summaries = {UUID(k): v for k, v in raw["summaries"].items()}
        summary_html = {UUID(k): v for k, v in raw.get("summary_html", {}).items()}
        participants = {
            UUID(k): [MeetingParticipant.model_validate(p) for p in v]
            for k, v in raw["participants"].items()
        }
        transcripts = {
            UUID(k): [TranscriptSegment.model_validate(s) for s in v]
            for k, v in raw["transcripts"].items()
        }
        access = (
            {
                UUID(k): [MeetingAccessEntry.model_validate(a) for a in v]
                for k, v in raw["access"].items()
            }
            if "access" in raw
            else None  # older snapshot: keep seeded defaults
        )
        people = [PersonEnrollment.model_validate(p) for p in raw["people"]]
        audit = [AuditEntry.model_validate(e) for e in raw["audit_log"]]
    except Exception:
        # Corrupt or schema-incompatible snapshot: keep the seeds.
        return False

    MEETINGS.clear()
    MEETINGS.update(meetings)
    ACTION_ITEMS.clear()
    ACTION_ITEMS.update(items)
    SUMMARIES.clear()
    SUMMARIES.update(summaries)
    SUMMARY_HTML.clear()
    SUMMARY_HTML.update(summary_html)
    PARTICIPANTS.clear()
    PARTICIPANTS.update(participants)
    TRANSCRIPTS.clear()
    TRANSCRIPTS.update(transcripts)
    if access is not None:
        ACCESS.clear()
        ACCESS.update(access)
    PEOPLE[:] = people
    AUDIT_LOG[:] = audit
    return True


load_snapshot()
