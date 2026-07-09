"""Organiser must receive their own transcript email (Jira IN-94/IN-119).

Graph's attendees array excludes the organiser, so a scheduled meeting was
emailing everyone but the person who recorded it.
"""

import unittest
from datetime import datetime, timezone
from uuid import uuid4

from app.routers.meetings import _email_recipients
from app.schemas import (
    GraphMeetingAttendeeMetadata,
    GraphMeetingMetadata,
    Meeting,
    MeetingSource,
)


def _meeting(graph_metadata=None, source=MeetingSource.online):
    return Meeting(
        id=uuid4(),
        title="Test",
        source=source,
        owner_id="organizer@factor1.com.au",
        created_at=datetime.now(timezone.utc),
        graph_metadata=graph_metadata,
    )


class EmailRecipientTests(unittest.TestCase):
    def test_scheduled_meeting_includes_organizer_not_in_attendees(self):
        meta = GraphMeetingMetadata(
            meeting_id="evt-1",
            organizer_email="organizer@factor1.com.au",
            attendees=[
                GraphMeetingAttendeeMetadata(email="bb@factor1.com.au"),
                GraphMeetingAttendeeMetadata(email="jt@factor1.com.au"),
            ],
        )
        recipients = _email_recipients(_meeting(meta), recorder_email="organizer@factor1.com.au")
        self.assertIn("organizer@factor1.com.au", recipients)
        self.assertIn("bb@factor1.com.au", recipients)
        self.assertIn("jt@factor1.com.au", recipients)

    def test_organizer_not_duplicated_when_also_an_attendee(self):
        meta = GraphMeetingMetadata(
            meeting_id="evt-2",
            organizer_email="organizer@factor1.com.au",
            attendees=[GraphMeetingAttendeeMetadata(email="Organizer@Factor1.com.au")],
        )
        recipients = _email_recipients(_meeting(meta), recorder_email="organizer@factor1.com.au")
        self.assertEqual(recipients.count("organizer@factor1.com.au"), 1)

    def test_adhoc_recording_still_emails_recorder_only(self):
        recipients = _email_recipients(
            _meeting(None, source=MeetingSource.in_person),
            recorder_email="recorder@factor1.com.au",
        )
        self.assertEqual(recipients, ["recorder@factor1.com.au"])
