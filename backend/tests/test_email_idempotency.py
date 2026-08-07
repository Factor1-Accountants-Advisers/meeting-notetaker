"""Duplicate transcript emails must be suppressed (Jira IN-94 follow-up, IN-478).

David's report: "Adhoc meetings will have email sent to the organizer twice at
the same time." POST /email had no idempotency guard — delivery_status was
written but never read — so any second call (renderer retry after a
SharePoint-only failure, overlapping post-capture watchers) sent a second real
Graph email. The endpoint now replays the original result once a meeting is
emailed, 409s while a send is in flight, and only sends again after a genuine
failed state.

IN-478 (duplicate came back): the guard only holds while delivery state
survives the send window. Two leaks remained:

1. ``emailing``/``emailed`` were only persisted by the snapshot middleware
   *after* the response — a backend crash mid-send restarted (supervisor,
   ~1-6s) into a fully re-armed meeting while the UI reported "email was not
   sent". These tests pin that both states hit disk immediately.
2. A transport error after Graph may have accepted the message was recorded
   as a definitive ``failed`` ("resend safe"). It is now ``unconfirmed`` with
   a check-your-inbox message so a resend is an informed user choice.
"""

import json
import unittest
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import HTTPException

from app import store
from app.paths import snapshot_path
from app.routers import meetings as meetings_router
from app.schemas import (
    AccessRole,
    DeliveryStatus,
    Meeting,
    MeetingAccessEntry,
    MeetingParticipant,
    MeetingSource,
    PipelineStatus,
    TranscriptSegment,
)
from app.services.email import EmailDeliveryUnconfirmed
from app.services.pipeline import (
    reconcile_interrupted_pipelines,
    set_delivery_state,
)


class CountingEmailProvider:
    """Records every real send so tests can assert exactly-once delivery."""

    def __init__(self):
        self.sends = []

    async def send_meeting_notes(self, recipients, subject, body, **kwargs):
        self.sends.append(list(recipients))


class _EmailEndpointTestBase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._old_state = {
            "meetings": dict(store.MEETINGS),
            "access": {k: list(v) for k, v in store.ACCESS.items()},
            "summaries": dict(store.SUMMARIES),
            "participants": {k: list(v) for k, v in store.PARTICIPANTS.items()},
            "transcripts": {k: list(v) for k, v in store.TRANSCRIPTS.items()},
            "audit": list(store.AUDIT_LOG),
        }
        self._old_email_provider = meetings_router.get_email_provider
        self.provider = CountingEmailProvider()
        meetings_router.get_email_provider = lambda token=None: self.provider

        self.meeting_id = uuid4()
        store.MEETINGS[self.meeting_id] = Meeting(
            id=self.meeting_id,
            title="Adhoc double-send regression",
            source=MeetingSource.in_person,
            owner_id="joseph",
            created_at=datetime.now(timezone.utc),
            pipeline_status=PipelineStatus.ready,
        )
        store.ACCESS[self.meeting_id] = [MeetingAccessEntry(user="Joseph", role=AccessRole.owner)]
        store.SUMMARIES[self.meeting_id] = "Summary."
        store.PARTICIPANTS[self.meeting_id] = [MeetingParticipant(name="Joseph Guerrero", known=True)]
        store.TRANSCRIPTS[self.meeting_id] = [
            TranscriptSegment(
                speaker="Joseph Guerrero",
                speaker_known=True,
                start_ms=0,
                end_ms=5000,
                text="Hello.",
            )
        ]

    def tearDown(self):
        store.MEETINGS.clear(); store.MEETINGS.update(self._old_state["meetings"])
        store.ACCESS.clear(); store.ACCESS.update(self._old_state["access"])
        store.SUMMARIES.clear(); store.SUMMARIES.update(self._old_state["summaries"])
        store.PARTICIPANTS.clear(); store.PARTICIPANTS.update(self._old_state["participants"])
        store.TRANSCRIPTS.clear(); store.TRANSCRIPTS.update(self._old_state["transcripts"])
        store.AUDIT_LOG[:] = self._old_state["audit"]
        meetings_router.get_email_provider = self._old_email_provider

    async def _email(self):
        return await meetings_router.email_notes(
            self.meeting_id,
            meetings_router.EmailRequest(recorder_email="joseph@factor1.com.au"),
            actor="Joseph",
            graph_token="token",
        )

    def _persisted_delivery_status(self):
        """delivery_status for this meeting as recorded on disk, else None."""
        path = snapshot_path()
        if not path.exists():
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        return data.get("meetings", {}).get(str(self.meeting_id), {}).get("delivery_status")


