"""Canonical structured meeting-output JSON (IN-384).

This is the machine-facing platform data contract (storage integration brief
v0.2 §2/§6) that IN-386 uploads to Azure Blob and The Conductor / The
Assistant consume. Contract rules:

- snake_case keys; every key always present (null / empty when unavailable).
- All timestamps are ISO 8601 UTC; ``due_date`` is an ISO date.
- ``transcript`` ``start``/``end`` are seconds (float), converted from the
  stored millisecond fields.
- ``key_points``/``follow_ups`` stay empty and the action-item fields owned
  by IN-390 (``owner_email``, ``owner_confidence``, ``owner_source``,
  ``action_type``, ``assigned_to``, ``assigned_to_department``) stay null
  until the summarisation consolidation populates them.
- ``graph_online_meeting_id`` is null until the true Teams online meeting id
  is captured: Slice 1 stored the event iCalUId under ``online_meeting_id``
  (normalise.ts), so that value backfills ``graph_ical_uid`` instead of being
  exported under a name it never matched.

The builder is pure — callers pass the meeting, transcript, summary, and
action items explicitly — so IN-386 can serialise an export without knowing
about the scattered in-memory stores.
"""

from datetime import date, datetime, timezone
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from app.schemas import ActionItem, Meeting, PipelineStatus, TranscriptSegment

SCHEMA_VERSION = "1.0"
INTERNAL_EMAIL_DOMAIN = "factor1.com.au"


def _parse_utc_timestamp(value: str) -> datetime | None:
    """Parse an ISO 8601 string with an explicit offset; None if unusable.

    Naive timestamps are ambiguous and rejected — the platform standard is
    one clock, UTC.
    """
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


