"""IN-387: who gets view access to a meeting's SharePoint files.

Organiser must be included explicitly — Graph's attendees array excludes the
organiser, the same gap already fixed for email in IN-94/IN-119
(test_email_recipients.py). Unlike email (which currently drops manual
attendees, see test_adhoc_recording_still_emails_recorder_only), manual/ad-hoc
attendees ARE granted SharePoint view access here — that's an intentional
IN-387 behavior difference from email, not an oversight.
"""

import unittest
from datetime import datetime, timezone
from uuid import uuid4

from app.routers.meetings import _sharepoint_recipients
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


class SharePointRecipientTests(unittest.TestCase):
    def test_calendar_meeting_includes_organizer_not_in_attendees(self):
        meta = GraphMeetingMetadata(
            meeting_id="evt-1",
            organizer_email="organizer@factor1.com.au",
            attendees=[
                GraphMeetingAttendeeMetadata(email="bb@factor1.com.au"),
                GraphMeetingAttendeeMetadata(email="jt@factor1.com.au"),
            ],
        )
        recipients = _sharepoint_recipients(_meeting(meta))
        self.assertIn("organizer@factor1.com.au", recipients)
        self.assertIn("bb@factor1.com.au", recipients)
        self.assertIn("jt@factor1.com.au", recipients)

    def test_organizer_not_duplicated_when_also_an_attendee(self):
        meta = GraphMeetingMetadata(
            meeting_id="evt-2",
            organizer_email="organizer@factor1.com.au",
            attendees=[GraphMeetingAttendeeMetadata(email="Organizer@Factor1.com.au")],
        )
        recipients = _sharepoint_recipients(_meeting(meta))
        self.assertEqual(recipients.count("organizer@factor1.com.au"), 1)

    def test_calendar_attendee_with_missing_email_is_skipped_not_fatal(self):
        meta = GraphMeetingMetadata(
            meeting_id="evt-3",
            organizer_email="organizer@factor1.com.au",
            attendees=[
                GraphMeetingAttendeeMetadata(email=None),  # e.g. a room resource
                GraphMeetingAttendeeMetadata(email="jt@factor1.com.au"),
            ],
        )
        recipients = _sharepoint_recipients(_meeting(meta))
        # Attendees are processed before the organiser is added (matching
        # _email_recipients' order), so a valid attendee lands first and the
        # organiser last — not alphabetical or input order.
        self.assertEqual(
            recipients,
            ["jt@factor1.com.au", "organizer@factor1.com.au"],
        )

    def test_all_calendar_attendees_missing_email_still_succeeds_empty(self):
        meta = GraphMeetingMetadata(
            meeting_id="evt-4",
            organizer_email=None,
            attendees=[GraphMeetingAttendeeMetadata(email=None)],
        )
        recipients = _sharepoint_recipients(_meeting(meta))
        self.assertEqual(recipients, [])

    def test_manual_recording_uses_manual_attendees(self):
        recipients = _sharepoint_recipients(
            _meeting(
                None,
                source=MeetingSource.in_person,
                manual_attendees=[
                    ManualMeetingAttendee(name="David Ahlhaus", email="davidahlhaus@factor1.com.au"),
                    ManualMeetingAttendee(name="Benjamin Bryant", email="benjaminbryant@factor1.com.au"),
                ],
            )
        )
        self.assertEqual(
            recipients,
            ["davidahlhaus@factor1.com.au", "benjaminbryant@factor1.com.au"],
        )

    def test_manual_recording_with_no_attendees_succeeds_empty(self):
        recipients = _sharepoint_recipients(_meeting(None, source=MeetingSource.in_person))
        self.assertEqual(recipients, [])

    def test_calendar_branch_wins_when_manual_attendees_also_present(self):
        # A calendar-linked meeting always carries graph_metadata; manual
        # attendees would only be populated as leftover/unused input in that
        # case. The calendar branch takes precedence and manual attendees are
        # ignored rather than merged in.
        meta = GraphMeetingMetadata(
            meeting_id="evt-5",
            organizer_email="organizer@factor1.com.au",
            attendees=[GraphMeetingAttendeeMetadata(email="bb@factor1.com.au")],
        )
        recipients = _sharepoint_recipients(
            _meeting(
                meta,
                manual_attendees=[
                    ManualMeetingAttendee(name="David Ahlhaus", email="davidahlhaus@factor1.com.au"),
                ],
            )
        )
        self.assertEqual(
            recipients,
            ["bb@factor1.com.au", "organizer@factor1.com.au"],
        )


if __name__ == "__main__":
    unittest.main()
