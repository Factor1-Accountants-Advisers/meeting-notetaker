"""IN-488: the recording owner is asked before invitees are emailed.

The decision (pending / approved / declined) and the invitee send's own
delivery state live on the Meeting, deliberately apart from delivery_status:
the organiser's send has a hard-won state machine (IN-478), and a crash in a
later invitee-only send must never erase the record that the organiser
already received theirs.
"""

import asyncio
import json
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from fastapi import HTTPException

from app import store
from app.config import get_settings
from app.paths import snapshot_path
from app.routers import meetings as meetings_router
from app.schemas import (
    AccessRole,
    DeliveryStatus,
    EmailResult,
    InviteeDecision,
    InviteeDecisionRequest,
    InviteeDeliveryStatus,
    ManualMeetingAttendee,
    Meeting,
    MeetingAccessEntry,
    MeetingParticipant,
    MeetingSource,
    PipelineStatus,
    TranscriptSegment,
)
from app.services import pipeline
from app.services.pipeline import (
    reconcile_interrupted_pipelines,
    reset_invitee_state,
    set_delivery_state,
    set_invitee_delivery_state,
)


def _mode(value: str):
    override = get_settings().model_copy(update={"delivery_recipients": value})
    return patch("app.services.recipient_policy.get_settings", return_value=override)


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


