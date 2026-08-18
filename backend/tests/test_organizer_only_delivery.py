"""Temporary organiser-only delivery (David F via David A, 18 Aug 2026).

A user's Notetaker auto-recorded a scheduled meeting while they were still
in an unrelated in-person client conversation; that transcript went to the
meeting's invitees. Until the recording trigger is tied to actually joining
the meeting, transcripts go to the recording owner only — no invitee fan-out
by email, and no per-file SharePoint grants (which would surface the file in
invitees' "Shared with me" even without an email).

``MN_DELIVERY_RECIPIENTS=attendees`` restores the full IN-93/IN-387
behaviour. The code default is the restrictive mode: an unconfigured build
must never fan out.
"""

import os
import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from uuid import uuid4

from app.config import Settings, get_settings
from app.routers.meetings import _email_recipients, _sharepoint_recipients
from app.schemas import (
    GraphMeetingAttendeeMetadata,
    GraphMeetingMetadata,
    ManualMeetingAttendee,
    Meeting,
    MeetingSource,
)
from app.services.recipient_policy import attendee_fan_out_enabled


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


def _scheduled():
    return GraphMeetingMetadata(
        meeting_id="evt-1",
        organizer_email="organizer@factor1.com.au",
        attendees=[
            GraphMeetingAttendeeMetadata(email="bb@factor1.com.au"),
            GraphMeetingAttendeeMetadata(email="jt@factor1.com.au"),
        ],
    )


def _mode(value: str):
    override = get_settings().model_copy(update={"delivery_recipients": value})
    return patch("app.services.recipient_policy.get_settings", return_value=override)


class OrganizerOnlyDeliveryTests(unittest.TestCase):
    def test_code_default_is_organizer_only(self):
        # Fresh Settings() with no env: the restrictive mode must be the
        # default so an unconfigured build never fans out. (conftest pins
        # MN_DELIVERY_RECIPIENTS=attendees for the rest of the suite.)
        env = {k: v for k, v in os.environ.items() if k != "MN_DELIVERY_RECIPIENTS"}
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(Settings(_env_file=None).delivery_recipients, "organizer")

    def test_mode_parsing_is_tolerant(self):
        with _mode(" Attendees "):
            self.assertTrue(attendee_fan_out_enabled())
        with _mode("organizer"):
            self.assertFalse(attendee_fan_out_enabled())
        with _mode("anything-else"):
            # Unknown values fail closed to organiser-only.
            self.assertFalse(attendee_fan_out_enabled())

    def test_email_scheduled_meeting_goes_to_organizer_only(self):
        with _mode("organizer"):
            recipients = _email_recipients(_meeting(_scheduled()), "organizer@factor1.com.au")
        self.assertEqual(recipients, ["organizer@factor1.com.au"])

    def test_email_recorder_still_receives_ad_hoc(self):
        with _mode("organizer"):
            recipients = _email_recipients(
                _meeting(source=MeetingSource.in_person), "recorder@factor1.com.au"
            )
        self.assertEqual(recipients, ["recorder@factor1.com.au"])

    def test_sharepoint_scheduled_meeting_grants_nobody_but_organizer(self):
        with _mode("organizer"):
            recipients = _sharepoint_recipients(_meeting(_scheduled()))
        # The organiser is the uploader and already has folder access; the
        # grant is harmless. What matters is that no invitee appears.
        self.assertEqual(recipients, ["organizer@factor1.com.au"])

    def test_sharepoint_manual_attendees_are_not_granted(self):
        with _mode("organizer"):
            recipients = _sharepoint_recipients(
                _meeting(
                    source=MeetingSource.in_person,
                    manual_attendees=[ManualMeetingAttendee(email="bb@factor1.com.au")],
                )
            )
        self.assertEqual(recipients, [])

    def test_attendees_mode_restores_fan_out(self):
        with _mode("attendees"):
            email = _email_recipients(_meeting(_scheduled()), "organizer@factor1.com.au")
            sharepoint = _sharepoint_recipients(_meeting(_scheduled()))
        self.assertEqual(
            email, ["bb@factor1.com.au", "jt@factor1.com.au", "organizer@factor1.com.au"]
        )
        self.assertEqual(
            sharepoint, ["bb@factor1.com.au", "jt@factor1.com.au", "organizer@factor1.com.au"]
        )


if __name__ == "__main__":
    unittest.main()