class EmailIdempotencyTests(_EmailEndpointTestBase):
    async def test_second_email_call_replays_without_resending(self):
        first = await self._email()
        second = await self._email()

        self.assertEqual(len(self.provider.sends), 1, "second call must not send a second email")
        self.assertEqual(second.recipients, first.recipients)
        self.assertEqual(second.sent_at, first.sent_at)
        email_audits = [a for a in store.AUDIT_LOG if a.action == "meeting.email" and a.meeting_id == self.meeting_id]
        self.assertEqual(len(email_audits), 1, "replay must not add a second send audit")

    async def test_email_conflicts_while_send_in_flight(self):
        set_delivery_state(self.meeting_id, DeliveryStatus.emailing)

        with self.assertRaises(HTTPException) as raised:
            await self._email()

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(self.provider.sends, [])

    async def test_email_retries_after_failed_state(self):
        set_delivery_state(self.meeting_id, DeliveryStatus.failed, "earlier failure")

        result = await self._email()

        self.assertEqual(len(self.provider.sends), 1)
        self.assertEqual(result.recipients, ["joseph@factor1.com.au"])
        self.assertEqual(store.MEETINGS[self.meeting_id].delivery_status, DeliveryStatus.emailed)

    async def test_delivery_reset_clears_replay_fields(self):
        await self._email()
        self.assertTrue(store.MEETINGS[self.meeting_id].delivery_recipients)

        # kick_pipeline resets delivery to not_started on re-upload/retry; the
        # replayed recipients/timestamp must not survive into the new cycle.
        set_delivery_state(self.meeting_id, DeliveryStatus.not_started)

        meeting = store.MEETINGS[self.meeting_id]
        self.assertEqual(meeting.delivery_recipients, [])
        self.assertIsNone(meeting.delivery_emailed_at)


class EmailDeliveryDurabilityTests(_EmailEndpointTestBase):
    """IN-478: delivery state must survive a crash anywhere in the send window."""

    async def test_emailing_state_is_persisted_before_send(self):
        # A crash while the provider is mid-send must restart into `emailing`
        # (reconciled to unconfirmed), never into a re-armed not_started.
        seen: dict = {}
        outer = self

        class SnapshotReadingProvider:
            async def send_meeting_notes(self, recipients, subject, body, **kwargs):
                seen["status_on_disk"] = outer._persisted_delivery_status()

        meetings_router.get_email_provider = lambda token=None: SnapshotReadingProvider()

        await self._email()

        self.assertEqual(seen.get("status_on_disk"), "emailing")

    async def test_emailed_state_is_persisted_immediately_after_send(self):
        # Success must hit disk inside the handler — the snapshot middleware
        # only runs after the response, leaving a crash window that forgets
        # the email was ever sent.
        await self._email()

        self.assertEqual(self._persisted_delivery_status(), "emailed")

    async def test_unconfirmed_transport_error_marks_delivery_unconfirmed(self):
        class UnconfirmedProvider:
            async def send_meeting_notes(self, recipients, subject, body, **kwargs):
                raise EmailDeliveryUnconfirmed("Graph sendMail timed out after 30s")

        meetings_router.get_email_provider = lambda token=None: UnconfirmedProvider()

        with self.assertRaises(HTTPException) as raised:
            await self._email()

        self.assertEqual(raised.exception.status_code, 502)
        meeting = store.MEETINGS[self.meeting_id]
        self.assertEqual(meeting.delivery_status, DeliveryStatus.unconfirmed)
        self.assertIn("may already have been delivered", meeting.delivery_error_message or "")
        self.assertEqual(self._persisted_delivery_status(), "unconfirmed")

    async def test_definitive_send_failure_marks_delivery_failed(self):
        class RejectedProvider:
            async def send_meeting_notes(self, recipients, subject, body, **kwargs):
                raise RuntimeError("Graph sendMail failed: 400")

        meetings_router.get_email_provider = lambda token=None: RejectedProvider()

        with self.assertRaises(HTTPException) as raised:
            await self._email()

        self.assertEqual(raised.exception.status_code, 502)
        meeting = store.MEETINGS[self.meeting_id]
        self.assertEqual(meeting.delivery_status, DeliveryStatus.failed)
        self.assertNotIn("may already have been delivered", meeting.delivery_error_message or "")

    async def test_email_allowed_from_unconfirmed_state(self):
        # Resending after an unconfirmed outcome is an informed user choice —
        # the endpoint must allow it (the UI carries the check-inbox warning).
        set_delivery_state(self.meeting_id, DeliveryStatus.unconfirmed, "earlier unconfirmed attempt")

        result = await self._email()

        self.assertEqual(len(self.provider.sends), 1)
        self.assertEqual(result.recipients, ["joseph@factor1.com.au"])
        self.assertEqual(store.MEETINGS[self.meeting_id].delivery_status, DeliveryStatus.emailed)

    async def test_startup_reconcile_flips_stale_emailing_to_unconfirmed(self):
        # A restart mid-send cannot know whether Graph delivered; `failed`
        # ("resend safe") would invite a duplicate. It must become unconfirmed.
        set_delivery_state(self.meeting_id, DeliveryStatus.emailing)

        reconcile_interrupted_pipelines()

        meeting = store.MEETINGS[self.meeting_id]
        self.assertEqual(meeting.delivery_status, DeliveryStatus.unconfirmed)
        self.assertIn("may already have been delivered", meeting.delivery_error_message or "")
        self.assertEqual(meeting.pipeline_status, PipelineStatus.ready, "pipeline outputs must be untouched")
        # An unconfirmed state re-opens the (informed) retry path.
        await self._email()
        self.assertEqual(len(self.provider.sends), 1)


if __name__ == "__main__":
    unittest.main()
