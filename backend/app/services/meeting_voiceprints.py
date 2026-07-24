"""IN-378 meeting-scoped voiceprint retrieval and safe local fallback.

Central retrieval is authoritative when it succeeds. Local voiceprints are
consulted only when the configured Storage API is unavailable, and then only
for the same bounded participant set. Tokens, emails, OIDs, and voiceprint
values must never be logged or persisted by this service.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Iterable

from app.config import Settings, get_settings
from app.schemas import Meeting
from app.services.speaker_matching import (
    _controlled_expansion_ids_from_settings,
)
from app.services.storage_api import (
    CentralEnrolment,
    MeetingVoiceprintCandidate,
    StorageApiClient,
    StorageApiUnavailable,
    get_storage_api_client,
)
from app.services.voiceprints import Voiceprint, get_voiceprint_repository

logger = logging.getLogger(__name__)


class MeetingVoiceprintsUnavailable(RuntimeError):
    """Central retrieval failed and no safe local fallback was available."""


@dataclass(frozen=True)
class MeetingVoiceprintResolution:
    # None means central retrieval is disabled and the matcher should retain
    # legacy repository loading. [] means central retrieval succeeded but no
    # submitted candidate had an active enrolment.
    records: list[Voiceprint] | None
    degraded: bool
    request_count: int


def _normalized_email(value: str | None) -> str | None:
    normalized = (value or "").strip().casefold()
    if not normalized or "@" not in normalized:
        return None
    return normalized


def build_meeting_candidates(
    meeting: Meeting,
    *,
    recorder_email: str | None,
    expansion_emails: Iterable[str],
) -> list[MeetingVoiceprintCandidate]:
    """Build the bounded attendee → organiser → recorder → expansion request."""

    candidates: list[MeetingVoiceprintCandidate] = []
    seen: set[str] = set()

    def add(value: str | None, source: str) -> None:
        email = _normalized_email(value)
        if email is None or email in seen or len(candidates) >= 50:
            return
        seen.add(email)
        candidates.append(MeetingVoiceprintCandidate(email=email, source=source))

    if meeting.graph_metadata:
        for attendee in meeting.graph_metadata.attendees:
            add(attendee.email, "invitee")

    for attendee in meeting.manual_attendees:
        add(attendee.email, "invitee")

    if meeting.graph_metadata:
        add(meeting.graph_metadata.organizer_email, "organizer")

    add(recorder_email or meeting.owner_id, "recorder")
    for email in expansion_emails:
        add(email, "controlled_expansion")
    return candidates


def _as_voiceprint(record: CentralEnrolment) -> Voiceprint | None:
    email = _normalized_email(record.email)
    if email is None or record.status != "active":
        return None
    return Voiceprint(
        employee_id=email,
        display_name=record.display_name,
        voiceprints=list(record.voiceprints),
        model_version=record.model_version or "unknown",
        enrolled_at=record.updated_at.isoformat(),
    )


def resolve_meeting_voiceprints(
    meeting: Meeting,
    *,
    recorder_email: str | None,
    access_token: str | None,
    settings: Settings | None = None,
    client: StorageApiClient | None = None,
    local_records: list[Voiceprint] | None = None,
) -> MeetingVoiceprintResolution:
    """Resolve central candidates once, falling back locally only on failure."""

    resolved_settings = settings or get_settings()
    expansion_emails = _controlled_expansion_ids_from_settings(resolved_settings)
    candidates = build_meeting_candidates(
        meeting,
        recorder_email=recorder_email,
        expansion_emails=expansion_emails,
    )
    if not (
        resolved_settings.storage_api_enabled
        and resolved_settings.storage_api_url
    ):
        return MeetingVoiceprintResolution(
            records=None,
            degraded=False,
            request_count=0,
        )

    if not candidates:
        return MeetingVoiceprintResolution(
            records=[],
            degraded=False,
            request_count=0,
        )

    resolved_client = client or get_storage_api_client()
    try:
        response = resolved_client.get_meeting_voiceprints(
            meeting.id,
            candidates,
            access_token,
        )
        records = [
            voiceprint
            for record in response.records
            if (voiceprint := _as_voiceprint(record)) is not None
        ]
        logger.info(
            "Meeting voiceprint lookup completed: requested=%d resolved=%d missing=%d",
            len(candidates),
            len(records),
            len(response.missing),
        )
        return MeetingVoiceprintResolution(
            records=records,
            degraded=False,
            request_count=1,
        )
    except StorageApiUnavailable as exc:
        available_local = (
            local_records
            if local_records is not None
            else get_voiceprint_repository().get_all()
        )
        local_by_email = {
            record.employee_id.strip().casefold(): record
            for record in available_local
        }
        fallback = [
            local_by_email[candidate.email]
            for candidate in candidates
            if candidate.email in local_by_email
        ]
        if not fallback:
            logger.warning(
                "Meeting voiceprint lookup unavailable with no local fallback: requested=%d",
                len(candidates),
            )
            raise MeetingVoiceprintsUnavailable(
                "Voiceprint lookup is temporarily unavailable; retry processing."
            ) from exc
        logger.warning(
            "Meeting voiceprint lookup degraded to local fallback: requested=%d resolved=%d",
            len(candidates),
            len(fallback),
        )
        return MeetingVoiceprintResolution(
            records=fallback,
            degraded=True,
            request_count=1,
        )