def _format_utc_timestamp(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


class ExportInvitee(BaseModel):
    name: str | None = None
    email: str | None = None


class ExportTranscriptSegment(BaseModel):
    speaker: str
    text: str
    start: float  # seconds from recording start
    end: float  # seconds from recording start
    confidence: float | None = None
    speaker_source: str


class ExportActionItem(BaseModel):
    description: str
    owner_name: str | None = None
    owner_email: str | None = None
    # Categorical scale from the structured-output plan
    # (2026-07-01-long-meeting-pipeline-slice1-plan.md), not a number.
    owner_confidence: Literal["high", "medium", "low", "unknown"] | None = None
    owner_source: str | None = None
    action_type: str | None = None
    due_date: date | None = None
    assigned_to: str | None = None
    assigned_to_department: str | None = None


class MeetingExport(BaseModel):
    meeting_id: str
    meeting_type: Literal["internal", "client"]  # derived from invitee domains
    meeting_name: str
    organiser_name: str | None = None
    organiser_email: str | None = None
    scheduled_start: str | None = None  # ISO 8601 UTC
    actual_duration_seconds: int | None = None
    full_invitee_list: list[ExportInvitee] = Field(default_factory=list)
    meeting_description: str | None = None
    transcript: list[ExportTranscriptSegment] = Field(default_factory=list)
    summary: str | None = None
    key_points: list[str] = Field(default_factory=list)
    action_items: list[ExportActionItem] = Field(default_factory=list)
    follow_ups: list[str] = Field(default_factory=list)
    schema_version: Literal["1.0"] = SCHEMA_VERSION
    graph_event_id: str | None = None
    graph_ical_uid: str | None = None
    graph_online_meeting_id: str | None = None

    @field_validator("scheduled_start")
    @classmethod
    def _scheduled_start_must_be_iso_utc(cls, value: str | None) -> str | None:
        if value is None:
            return None
        parsed = _parse_utc_timestamp(value)
        if parsed is None:
            raise ValueError(
                "scheduled_start must be an ISO 8601 datetime with an explicit offset"
            )
        return _format_utc_timestamp(parsed)


def _dedupe_invitees(attendees) -> list[ExportInvitee]:
    """Collapse exact case-insensitive email duplicates; keep email-less entries."""
    seen: set[str] = set()
    invitees: list[ExportInvitee] = []
    for attendee in attendees:
        email = (attendee.email or "").strip() or None
        if email is not None:
            key = email.lower()
            if key in seen:
                continue
            seen.add(key)
        invitees.append(ExportInvitee(name=attendee.name, email=email))
    return invitees


def _derive_meeting_type(invitees: list[ExportInvitee]) -> str:
    domains = [
        invitee.email.rsplit("@", 1)[1].lower()
        for invitee in invitees
        if invitee.email and "@" in invitee.email
    ]
    if not domains:
        # No usable invitee emails (manual/in-person recordings): deterministic
        # default, not a detection — downstream treats it as metadata only.
        return "internal"
    if any(domain != INTERNAL_EMAIL_DOMAIN for domain in domains):
        return "client"
    return "internal"


def _export_segment(segment: TranscriptSegment) -> ExportTranscriptSegment:
    return ExportTranscriptSegment(
        speaker=segment.speaker,
        text=segment.text,
        start=segment.start_ms / 1000,
        end=segment.end_ms / 1000,
        confidence=segment.speaker_confidence,
        speaker_source=segment.speaker_source,
    )


def _export_action_item(item: ActionItem) -> ExportActionItem:
    return ExportActionItem(
        description=item.description,
        owner_name=item.owner,
        due_date=item.deadline,
    )


def build_meeting_export(
    meeting: Meeting,
    segments: list[TranscriptSegment],
    summary: str | None,
    action_items: list[ActionItem],
) -> MeetingExport:
    metadata = meeting.graph_metadata
    invitees = _dedupe_invitees(metadata.attendees) if metadata else []
    # Normalise before validation: a malformed stored timestamp degrades to
    # null instead of failing the pipeline run that builds the artifact.
    scheduled_start: str | None = None
    if metadata and metadata.scheduled_start_utc:
        parsed = _parse_utc_timestamp(metadata.scheduled_start_utc)
        scheduled_start = _format_utc_timestamp(parsed) if parsed else None
    return MeetingExport(
        meeting_id=str(meeting.id),
        meeting_type=_derive_meeting_type(invitees),
        meeting_name=meeting.title,
        organiser_name=metadata.organizer_name if metadata else None,
        organiser_email=metadata.organizer_email if metadata else None,
        scheduled_start=scheduled_start,
        actual_duration_seconds=meeting.duration_seconds,
        full_invitee_list=invitees,
        meeting_description=metadata.description if metadata else None,
        transcript=[_export_segment(s) for s in segments],
        summary=summary,
        action_items=[_export_action_item(a) for a in action_items],
        graph_event_id=metadata.meeting_id if metadata else None,
        graph_ical_uid=(
            (metadata.ical_uid or metadata.online_meeting_id) if metadata else None
        ),
        graph_online_meeting_id=None,
    )


def build_meeting_export_for(meeting_id: UUID) -> MeetingExport | None:
    """Adapt the scattered stores into the pure builder's inputs."""
    from app import store

    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None:
        return None
    action_items = [
        item for item in store.ACTION_ITEMS.values() if item.meeting_id == meeting_id
    ]
    return build_meeting_export(
        meeting,
        store.TRANSCRIPTS.get(meeting_id, []),
        store.SUMMARIES.get(meeting_id),
        action_items,
    )


def refresh_meeting_export(meeting_id: UUID) -> None:
    """(Re)build and store the artifact for a processed meeting.

    Called when the pipeline reaches ready and after every post-ready mutation
    that changes export content (speaker naming, segment edits, action-item
    updates), so the stored artifact never goes stale before IN-386 uploads it.
    """
    from app import store

    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None or meeting.pipeline_status is not PipelineStatus.ready:
        return
    export = build_meeting_export_for(meeting_id)
    if export is not None:
        store.MEETING_EXPORTS[meeting_id] = export.model_dump(mode="json")
