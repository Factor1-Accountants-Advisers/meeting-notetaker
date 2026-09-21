"""Organiser must receive their own transcript email (Jira IN-94/IN-119).

Graph's attendees array excludes the organiser, so a scheduled meeting was
emailing everyone but the person who recorded it.
"""

import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from uuid import uuid4

from app.config import get_settings
from app.routers.meetings import _email_recipients
from app.schemas import (
    GraphMeetingAttendeeMetadata,
    GraphMeetingMetadata,
    ManualMeetingAttendee,
    Meeting,
    MeetingSource,
)


def _meeting(graph_metadata=None, source=MeetingSource.online, manual_attendees=None):
    return Meeting(
        id=uuid4(),
        title="Test",
        source=source,
        owner_id="organizer@factor1.com.au",
        created_at=datetime.now(timezone.utc),
        graph_metadata=graph_metadata,
        manual_attendees=manual_attendees or [],
    )


def _mode(value: str):
    override = get_settings().model_copy(update={"delivery_recipients": value})
    return patch("app.services.recipient_policy.get_settings", return_value=override)


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

    def _adhoc_with_two_picked(self):
        return _meeting(
            None,
            source=MeetingSource.in_person,
            manual_attendees=[
                ManualMeetingAttendee(name="David Ahlhaus", email="davidahlhaus@factor1.com.au"),
                ManualMeetingAttendee(name="Benjamin Bryant", email="benjaminbryant@factor1.com.au"),
            ],
        )

    def test_adhoc_recording_emails_recorder_only_until_approved(self):
        with _mode("ask"):
            recipients = _email_recipients(
                self._adhoc_with_two_picked(), recorder_email="recorder@factor1.com.au"
            )
        self.assertEqual(recipients, ["recorder@factor1.com.au"])

    def test_adhoc_recording_emails_picked_attendees_once_invitees_are_approved(self):
        # IN-488 D2 (Joseph, 15 Sep): "so that invited people can also get the
        # transcripts". The conftest pin is `attendees`, i.e. auto-approved.
        recipients = _email_recipients(
            self._adhoc_with_two_picked(), recorder_email="recorder@factor1.com.au"
        )
        self.assertEqual(
            recipients,
            [
                "davidahlhaus@factor1.com.au",
                "benjaminbryant@factor1.com.au",
                "recorder@factor1.com.au",
            ],
        )
