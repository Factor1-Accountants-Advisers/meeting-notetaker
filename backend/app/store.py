"""In-memory store seeded with the same placeholder data as the renderer.

Stands in for Azure PostgreSQL until the DB work lands; routers depend on this
module's functions, so swapping in a real repository is contained.
"""

from datetime import date, datetime, timezone
from uuid import UUID, uuid5, NAMESPACE_URL

from app.schemas import (
    ActionItem,
    ActionItemStatus,
    Meeting,
    MeetingSource,
    MeetingStatus,
    PersonEnrollment,
    Priority,
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
        ),
    ]
}

ACTION_ITEMS: dict[UUID, ActionItem] = {
    a.id: a
    for a in [
        ActionItem(
            id=_aid("reconcile-smiths"),
            meeting_id=_mid("q2-henderson"),
            owner="Gerd",
            description="Reconcile Smith's Bakery accounts",
            deadline=date(2026, 6, 6),
            priority=Priority.high,
            status=ActionItemStatus.open,
        ),
        ActionItem(
            id=_aid("depreciation"),
            meeting_id=_mid("q2-henderson"),
            owner="Gerd",
            description="Update depreciation schedule",
            deadline=date(2026, 6, 13),
            priority=Priority.medium,
            status=ActionItemStatus.open,
        ),
        ActionItem(
            id=_aid("fy25-estimate"),
            meeting_id=_mid("q2-henderson"),
            owner="Gerd",
            description="Send FY25 provisional tax estimate",
            deadline=date(2026, 6, 16),
            priority=Priority.medium,
            status=ActionItemStatus.open,
        ),
        ActionItem(
            id=_aid("payroll-summary"),
            meeting_id=_mid("payroll-hr"),
            owner="Gerd",
            description="Draft payroll summary for HR",
            deadline=date(2026, 6, 18),
            priority=Priority.low,
            status=ActionItemStatus.open,
        ),
    ]
}

PEOPLE: list[PersonEnrollment] = [
    PersonEnrollment(
        employee_id="gerd",
        display_name="Gerd Guerrero",
        enrolled=True,
        model_version="pyannote/embedding-3.1",
    ),
    PersonEnrollment(employee_id="msantos", display_name="M. Santos", enrolled=True,
                     model_version="pyannote/embedding-3.1"),
    PersonEnrollment(employee_id="jlim", display_name="J. Lim", enrolled=False),
    PersonEnrollment(
        employee_id="rabad",
        display_name="R. Abad",
        enrolled=True,
        model_version="pyannote/embedding-3.0",
        reenrollment_required=True,
    ),
]
