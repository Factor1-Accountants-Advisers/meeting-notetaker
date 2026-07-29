import logging
import unittest
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import HTTPException

from app import store
from app.routers import meetings as meetings_router
from app.services import sharepoint
from app.services.email import EmailDeliveryUnconfirmed
from app.services.failure_reasons import FailureCategory, USER_SENTENCES
from app.schemas import (
    AccessRole,
    ActionItem,
    ActionItemStatus,
    DeliveryStatus,
    Meeting,
    MeetingAccessEntry,
    MeetingParticipant,
    MeetingSource,
    PipelineStatus,
    Priority,
    SharePointStatus,
    TranscriptSegment,
)


class FailingEmailProvider:
    async def send_meeting_notes(self, *args, **kwargs):
        raise RuntimeError("simulated Graph send failure")


class UnconfirmedEmailProvider:
    async def send_meeting_notes(self, *args, **kwargs):
        raise EmailDeliveryUnconfirmed("simulated Graph timeout after send")


class _FakeHttpError(Exception):
    """HTTP-shaped error fake, mirroring test_failure_reasons.py's."""

    def __init__(self, status_code: int) -> None:
        super().__init__(f"HTTP {status_code}")
        self.status_code = status_code


class UnavailableSharePointProvider:
    async def save_transcript(self, *, meeting, filename, content, access_token=None):
        raise _FakeHttpError(503)

    async def grant_view(self, *, item_id, recipients, access_token=None):  # pragma: no cover - not reached
        raise AssertionError("grant_view should not be reached when save_transcript fails")


class CaptureSharePointProvider:
    def __init__(self, uploads, grants, fail_grant=False):
        self.uploads = uploads
        self.grants = grants
        self.fail_grant = fail_grant

    async def save_transcript(self, *, meeting, filename, content, access_token=None):
        self.uploads.append({"meeting": meeting, "filename": filename, "content": content, "token": access_token})
        return sharepoint.SharePointUploadResult(
            web_url=f"https://sharepoint.example/{filename}",
            item_id="item-test-1",
        )

    async def grant_view(self, *, item_id, recipients, access_token=None):
        if self.fail_grant:
            raise RuntimeError("simulated Graph invite failure")
        self.grants.append({"item_id": item_id, "recipients": recipients, "token": access_token})


class DeliveryReliabilityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._old_state = {
            "meetings": dict(store.MEETINGS),
            "access": {k: list(v) for k, v in store.ACCESS.items()},
            "summaries": dict(store.SUMMARIES),
            "participants": {k: list(v) for k, v in store.PARTICIPANTS.items()},
            "transcripts": {k: list(v) for k, v in store.TRANSCRIPTS.items()},
            "actions": dict(store.ACTION_ITEMS),
            "audit": list(store.AUDIT_LOG),
        }
        self._old_email_provider = meetings_router.get_email_provider
        self._old_sharepoint_provider = meetings_router.get_sharepoint_provider
        self.meeting_id = uuid4()
        meeting = Meeting(
            id=self.meeting_id,
            title="Delivery reliability smoke",
            source=MeetingSource.in_person,
            owner_id="joseph",
            created_at=datetime.now(timezone.utc),
            pipeline_status=PipelineStatus.ready,
        )
        store.MEETINGS[self.meeting_id] = meeting
        store.ACCESS[self.meeting_id] = [MeetingAccessEntry(user="Joseph", role=AccessRole.owner)]
        store.SUMMARIES[self.meeting_id] = "Summary survives delivery failure."
        store.PARTICIPANTS[self.meeting_id] = [MeetingParticipant(name="Joseph Guerrero", known=True)]
        store.TRANSCRIPTS[self.meeting_id] = [
            TranscriptSegment(
                speaker="Joseph Guerrero",
                speaker_known=True,
                start_ms=0,
                end_ms=5000,
                text="Transcript survives delivery failure.",
            )
        ]
        store.ACTION_ITEMS[uuid4()] = ActionItem(
            id=uuid4(),
            meeting_id=self.meeting_id,
            owner="Joseph Guerrero",
            description="Verify delivery reliability",
            deadline=None,
            priority=Priority.high,
            status=ActionItemStatus.open,
        )

    def tearDown(self):
        store.MEETINGS.clear(); store.MEETINGS.update(self._old_state["meetings"])
        store.ACCESS.clear(); store.ACCESS.update(self._old_state["access"])
        store.SUMMARIES.clear(); store.SUMMARIES.update(self._old_state["summaries"])
        store.PARTICIPANTS.clear(); store.PARTICIPANTS.update(self._old_state["participants"])
        store.TRANSCRIPTS.clear(); store.TRANSCRIPTS.update(self._old_state["transcripts"])
        store.ACTION_ITEMS.clear(); store.ACTION_ITEMS.update(self._old_state["actions"])
        store.AUDIT_LOG[:] = self._old_state["audit"]
        meetings_router.get_email_provider = self._old_email_provider
        meetings_router.get_sharepoint_provider = self._old_sharepoint_provider

    async def test_email_failure_marks_retryable_delivery_without_losing_outputs(self):
        meetings_router.get_email_provider = lambda token=None: FailingEmailProvider()

        with self.assertLogs("app.services.failure_reasons", level=logging.WARNING) as captured:
            with self.assertRaises(HTTPException) as raised:
                await meetings_router.email_notes(
                    self.meeting_id,
                    meetings_router.EmailRequest(recorder_email="joseph@example.com"),
                    actor="Joseph",
                    graph_token="token",
                )

        self.assertEqual(raised.exception.status_code, 502)
        # HTTPException detail still carries the raw exception text for the
        # transient toast (intentionally NOT the stored field).
        self.assertIn("simulated Graph send failure", str(raised.exception.detail))
        meeting = store.MEETINGS[self.meeting_id]
        self.assertEqual(meeting.pipeline_status, PipelineStatus.ready)
        self.assertEqual(meeting.delivery_status, DeliveryStatus.failed)
        self.assertEqual(meeting.delivery_error_code, "processing_error")
        self.assertEqual(
            meeting.delivery_error_message,
            USER_SENTENCES[FailureCategory.processing_error],
        )
        self.assertNotIn("simulated", meeting.delivery_error_message or "")
        self.assertTrue(any("stage=email" in line for line in captured.output))
        self.assertEqual(store.SUMMARIES[self.meeting_id], "Summary survives delivery failure.")
        self.assertEqual(store.TRANSCRIPTS[self.meeting_id][0].text, "Transcript survives delivery failure.")

    async def test_email_missing_token_sets_azure_signin_code_and_keeps_wording(self):
        with self.assertRaises(HTTPException) as raised:
            await meetings_router.email_notes(
                self.meeting_id,
                meetings_router.EmailRequest(recorder_email="joseph@example.com"),
                actor="Joseph",
                graph_token="",
            )

        self.assertEqual(raised.exception.status_code, 401)
        self.assertEqual(
            raised.exception.detail,
            "Outlook sign-in is required before transcript email can be sent",
        )
        meeting = store.MEETINGS[self.meeting_id]
        self.assertEqual(meeting.delivery_status, DeliveryStatus.failed)
        self.assertEqual(meeting.delivery_error_code, "azure_signin")
        self.assertEqual(
            meeting.delivery_error_message,
            "Outlook sign-in is required before transcript email can be sent",
        )

    async def test_email_unconfirmed_has_no_error_code_and_unchanged_wording(self):
        """Regression pin for IN-478: unconfirmed semantics/wording untouched."""
        meetings_router.get_email_provider = lambda token=None: UnconfirmedEmailProvider()

        with self.assertRaises(HTTPException) as raised:
            await meetings_router.email_notes(
                self.meeting_id,
                meetings_router.EmailRequest(recorder_email="joseph@example.com"),
                actor="Joseph",
                graph_token="token",
            )

        self.assertEqual(raised.exception.status_code, 502)
        meeting = store.MEETINGS[self.meeting_id]
        self.assertEqual(meeting.delivery_status, DeliveryStatus.unconfirmed)
        self.assertIsNone(meeting.delivery_error_code)
        self.assertEqual(
            meeting.delivery_error_message,
            "The transcript email attempt was not confirmed — it may already "
            "have been delivered. Check your inbox before resending.",
        )

    async def test_sharepoint_save_writes_transcript_and_records_location(self):
        uploads = []
        grants = []
        meetings_router.get_sharepoint_provider = lambda token=None: CaptureSharePointProvider(uploads, grants)

        result = await meetings_router.save_transcript_to_sharepoint(
            self.meeting_id,
            actor="Joseph",
            graph_token="token",
        )

        self.assertEqual(result.sharepoint_status, SharePointStatus.saved)
        self.assertEqual(result.sharepoint_web_url, store.MEETINGS[self.meeting_id].sharepoint_web_url)
        self.assertEqual(store.MEETINGS[self.meeting_id].sharepoint_status, SharePointStatus.saved)
        self.assertEqual(store.MEETINGS[self.meeting_id].sharepoint_error_message, None)
        self.assertEqual(len(uploads), 1)
        self.assertIn("--- TRANSCRIPT ---", uploads[0]["content"])
        self.assertIn("Summary survives delivery failure.", uploads[0]["content"])
        self.assertEqual(len(grants), 1)
        self.assertEqual(grants[0]["item_id"], "item-test-1")
        self.assertEqual(grants[0]["recipients"], [])

    async def test_sharepoint_grant_failure_marks_whole_delivery_failed_and_retry_recovers(self):
        uploads = []
        grants = []
        meetings_router.get_sharepoint_provider = lambda token=None: CaptureSharePointProvider(
            uploads, grants, fail_grant=True
        )

        with self.assertLogs("app.services.failure_reasons", level=logging.WARNING) as captured:
            with self.assertRaises(HTTPException) as raised:
                await meetings_router.save_transcript_to_sharepoint(
                    self.meeting_id,
                    actor="Joseph",
                    graph_token="token",
                )
        self.assertEqual(raised.exception.status_code, 502)
        # HTTPException detail still carries the raw exception text for the
        # transient toast (intentionally NOT the stored field).
        self.assertIn("simulated Graph invite failure", str(raised.exception.detail))
        meeting = store.MEETINGS[self.meeting_id]
        self.assertEqual(meeting.sharepoint_status, SharePointStatus.failed)
        self.assertEqual(meeting.sharepoint_error_code, "processing_error")
        self.assertEqual(
            meeting.sharepoint_error_message,
            USER_SENTENCES[FailureCategory.processing_error],
        )
        self.assertNotIn("simulated", meeting.sharepoint_error_message or "")
        self.assertTrue(any("stage=sharepoint" in line for line in captured.output))
        self.assertEqual(len(uploads), 1)
        self.assertEqual(len(grants), 0)

        # Retry with a working provider re-runs both steps from scratch.
        meetings_router.get_sharepoint_provider = lambda token=None: CaptureSharePointProvider(uploads, grants)
        result = await meetings_router.save_transcript_to_sharepoint(
            self.meeting_id,
            actor="Joseph",
            graph_token="token",
        )
        self.assertEqual(result.sharepoint_status, SharePointStatus.saved)
        self.assertEqual(len(uploads), 2)
        self.assertEqual(len(grants), 1)

    async def test_email_acl_rejects_viewer(self):
        """D2: viewer-role actor cannot send email."""
        store.ACCESS[self.meeting_id] = [
            MeetingAccessEntry(user="Joseph", role=AccessRole.owner),
            MeetingAccessEntry(user="Viewer", role=AccessRole.viewer),
        ]
        with self.assertRaises(HTTPException) as raised:
            await meetings_router.email_notes(
                self.meeting_id,
                meetings_router.EmailRequest(recorder_email="joseph@example.com"),
                actor="Viewer",
                graph_token="token",
            )
        self.assertEqual(raised.exception.status_code, 403)

    async def test_email_owner_still_sends(self):
        """D2: owner-role actor can still send email."""
        store.ACCESS[self.meeting_id] = [
            MeetingAccessEntry(user="Joseph", role=AccessRole.owner),
            MeetingAccessEntry(user="Viewer", role=AccessRole.viewer),
        ]
        # Owner with token should pass ACL and reach the send attempt
        with self.assertRaises(HTTPException) as raised:
            await meetings_router.email_notes(
                self.meeting_id,
                meetings_router.EmailRequest(recorder_email="joseph@example.com"),
                actor="Joseph",
                graph_token="token",
            )
        # 502 = provider failure (no real provider in test), proving ACL passed
        self.assertEqual(raised.exception.status_code, 502)

    async def test_sharepoint_service_unavailable_status_sets_error_code_and_sentence(self):
        meetings_router.get_sharepoint_provider = lambda token=None: UnavailableSharePointProvider()

        with self.assertLogs("app.services.failure_reasons", level=logging.WARNING) as captured:
            with self.assertRaises(HTTPException) as raised:
                await meetings_router.save_transcript_to_sharepoint(
                    self.meeting_id,
                    actor="Joseph",
                    graph_token="token",
                )

        self.assertEqual(raised.exception.status_code, 502)
        meeting = store.MEETINGS[self.meeting_id]
        self.assertEqual(meeting.sharepoint_status, SharePointStatus.failed)
        self.assertEqual(meeting.sharepoint_error_code, "service_unavailable")
        self.assertEqual(
            meeting.sharepoint_error_message,
            USER_SENTENCES[FailureCategory.service_unavailable],
        )
        self.assertTrue(any("stage=sharepoint" in line for line in captured.output))

    async def test_sharepoint_configured_drive_no_token_returns_401(self):
        """D1: configured SharePoint drive + missing token → 401."""
        from app.config import get_settings

        # Temporarily set sharepoint_drive_id via env
        import os
        os.environ["MN_SHAREPOINT_DRIVE_ID"] = "fake-drive-id"
        get_settings.cache_clear()
        try:
            with self.assertRaises(HTTPException) as raised:
                await meetings_router.save_transcript_to_sharepoint(
                    self.meeting_id,
                    actor="Joseph",
                    graph_token="",  # Explicit empty for direct call (bypasses Header injection)
                )
            self.assertEqual(raised.exception.status_code, 401)
            self.assertEqual(
                raised.exception.detail,
                "SharePoint sign-in is required before transcript can be saved",
            )
            meeting = store.MEETINGS[self.meeting_id]
            self.assertEqual(meeting.sharepoint_status, SharePointStatus.failed)
            self.assertEqual(meeting.sharepoint_error_code, "azure_signin")
            self.assertEqual(
                meeting.sharepoint_error_message,
                "SharePoint sign-in is required before transcript can be saved",
            )
        finally:
            del os.environ["MN_SHAREPOINT_DRIVE_ID"]
            get_settings.cache_clear()


if __name__ == "__main__":
    unittest.main()
