#!/usr/bin/env python3
"""Verify Jira IN-93/IN-94 transcript email delivery behavior.

Source of truth: Jira CSV says transcript email is sent when a transcript is
saved. It should not require the removed/heavy review/finalise desktop flow.
"""

import asyncio
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import HTTPException

from app import store
from app.routers import meetings as meetings_router
from app.schemas import (
    AccessRole,
    EmailRequest,
    GraphMeetingAttendeeMetadata,
    GraphMeetingMetadata,
    Meeting,
    MeetingAccessEntry,
    MeetingSource,
    PipelineStatus,
    TranscriptSegment,
)


class CaptureEmailProvider:
    def __init__(self, sent):
        self.sent = sent

    async def send_meeting_notes(self, recipients, subject, body, attachments=None, access_token=None):
        self.sent.append(
            {
                "recipients": recipients,
                "subject": subject,
                "body": body,
                "attachments": attachments or [],
                "access_token": access_token,
            }
        )


def reset_meeting(*, source=MeetingSource.in_person, graph_metadata=None):
    meeting_id = uuid4()
    meeting = Meeting(
        id=meeting_id,
        title="Jira email smoke",
        source=source,
        owner_id="joseph",
        created_at=datetime.now(timezone.utc),
        pipeline_status=PipelineStatus.ready,
        graph_metadata=graph_metadata,
    )
    store.MEETINGS[meeting_id] = meeting
    store.ACCESS[meeting_id] = [MeetingAccessEntry(user="Joseph Guerrero", role=AccessRole.owner)]
    store.SUMMARIES[meeting_id] = "Concise meeting summary."
    store.TRANSCRIPTS[meeting_id] = [
        TranscriptSegment(
            speaker="Joseph Guerrero",
            speaker_known=True,
            text="We agreed to send the transcript automatically after processing.",
            start_ms=0,
            end_ms=4000,
        )
    ]
    store.PARTICIPANTS[meeting_id] = []
    return meeting_id


async def run_case(label, coro):
    try:
        await coro()
    except HTTPException as exc:
        raise AssertionError(f"{label} failed with HTTP {exc.status_code}: {exc.detail}") from exc


async def test_manual_ad_hoc_emails_recorder_without_finalise():
    sent = []
    meetings_router.get_email_provider = lambda token=None: CaptureEmailProvider(sent)
    meeting_id = reset_meeting()

    result = await meetings_router.email_notes(
        meeting_id,
        EmailRequest(note=None, recorder_email="joseph@example.com"),
        actor="Joseph Guerrero",
        graph_token="fake-token",
    )

    assert result.recipients == ["joseph@example.com"], result.recipients
    assert len(sent) == 1
    assert sent[0]["recipients"] == ["joseph@example.com"]
    assert sent[0]["attachments"], "transcript attachment missing"


async def test_calendar_recording_emails_graph_attendees_without_finalise():
    sent = []
    meetings_router.get_email_provider = lambda token=None: CaptureEmailProvider(sent)
    metadata = GraphMeetingMetadata(
        meeting_id="graph-event-1",
        title="Calendar meeting",
        organizer_email="organiser@example.com",
        attendees=[
            GraphMeetingAttendeeMetadata(name="Joseph", email="joseph@example.com", response="accepted"),
            GraphMeetingAttendeeMetadata(name="Client", email="client@example.com", response="accepted"),
            GraphMeetingAttendeeMetadata(name="Duplicate", email="CLIENT@example.com", response="accepted"),
            GraphMeetingAttendeeMetadata(name="No Email", email=None, response="accepted"),
        ],
    )
    meeting_id = reset_meeting(source=MeetingSource.online, graph_metadata=metadata)

    result = await meetings_router.email_notes(
        meeting_id,
        EmailRequest(note="Attached is the transcript.", recorder_email="fallback@example.com"),
        actor="Joseph Guerrero",
        graph_token="fake-token",
    )

    assert result.recipients == ["joseph@example.com", "client@example.com"], result.recipients
    assert len(sent) == 1
    assert sent[0]["recipients"] == ["joseph@example.com", "client@example.com"]
    assert "Meeting notes: Jira email smoke" == sent[0]["subject"]


async def test_missing_graph_token_does_not_fake_send_success():
    sent = []
    meetings_router.get_email_provider = lambda token=None: CaptureEmailProvider(sent)
    meeting_id = reset_meeting()

    try:
        await meetings_router.email_notes(
            meeting_id,
            EmailRequest(note=None, recorder_email="joseph@example.com"),
            actor="Joseph Guerrero",
            graph_token="",
        )
    except HTTPException as exc:
        assert exc.status_code == 401, exc.status_code
        assert not sent, "email provider should not be called without Graph token"
        return
    raise AssertionError("missing Graph token should not report email success")


async def main():
    await run_case("manual ad-hoc email", test_manual_ad_hoc_emails_recorder_without_finalise)
    await run_case("calendar attendee email", test_calendar_recording_emails_graph_attendees_without_finalise)
    await test_missing_graph_token_does_not_fake_send_success()
    print("email Jira flow passed")


if __name__ == "__main__":
    asyncio.run(main())
