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

from app.schemas import (
    ActionItem,
    PipelineStatus,
    ActionItemStatus,
    AuditEntry,
    Meeting,
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


MEETINGS: dict[UUID, Meeting] = {
    m.id: m
    for m in [
        Meeting(
            id=_mid("q2-henderson"),
            title="Q2 review — Henderson & Co",
            context="Henderson & Co",
            source=MeetingSource.online,
            owner_id="gerd",
            status=MeetingStatus.draft,
            created_at=datetime(2026, 6, 9, 9, 0, tzinfo=timezone.utc),
            duration_seconds=42 * 60 + 10,
            unknown_speaker_count=1,
            action_item_count=3,
            pipeline_status=PipelineStatus.ready,
        ),
        Meeting(
            id=_mid("standup-0608"),
            title="Daily stand-up",
            source=MeetingSource.online,
            owner_id="gerd",
            status=MeetingStatus.finalized,
            created_at=datetime(2026, 6, 8, 11, 0, tzinfo=timezone.utc),
            duration_seconds=12 * 60 + 30,
            action_item_count=2,
            pipeline_status=PipelineStatus.ready,
        ),
        Meeting(
            id=_mid("tax-acme"),
            title="Tax compliance — Acme Retail",
            context="Acme Retail",
            source=MeetingSource.in_person,
            owner_id="gerd",
            status=MeetingStatus.finalized,
            created_at=datetime(2026, 6, 6, 14, 0, tzinfo=timezone.utc),
            duration_seconds=35 * 60 + 2,
            action_item_count=4,
            pipeline_status=PipelineStatus.ready,
        ),
        Meeting(
            id=_mid("payroll-hr"),
            title="Payroll discussion — HR",
            source=MeetingSource.in_person,
            owner_id="gerd",
            status=MeetingStatus.finalized,
            created_at=datetime(2026, 6, 4, 16, 0, tzinfo=timezone.utc),
            duration_seconds=28 * 60 + 44,
            action_item_count=1,
            pipeline_status=PipelineStatus.ready,
        ),
    ]
}

SUMMARIES: dict[UUID, str] = {
    _mid("q2-henderson"): (
        "Quarterly review of Henderson & Co accounts. Revenue is tracking 8% ahead "
        "of forecast; depreciation schedule needs updating before the FY25 "
        "provisional tax estimate goes out. Client asked for a reconciliation of "
        "the Smith's Bakery subsidiary accounts by end of week. Next review booked "
        "for early September."
    ),
}

PARTICIPANTS: dict[UUID, list[MeetingParticipant]] = {
    _mid("q2-henderson"): [
        MeetingParticipant(name="Gerd Guerrero", known=True),
        MeetingParticipant(name="M. Santos", known=True),
        MeetingParticipant(name="Unknown 1", known=False),
    ],
}

TRANSCRIPTS: dict[UUID, list[TranscriptSegment]] = {
    _mid("q2-henderson"): [
        TranscriptSegment(
            speaker="Gerd Guerrero", speaker_known=True, start_ms=12_000, end_ms=24_000,
            text="Thanks for joining. Agenda today is the Q2 numbers, the depreciation "
                 "schedule, and the provisional tax estimate for FY25.",
        ),
        TranscriptSegment(
            speaker="M. Santos", speaker_known=True, start_ms=65_000, end_ms=89_000,
            text="Revenue is sitting about eight percent ahead of forecast. Margins are "
                 "flat — the cost increases in logistics ate the gains.",
        ),
        TranscriptSegment(
            speaker="Unknown 1", speaker_known=False, start_ms=221_000, end_ms=240_000,
            text="On our side we'd like the Smith's Bakery accounts reconciled before "
                 "Friday, if that's workable. The board meets Monday.",
        ),
        TranscriptSegment(
            speaker="Gerd Guerrero", speaker_known=True, start_ms=242_000, end_ms=260_000,
            text="Workable. I'll take that one. We'll also need the updated depreciation "
                 "schedule before the estimate — Marco, can you own that?",
        ),
        TranscriptSegment(
            speaker="M. Santos", speaker_known=True, start_ms=258_000, end_ms=275_000,
            text="Yes — I'll have it by the 13th. The FY25 provisional estimate can "
                 "follow on the 16th.",
        ),
    ],
}

ACTION_ITEMS: dict[UUID, ActionItem] = {
    a.id: a
    for a in [
        ActionItem(
            id=_aid("reconcile-smiths"),
            meeting_id=_mid("q2-henderson"),
            owner="Gerd Guerrero",
            description="Reconcile Smith's Bakery accounts",
            deadline=date(2026, 6, 6),
            priority=Priority.high,
            status=ActionItemStatus.open,
        ),
        ActionItem(
            id=_aid("depreciation"),
            meeting_id=_mid("q2-henderson"),
            owner="Gerd Guerrero",
            description="Update depreciation schedule",
            deadline=date(2026, 6, 13),
            priority=Priority.medium,
            status=ActionItemStatus.open,
        ),
        ActionItem(
            id=_aid("fy25-estimate"),
            meeting_id=_mid("q2-henderson"),
            owner="Gerd Guerrero",
            description="Send FY25 provisional tax estimate",
            deadline=date(2026, 6, 16),
            priority=Priority.medium,
            status=ActionItemStatus.open,
        ),
        ActionItem(
            id=_aid("payroll-summary"),
            meeting_id=_mid("payroll-hr"),
            owner="Gerd Guerrero",
            description="Draft payroll summary for HR",
            deadline=date(2026, 6, 18),
            priority=Priority.low,
            status=ActionItemStatus.open,
        ),
        ActionItem(
            id=_aid("acme-invoices"),
            meeting_id=_mid("tax-acme"),
            owner="M. Santos",
            description="Chase missing Q2 invoices from Acme Retail",
            deadline=date(2026, 6, 11),
            priority=Priority.high,
            status=ActionItemStatus.open,
        ),
        ActionItem(
            id=_aid("standup-notes"),
            meeting_id=_mid("standup-0608"),
            owner="R. Abad",
            description="Circulate stand-up notes to accounting",
            deadline=date(2026, 6, 9),
            priority=Priority.low,
            status=ActionItemStatus.done,
        ),
        ActionItem(
            id=_aid("bir-deadline"),
            meeting_id=_mid("q2-henderson"),
            owner=None,  # owned by Unknown 1 — unassigned until named
            description="Confirm BIR filing deadline with Henderson board",
            deadline=date(2026, 6, 12),
            priority=Priority.medium,
            status=ActionItemStatus.open,
        ),
    ]
}

PEOPLE: list[PersonEnrollment] = [
    PersonEnrollment(
        employee_id="gerd",
        display_name="Gerd Guerrero",
        role="AI engineer",
        enrolled=True,
        model_version="pyannote/embedding-3.1",
    ),
    PersonEnrollment(employee_id="msantos", display_name="M. Santos",
                     role="Senior accountant", enrolled=True,
                     model_version="pyannote/embedding-3.1"),
    PersonEnrollment(employee_id="jlim", display_name="J. Lim",
                     role="Accountant", enrolled=False),
    PersonEnrollment(
        employee_id="rabad",
        display_name="R. Abad",
        role="Adviser",
        enrolled=True,
        model_version="pyannote/embedding-3.0",
        reenrollment_required=True,
    ),
    PersonEnrollment(employee_id="lperez", display_name="L. Perez",
                     role="HR manager", enrolled=False),
    PersonEnrollment(employee_id="swong", display_name="S. Wong",
                     role="Payroll officer", enrolled=True,
                     model_version="pyannote/embedding-3.1"),
]


# ---------------------------------------------------------------------------
# Snapshot persistence (Postgres stand-in durability)
# ---------------------------------------------------------------------------

SNAPSHOT_PATH = Path(__file__).resolve().parents[1] / "var" / "store.json"


def save_snapshot() -> None:
    SNAPSHOT_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "meetings": {str(k): v.model_dump(mode="json") for k, v in MEETINGS.items()},
        "action_items": {str(k): v.model_dump(mode="json") for k, v in ACTION_ITEMS.items()},
        "summaries": {str(k): v for k, v in SUMMARIES.items()},
        "participants": {
            str(k): [p.model_dump(mode="json") for p in v] for k, v in PARTICIPANTS.items()
        },
        "transcripts": {
            str(k): [s.model_dump(mode="json") for s in v] for k, v in TRANSCRIPTS.items()
        },
        "people": [p.model_dump(mode="json") for p in PEOPLE],
        "audit_log": [e.model_dump(mode="json") for e in AUDIT_LOG],
    }
    tmp = SNAPSHOT_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    tmp.replace(SNAPSHOT_PATH)


def load_snapshot() -> bool:
    if not SNAPSHOT_PATH.exists():
        return False
    try:
        raw = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
        meetings = {UUID(k): Meeting.model_validate(v) for k, v in raw["meetings"].items()}
        items = {UUID(k): ActionItem.model_validate(v) for k, v in raw["action_items"].items()}
        summaries = {UUID(k): v for k, v in raw["summaries"].items()}
        participants = {
            UUID(k): [MeetingParticipant.model_validate(p) for p in v]
            for k, v in raw["participants"].items()
        }
        transcripts = {
            UUID(k): [TranscriptSegment.model_validate(s) for s in v]
            for k, v in raw["transcripts"].items()
        }
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
    PARTICIPANTS.clear()
    PARTICIPANTS.update(participants)
    TRANSCRIPTS.clear()
    TRANSCRIPTS.update(transcripts)
    PEOPLE[:] = people
    AUDIT_LOG[:] = audit
    return True


load_snapshot()
