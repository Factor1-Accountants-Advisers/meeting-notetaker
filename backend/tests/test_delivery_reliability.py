import unittest
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import HTTPException

from app import store
from app.routers import meetings as meetings_router
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


class CaptureSharePointProvider:
    def __init__(self, uploads):
        self.uploads = uploads

    async def save_transcript(self, *, meeting, filename, content, access_token=None):
        self.uploads.append({"meeting": meeting, "filename": filename, "content": content, "token": access_token})
        return f"https://sharepoint.example/{filename}"


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

        with self.assertRaises(HTTPException) as raised:
            await meetings_router.email_notes(
                self.meeting_id,
                meetings_router.EmailRequest(recorder_email="joseph@example.com"),
                actor="Joseph",
                graph_token="token",
            )

        self.assertEqual(raised.exception.status_code, 502)
        meeting = store.MEETINGS[self.meeting_id]
        self.assertEqual(meeting.pipeline_status, PipelineStatus.ready)
        self.assertEqual(meeting.delivery_status, DeliveryStatus.failed)
        self.assertIn("simulated Graph send failure", meeting.delivery_error_message or "")
        self.assertEqual(store.SUMMARIES[self.meeting_id], "Summary survives delivery failure.")
        self.assertEqual(store.TRANSCRIPTS[self.meeting_id][0].text, "Transcript survives delivery failure.")

    async def test_sharepoint_save_writes_transcript_and_records_location(self):
        uploads = []
        meetings_router.get_sharepoint_provider = lambda token=None: CaptureSharePointProvider(uploads)

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
                store.MEETINGS[self.meeting_id].sharepoint_status,
                SharePointStatus.failed,
            )
            self.assertIn("sign-in", store.MEETINGS[self.meeting_id].sharepoint_error_message or "")
        finally:
            del os.environ["MN_SHAREPOINT_DRIVE_ID"]
            get_settings.cache_clear()


if __name__ == "__main__":
    unittest.main()
