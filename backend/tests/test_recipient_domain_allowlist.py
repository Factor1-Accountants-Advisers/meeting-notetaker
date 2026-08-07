"""Transcripts must never leave the group's own email domains (7 Aug 2026).

Field incident: Gen had organised Benjamin's interviews but was sitting in a
different meeting when the first one started. Her notetaker auto-recorded on
the interview's calendar times, captured the *other* conversation, and then
delivered the summary + full transcript to the interview's invitee list —
which included juliannplatero@gmail.com, an external candidate. SharePoint
refused the share (tenant policy), Graph sendMail did not.

Root cause: `_email_recipients` / `_sharepoint_recipients` accepted any Graph
attendee whose address merely contained an "@".

Gate chosen by David A (7 Aug, 11:37 AEST) is a domain allowlist rather than a
voiceprint-registry check, because the registry fails closed exactly where
delivery still has to work: an invitee who has not enrolled yet, and an Azure
outage that makes the central store unreadable.
"""

import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from uuid import uuid4

from app.config import get_settings
from app.routers.meetings import _email_recipients, _sharepoint_recipients
from app.schemas import (
    GraphMeetingAttendeeMetadata,
    GraphMeetingMetadata,
    Meeting,
    MeetingSource,
)
from app.services.recipient_policy import (
    DEFAULT_DELIVERY_DOMAINS,
    allowed_delivery_domains,
    filter_deliverable,
    is_deliverable,
)


def _meeting(graph_metadata=None, source=MeetingSource.online):
    return Meeting(
        id=uuid4(),
        title="Interview - Julian Platero",
        source=source,
        owner_id="gen@factor1.com.au",
        created_at=datetime.now(timezone.utc),
        graph_metadata=graph_metadata,
    )


class DeliverableAddressTests(unittest.TestCase):
    def test_every_group_domain_is_deliverable(self):
        for domain in DEFAULT_DELIVERY_DOMAINS:
            with self.subTest(domain=domain):
                self.assertTrue(is_deliverable(f"someone@{domain}"))

    def test_external_address_from_the_incident_is_blocked(self):
        self.assertFalse(is_deliverable("juliannplatero@gmail.com"))

    def test_domain_match_is_case_insensitive(self):
        self.assertTrue(is_deliverable("Gen@Factor1.COM.AU"))

    def test_lookalike_domain_suffix_is_blocked(self):
        # The allowlist is an exact domain match, never a substring or suffix
        # test — "factor1.com.au.attacker.example" must not slip through.
        self.assertFalse(is_deliverable("mail@factor1.com.au.attacker.example"))
        self.assertFalse(is_deliverable("mail@notfactor1.com.au"))

    def test_subdomain_is_blocked(self):
        # No group mailbox lives on a subdomain; allowing them would widen the
        # allowlist to anything the attacker can name.
        self.assertFalse(is_deliverable("mail@post.factor1.com.au"))

    def test_malformed_addresses_are_blocked(self):
        for value in (None, "", "   ", "no-at-sign", "@factor1.com.au", "user@", "a@b@factor1.com.au"):
            with self.subTest(value=value):
                self.assertFalse(is_deliverable(value))

    def test_surrounding_whitespace_does_not_defeat_the_check(self):
        self.assertTrue(is_deliverable("  gen@factor1.com.au  "))


class AllowlistConfigTests(unittest.TestCase):
    def test_unset_setting_uses_the_built_in_group_domains(self):
        self.assertEqual(allowed_delivery_domains(), frozenset(DEFAULT_DELIVERY_DOMAINS))

    def test_setting_overrides_the_built_in_list(self):
        override = get_settings().model_copy(
            update={"delivery_domain_allowlist": "example.test, OTHER.test "}
        )
        with patch("app.services.recipient_policy.get_settings", return_value=override):
            self.assertEqual(allowed_delivery_domains(), frozenset({"example.test", "other.test"}))
            self.assertTrue(is_deliverable("someone@example.test"))
            self.assertFalse(is_deliverable("gen@factor1.com.au"))


