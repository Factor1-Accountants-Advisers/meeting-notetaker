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
    InviteeDecision,
    ManualMeetingAttendee,
    Meeting,
    MeetingSource,
)
from app.services.recipient_policy import (
    attendee_fan_out_enabled,
    delivery_mode,
    invitees_approved,
    prompt_enabled,
)


def _meeting(
    graph_metadata=None,
    source=MeetingSource.online,
    manual_attendees=None,
    invitee_decision=InviteeDecision.pending,
):
    return Meeting(
        id=uuid4(),
        title="Test",
        source=source,
        owner_id="organizer@factor1.com.au",
        created_at=datetime.now(timezone.utc),
        graph_metadata=graph_metadata,
        manual_attendees=manual_attendees or [],
        invitee_decision=invitee_decision,
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
    def test_code_default_is_ask(self):
        # IN-488 (D10): an unconfigured build asks. It is still safe: in `ask`
        # nothing reaches an invitee without a stored approval. (conftest pins
        # MN_DELIVERY_RECIPIENTS=attendees for the rest of the suite.)
        env = {k: v for k, v in os.environ.items() if k != "MN_DELIVERY_RECIPIENTS"}
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(Settings(_env_file=None).delivery_recipients, "ask")

    def test_mode_parsing_is_tolerant_and_fails_closed_to_organizer(self):
        cases = (
            (" Attendees ", "attendees"),
            ("ASK", "ask"),
            ("organizer", "organizer"),
            # Unknown and blank values fail closed to TODAY's behaviour, not to
            # the prompt: a typo in a repo variable must not start emailing.
            ("anything-else", "organizer"),
            ("", "organizer"),
        )
        for raw, expected in cases:
            with self.subTest(raw=raw), _mode(raw):
                self.assertEqual(delivery_mode(), expected)

    def test_prompt_only_in_ask_mode(self):
        for raw, expected in (("ask", True), ("organizer", False), ("attendees", False)):
            with self.subTest(raw=raw), _mode(raw):
                self.assertEqual(prompt_enabled(), expected)

    def test_invitees_approved_matrix(self):
        # The 21 Sep "B" ruling: the kill switch stops ALL invitee delivery,
        # so a stored approval counts only while the mode is `ask`.
        expected = {
            ("ask", InviteeDecision.pending): False,
            ("ask", InviteeDecision.declined): False,
            ("ask", InviteeDecision.approved): True,
            ("organizer", InviteeDecision.pending): False,
            ("organizer", InviteeDecision.declined): False,
            ("organizer", InviteeDecision.approved): False,
            ("attendees", InviteeDecision.pending): True,
            ("attendees", InviteeDecision.declined): True,
            ("attendees", InviteeDecision.approved): True,
        }
        for (raw, decision), want in expected.items():
            with self.subTest(mode=raw, decision=decision.value), _mode(raw):
                meeting = _meeting(_scheduled(), invitee_decision=decision)
                self.assertEqual(invitees_approved(meeting), want)

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