class _StoreIsolatedTestCase(unittest.IsolatedAsyncioTestCase):
    """A ready ad-hoc meeting owned by Joseph with two picked attendees."""

    def setUp(self):
        self._old_state = {
            "meetings": dict(store.MEETINGS),
            "access": {k: list(v) for k, v in store.ACCESS.items()},
            "summaries": dict(store.SUMMARIES),
            "participants": {k: list(v) for k, v in store.PARTICIPANTS.items()},
            "transcripts": {k: list(v) for k, v in store.TRANSCRIPTS.items()},
            "audit": list(store.AUDIT_LOG),
        }
        self.meeting_id = uuid4()
        store.MEETINGS[self.meeting_id] = Meeting(
            id=self.meeting_id,
            title="Innovations sync",
            source=MeetingSource.in_person,
            owner_id="joseph",
            created_at=datetime.now(timezone.utc),
            pipeline_status=PipelineStatus.ready,
            manual_attendees=[
                ManualMeetingAttendee(name="David Ahlhaus", email="da@factor1.com.au"),
                ManualMeetingAttendee(name="Mel Tran", email="mel@factor1.com.au"),
            ],
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

    def _meeting(self) -> Meeting:
        return store.MEETINGS[self.meeting_id]


class InviteeDeliveryStateTests(_StoreIsolatedTestCase):
    def test_recipients_survive_only_in_sent(self):
        invitees = ["da@factor1.com.au", "mel@factor1.com.au"]
        set_invitee_delivery_state(self.meeting_id, InviteeDeliveryStatus.sent, recipients=invitees)
        self.assertEqual(self._meeting().invitee_recipients, invitees)

        set_invitee_delivery_state(
            self.meeting_id, InviteeDeliveryStatus.failed, "boom", error_code="network"
        )
        meeting = self._meeting()
        self.assertIs(meeting.invitee_delivery_status, InviteeDeliveryStatus.failed)
        self.assertEqual(meeting.invitee_recipients, [])
        self.assertEqual(meeting.invitee_error_message, "boom")
        self.assertEqual(meeting.invitee_error_code, "network")

    def test_invitee_state_never_touches_the_organiser_record(self):
        # D7, the reason this machine exists: IN-478 clears delivery_recipients
        # on any move out of `emailed`. An invitee failure must not do that, or
        # the next retry re-emails the organiser.
        sent_at = datetime.now(timezone.utc)
        set_delivery_state(
            self.meeting_id,
            DeliveryStatus.emailed,
            recipients=["joseph@factor1.com.au"],
            emailed_at=sent_at,
        )
        for status in (
            InviteeDeliveryStatus.sending,
            InviteeDeliveryStatus.failed,
            InviteeDeliveryStatus.unconfirmed,
            InviteeDeliveryStatus.sent,
            InviteeDeliveryStatus.not_started,
        ):
            with self.subTest(status=status.value):
                set_invitee_delivery_state(self.meeting_id, status, recipients=["da@factor1.com.au"])
                meeting = self._meeting()
                self.assertIs(meeting.delivery_status, DeliveryStatus.emailed)
                self.assertEqual(meeting.delivery_recipients, ["joseph@factor1.com.au"])
                self.assertEqual(meeting.delivery_emailed_at, sent_at)

    def test_startup_reconcile_flips_stale_sending_to_unconfirmed(self):
        set_delivery_state(
            self.meeting_id,
            DeliveryStatus.emailed,
            recipients=["joseph@factor1.com.au"],
            emailed_at=datetime.now(timezone.utc),
        )
        set_invitee_delivery_state(self.meeting_id, InviteeDeliveryStatus.sending)

        reconcile_interrupted_pipelines()

        meeting = self._meeting()
        self.assertIs(meeting.invitee_delivery_status, InviteeDeliveryStatus.unconfirmed)
        self.assertIn("may already have been delivered", meeting.invitee_error_message or "")
        self.assertIsNone(meeting.invitee_error_code, "unconfirmed is not a failure category")
        self.assertIs(meeting.delivery_status, DeliveryStatus.emailed)
        self.assertEqual(meeting.delivery_recipients, ["joseph@factor1.com.au"])
        self.assertIs(meeting.pipeline_status, PipelineStatus.ready)

    def test_reset_returns_to_pending_and_not_started(self):
        store.MEETINGS[self.meeting_id] = self._meeting().model_copy(
            update={"invitee_decision": InviteeDecision.approved}
        )
        set_invitee_delivery_state(
            self.meeting_id, InviteeDeliveryStatus.sent, recipients=["da@factor1.com.au"]
        )

        reset_invitee_state(self.meeting_id)

        meeting = self._meeting()
        self.assertIs(meeting.invitee_decision, InviteeDecision.pending)
        self.assertIs(meeting.invitee_delivery_status, InviteeDeliveryStatus.not_started)
        self.assertEqual(meeting.invitee_recipients, [])

    async def test_reupload_resets_the_decision(self):
        # New content, new question: a regenerated transcript must be asked
        # about again, the same way kick_pipeline re-arms the organiser email.
        store.MEETINGS[self.meeting_id] = self._meeting().model_copy(
            update={"invitee_decision": InviteeDecision.declined}
        )
        with patch.object(pipeline, "run_pipeline", new=AsyncMock()):
            pipeline.kick_pipeline(self.meeting_id, Path("unused.webm"))
            await asyncio.sleep(0)

        meeting = self._meeting()
        self.assertIs(meeting.invitee_decision, InviteeDecision.pending)
        self.assertIs(meeting.invitee_delivery_status, InviteeDeliveryStatus.not_started)


class InviteeEndpointTests(_StoreIsolatedTestCase):
    async def _get(self, actor="Joseph"):
        return await meetings_router.get_invitees(
            self.meeting_id, recorder_email="joseph@factor1.com.au", actor=actor
        )

    async def _decide(self, approved: bool, source: str = "app", actor="Joseph"):
        return await meetings_router.record_invitee_decision(
            self.meeting_id,
            InviteeDecisionRequest(approved=approved, source=source),
            actor=actor,
        )

    def _decision_audits(self):
        return [
            a for a in store.AUDIT_LOG
            if a.action == "meeting.invitee_decision" and a.meeting_id == self.meeting_id
        ]

    async def test_get_reports_candidates_and_pending_in_ask_mode(self):
        with _mode("ask"):
            state = await self._get()
        self.assertEqual(
            [(c.name, c.email) for c in state.candidates],
            [("David Ahlhaus", "da@factor1.com.au"), ("Mel Tran", "mel@factor1.com.au")],
        )
        self.assertIs(state.decision, InviteeDecision.pending)
        self.assertIs(state.invitee_delivery_status, InviteeDeliveryStatus.not_started)
        self.assertEqual(state.invitee_recipients, [])
        self.assertTrue(state.prompt_enabled)

    async def test_get_reports_the_effective_decision_per_mode(self):
        with _mode("attendees"):
            state = await self._get()
            self.assertIs(state.decision, InviteeDecision.approved)
            self.assertFalse(state.prompt_enabled)
        with _mode("organizer"):
            state = await self._get()
            # The stored value is reported as is; prompt_enabled=False is what
            # tells the desktop not to ask and not to offer "Send to N".
            self.assertIs(state.decision, InviteeDecision.pending)
            self.assertFalse(state.prompt_enabled)

    async def test_get_is_owner_only(self):
        store.ACCESS[self.meeting_id] = [
            MeetingAccessEntry(user="Joseph", role=AccessRole.owner),
            MeetingAccessEntry(user="Editor", role=AccessRole.editor),
        ]
        with self.assertRaises(HTTPException) as raised:
            await self._get(actor="Editor")
        self.assertEqual(raised.exception.status_code, 403)
        with self.assertRaises(HTTPException) as raised:
            await self._get(actor="Stranger")
        self.assertEqual(raised.exception.status_code, 404)

    async def test_pending_to_approved_is_audited_with_its_source(self):
        meeting = await self._decide(True, source="toast")
        self.assertIs(meeting.invitee_decision, InviteeDecision.approved)
        audits = self._decision_audits()
        self.assertEqual(len(audits), 1)
        self.assertEqual(audits[0].before, "pending")
        self.assertEqual(audits[0].after, "approved (toast)")

    async def test_timeout_is_stored_as_declined(self):
        meeting = await self._decide(False, source="timeout")
        self.assertIs(meeting.invitee_decision, InviteeDecision.declined)
        self.assertEqual(self._decision_audits()[0].after, "declined (timeout)")

    async def test_declined_to_approved_is_the_send_later_path(self):
        await self._decide(False, source="timeout")
        meeting = await self._decide(True, source="app")
        self.assertIs(meeting.invitee_decision, InviteeDecision.approved)
        self.assertEqual(len(self._decision_audits()), 2)

    async def test_repeating_the_same_answer_is_a_silent_no_op(self):
        await self._decide(True)
        await self._decide(True)
        self.assertEqual(len(self._decision_audits()), 1)

    async def test_approved_is_final(self):
        # Q4: a timeout (or a decline) that reaches the backend after an
        # approve is rejected, whether or not the send has finished.
        await self._decide(True, source="app")
        with self.assertRaises(HTTPException) as raised:
            await self._decide(False, source="timeout")
        self.assertEqual(raised.exception.status_code, 409)
        self.assertIs(self._meeting().invitee_decision, InviteeDecision.approved)

    async def test_decision_is_persisted_on_its_own_request(self):
        # "Backend unreachable mid-pass" must not lose the answer: it hits disk
        # here, not when the snapshot middleware runs after some later call.
        await self._decide(True)
        data = json.loads(snapshot_path().read_text(encoding="utf-8"))
        self.assertEqual(
            data["meetings"][str(self.meeting_id)]["invitee_decision"], "approved"
        )

    async def test_decision_is_owner_only(self):
        store.ACCESS[self.meeting_id] = [
            MeetingAccessEntry(user="Joseph", role=AccessRole.owner),
            MeetingAccessEntry(user="Editor", role=AccessRole.editor),
        ]
        with self.assertRaises(HTTPException) as raised:
            await self._decide(True, actor="Editor")
        self.assertEqual(raised.exception.status_code, 403)
        self.assertIs(self._meeting().invitee_decision, InviteeDecision.pending)

    async def test_unknown_meeting_is_404(self):
        with self.assertRaises(HTTPException) as raised:
            await meetings_router.get_invitees(uuid4(), recorder_email=None, actor="Joseph")
        self.assertEqual(raised.exception.status_code, 404)
        with self.assertRaises(HTTPException) as raised:
            await meetings_router.record_invitee_decision(
                uuid4(), InviteeDecisionRequest(approved=True, source="app"), actor="Joseph"
            )
        self.assertEqual(raised.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