class FilterDeliverableTests(unittest.TestCase):
    def test_blocked_addresses_are_dropped_and_order_preserved(self):
        kept = filter_deliverable(
            [
                "gen@factor1.com.au",
                "juliannplatero@gmail.com",
                "someone@taxopia.com.au",
            ],
            channel="email",
        )
        self.assertEqual(kept, ["gen@factor1.com.au", "someone@taxopia.com.au"])

    def test_each_blocked_address_is_logged_for_audit(self):
        meeting_id = uuid4()
        with self.assertLogs("app.services.recipient_policy", level="WARNING") as captured:
            filter_deliverable(
                ["gen@factor1.com.au", "juliannplatero@gmail.com"],
                channel="email",
                meeting_id=meeting_id,
            )
        joined = "\n".join(captured.output)
        self.assertIn("juliannplatero@gmail.com", joined)
        self.assertIn(str(meeting_id), joined)
        self.assertIn("channel=email", joined)
        self.assertNotIn("gen@factor1.com.au", joined)

    def test_all_internal_recipients_logs_nothing(self):
        with patch("app.services.recipient_policy.logger") as log:
            filter_deliverable(["gen@factor1.com.au"], channel="email")
        log.warning.assert_not_called()


class EmailRecipientAllowlistTests(unittest.TestCase):
    """The regression itself, at the function that produced it."""

    def test_external_invitee_is_never_emailed(self):
        meta = GraphMeetingMetadata(
            meeting_id="evt-interview",
            organizer_email="gen@factor1.com.au",
            attendees=[
                GraphMeetingAttendeeMetadata(email="benjaminbryant@factor1.com.au"),
                GraphMeetingAttendeeMetadata(email="juliannplatero@gmail.com"),
            ],
        )
        recipients = _email_recipients(_meeting(meta), recorder_email="gen@factor1.com.au")
        self.assertEqual(
            recipients,
            ["benjaminbryant@factor1.com.au", "gen@factor1.com.au"],
        )

    def test_sister_company_invitees_still_receive(self):
        # David A's whole reason for an allowlist over a registry check: the
        # group is six companies, and delivery must not depend on enrolment.
        meta = GraphMeetingMetadata(
            meeting_id="evt-group",
            organizer_email="gen@factor1.com.au",
            attendees=[
                GraphMeetingAttendeeMetadata(email="staff@eager.com.au"),
                GraphMeetingAttendeeMetadata(email="staff@taxopia.com.au"),
                GraphMeetingAttendeeMetadata(email="staff@jmrpartners.com.au"),
                GraphMeetingAttendeeMetadata(email="staff@astutebusiness.com.au"),
                GraphMeetingAttendeeMetadata(email="staff@kppartners.com.au"),
            ],
        )
        recipients = _email_recipients(_meeting(meta), recorder_email="gen@factor1.com.au")
        self.assertEqual(len(recipients), 6)
        self.assertNotIn("juliannplatero@gmail.com", recipients)

    def test_external_only_invitee_list_leaves_just_the_recorder(self):
        meta = GraphMeetingMetadata(
            meeting_id="evt-external",
            organizer_email="juliannplatero@gmail.com",
            attendees=[GraphMeetingAttendeeMetadata(email="other@gmail.com")],
        )
        recipients = _email_recipients(_meeting(meta), recorder_email="gen@factor1.com.au")
        self.assertEqual(recipients, ["gen@factor1.com.au"])

    def test_external_recorder_email_cannot_smuggle_itself_in(self):
        # recorder_email is the last _add and bypasses the attendee loop —
        # it must be filtered on the same terms as everything else.
        recipients = _email_recipients(
            _meeting(None, source=MeetingSource.in_person),
            recorder_email="juliannplatero@gmail.com",
        )
        self.assertEqual(recipients, [])


class SharePointRecipientAllowlistTests(unittest.TestCase):
    """Same leak, one function over — the log shows it was attempted and only
    the tenant's external-sharing policy stopped it (HTTP 400 sharingFailed)."""

    def test_external_invitee_is_never_granted_view_access(self):
        meta = GraphMeetingMetadata(
            meeting_id="evt-interview",
            organizer_email="gen@factor1.com.au",
            attendees=[
                GraphMeetingAttendeeMetadata(email="benjaminbryant@factor1.com.au"),
                GraphMeetingAttendeeMetadata(email="juliannplatero@gmail.com"),
            ],
        )
        recipients = _sharepoint_recipients(_meeting(meta))
        self.assertEqual(
            recipients,
            ["benjaminbryant@factor1.com.au", "gen@factor1.com.au"],
        )


if __name__ == "__main__":
    unittest.main()
