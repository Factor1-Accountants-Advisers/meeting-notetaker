"""IN-488: the recording owner is asked before invitees are emailed.

The decision (pending / approved / declined) and the invitee send's own
delivery state live on the Meeting, deliberately apart from delivery_status:
the organiser's send has a hard-won state machine (IN-478), and a crash in a
later invitee-only send must never erase the record that the organiser
already received theirs.
"""

import unittest
from datetime import datetime, timezone
from uuid import uuid4

from app.schemas import (
    EmailResult,
    InviteeDecision,
    InviteeDeliveryStatus,
    Meeting,
    MeetingSource,
)


class InviteeStateSchemaTests(unittest.TestCase):
    def test_new_meeting_starts_pending_and_not_started(self):
        meeting = Meeting(
            id=uuid4(),
            title="Test",
            source=MeetingSource.online,
            owner_id="joseph",
            created_at=datetime.now(timezone.utc),
        )
        self.assertIs(meeting.invitee_decision, InviteeDecision.pending)
        self.assertIs(meeting.invitee_delivery_status, InviteeDeliveryStatus.not_started)
        self.assertEqual(meeting.invitee_recipients, [])
        self.assertIsNone(meeting.invitee_error_message)
        self.assertIsNone(meeting.invitee_error_code)

    def test_snapshot_written_before_in488_still_loads(self):
        # store.load_snapshot runs Meeting.model_validate over dicts written by
        # older app versions, which carry none of the invitee_* keys. Every
        # fleet machine has such a store.json on the day this ships.
        legacy = {
            "id": str(uuid4()),
            "title": "Recorded on v2.0.39",
            "source": "online",
            "owner_id": "joseph",
            "created_at": "2026-09-01T00:00:00Z",
            "delivery_status": "emailed",
            "delivery_recipients": ["joseph@factor1.com.au"],
        }
        meeting = Meeting.model_validate(legacy)
        self.assertIs(meeting.invitee_decision, InviteeDecision.pending)
        self.assertIs(meeting.invitee_delivery_status, InviteeDeliveryStatus.not_started)
        self.assertEqual(meeting.delivery_recipients, ["joseph@factor1.com.au"])

    def test_email_result_sent_now_defaults_empty(self):
        result = EmailResult(
            recipients=["joseph@factor1.com.au"],
            sent_at=datetime.now(timezone.utc),
        )
        self.assertEqual(result.sent_now, [])


if __name__ == "__main__":
    unittest.main()
