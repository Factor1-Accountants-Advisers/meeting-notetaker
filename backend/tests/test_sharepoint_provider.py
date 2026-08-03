import json
import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from uuid import uuid4

from app.schemas import Meeting, MeetingSource
from app.services import sharepoint
from app.services.sharepoint import GraphSharePointProvider


class _Response:
    def __init__(self, body=None):
        self._body = (
            body
            if body is not None
            else {"webUrl": "https://sharepoint.example/transcript.txt", "id": "item-abc-123"}
        )

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self):
        return json.dumps(self._body).encode("utf-8")


class SharePointProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_graph_provider_uploads_to_library_root_when_folder_path_empty(self):
        meeting = Meeting(
            id=uuid4(),
            title="Root upload",
            source=MeetingSource.online,
            owner_id="joseph@example.com",
            created_at=datetime.now(timezone.utc),
        )
        captured_urls = []

        def fake_urlopen(req, timeout=0):
            captured_urls.append(req.full_url)
            return _Response()

        provider = GraphSharePointProvider("drive-123", "")
        with patch("urllib.request.urlopen", fake_urlopen):
            result = await provider.save_transcript(
                meeting=meeting,
                filename="minutes.txt",
                content="transcript",
                access_token="token",
            )

        self.assertEqual(result.web_url, "https://sharepoint.example/transcript.txt")
        self.assertEqual(result.item_id, "item-abc-123")
        self.assertEqual(
            captured_urls,
            ["https://graph.microsoft.com/v1.0/drives/drive-123/root:/minutes.txt:/content"],
        )

    async def test_graph_provider_uploads_to_configured_subfolder(self):
        # Exercises the still-supported explicit-subfolder code path, not the
        # current default (which is the flat library root, IN-387).
        meeting = Meeting(
            id=uuid4(),
            title="Folder upload",
            source=MeetingSource.online,
            owner_id="joseph@example.com",
            created_at=datetime.now(timezone.utc),
        )
        captured_urls = []

        def fake_urlopen(req, timeout=0):
            captured_urls.append(req.full_url)
            return _Response()

        provider = GraphSharePointProvider("drive-123", "Notetaker Transcripts")
        with patch("urllib.request.urlopen", fake_urlopen):
            await provider.save_transcript(
                meeting=meeting,
                filename="minutes.txt",
                content="transcript",
                access_token="token",
            )

        self.assertEqual(
            captured_urls,
            ["https://graph.microsoft.com/v1.0/drives/drive-123/root:/Notetaker%20Transcripts/minutes.txt:/content"],
        )
    def test_provider_factory_uses_graph_when_drive_id_is_set_and_folder_path_empty(self):
        class Settings:
            sharepoint_drive_id = "drive-123"
            sharepoint_folder_path = ""

        old_get_settings = sharepoint.get_settings
        try:
            sharepoint.get_settings = lambda: Settings()
            provider = sharepoint.get_sharepoint_provider("token")
        finally:
            sharepoint.get_settings = old_get_settings

        self.assertIsInstance(provider, GraphSharePointProvider)

    async def test_graph_provider_grants_view_access_per_recipient(self):
        # Option A (IN-398, 3 Aug): one invite request per recipient so a
        # single ungrantable attendee cannot poison the batch.
        calls = []

        def fake_urlopen(req, timeout=0):
            calls.append(
                {
                    "url": req.full_url,
                    "method": req.get_method(),
                    "body": json.loads(req.data.decode("utf-8")),
                }
            )
            return _Response({"value": [{"id": f"perm-{len(calls)}"}]})

        provider = GraphSharePointProvider("drive-123", "")
        with patch("urllib.request.urlopen", fake_urlopen):
            failed = await provider.grant_view(
                item_id="item-abc-123",
                recipients=["bb@factor1.com.au", "jt@factor1.com.au"],
                access_token="token",
            )

        self.assertEqual(failed, [])
        self.assertEqual(len(calls), 2)
        for call in calls:
            self.assertEqual(
                call["url"],
                "https://graph.microsoft.com/v1.0/drives/drive-123/items/item-abc-123/invite",
            )
            self.assertEqual(call["method"], "POST")
            self.assertEqual(call["body"]["roles"], ["read"])
            self.assertEqual(call["body"]["requireSignIn"], True)
            self.assertEqual(call["body"]["sendInvitation"], False)
        self.assertEqual(calls[0]["body"]["recipients"], [{"email": "bb@factor1.com.au"}])
        self.assertEqual(calls[1]["body"]["recipients"], [{"email": "jt@factor1.com.au"}])

    async def test_graph_provider_grant_view_reports_unresolved_recipient_and_continues(self):
        responses = iter(
            [
                _Response({"value": []}),  # Graph 200 but nobody granted
                _Response({"value": [{"id": "perm-2"}]}),
            ]
        )

        provider = GraphSharePointProvider("drive-123", "")
        with patch("urllib.request.urlopen", lambda req, timeout=0: next(responses)):
            failed = await provider.grant_view(
                item_id="item-abc-123",
                recipients=["bb@factor1.com.au", "jt@factor1.com.au"],
                access_token="token",
            )

        self.assertEqual(failed, ["bb@factor1.com.au"])

    async def test_graph_provider_grant_view_captures_http_error_body(self):
        # The 3 Aug field failure logged a bare "HTTP Error 400" with the
        # Graph error body (which names the invalid recipient) discarded.
        import io
        import urllib.error

        def fake_urlopen(req, timeout=0):
            raise urllib.error.HTTPError(
                req.full_url,
                400,
                "Bad Request",
                {},
                io.BytesIO(b'{"error":{"code":"invalidRequest","message":"cannot grant to external user"}}'),
            )

        provider = GraphSharePointProvider("drive-123", "")
        with patch("urllib.request.urlopen", fake_urlopen):
            with self.assertLogs("app.services.sharepoint", level="WARNING") as captured:
                failed = await provider.grant_view(
                    item_id="item-abc-123",
                    recipients=["guest@external.example"],
                    access_token="token",
                )

        self.assertEqual(failed, ["guest@external.example"])
        self.assertTrue(
            any("cannot grant to external user" in line for line in captured.output),
            f"Graph error body must be logged; got: {captured.output}",
        )

    async def test_graph_provider_grant_view_is_noop_for_empty_recipients(self):
        def fake_urlopen(req, timeout=0):
            raise AssertionError("should not call Graph when there are no recipients")

        provider = GraphSharePointProvider("drive-123", "")
        with patch("urllib.request.urlopen", fake_urlopen):
            failed = await provider.grant_view(item_id="item-abc-123", recipients=[], access_token="token")
        self.assertEqual(failed, [])

    async def test_graph_provider_grant_view_requires_token(self):
        provider = GraphSharePointProvider("drive-123", "")
        with self.assertRaises(ValueError):
            await provider.grant_view(
                item_id="item-abc-123", recipients=["bb@factor1.com.au"], access_token=None
            )

    async def test_local_provider_grant_view_is_noop(self):
        provider = sharepoint.LocalSharePointProvider()
        # Should not raise even with no real permission system behind it.
        failed = await provider.grant_view(
            item_id="anything", recipients=["bb@factor1.com.au"], access_token=None
        )
        self.assertEqual(failed, [])

    def test_folder_path_default_is_library_root(self):
        from app.config import Settings

        self.assertEqual(Settings().sharepoint_folder_path, "")

    def test_safe_transcript_filename_is_stable_across_retries(self):
        # IN-387 final review bug: filename must not depend on wall-clock
        # time. If a delivery upload succeeds but the subsequent grant_view
        # call fails, the whole delivery is marked failed for retry (an
        # intentional atomic-retry design). If the retry happens on a
        # different UTC calendar day, a wall-clock-based filename would
        # produce a second, differently-named upload — orphaning the first
        # file in real SharePoint with no permissions and no record of it.
        created_at = datetime(2026, 3, 1, 12, 0, 0, tzinfo=timezone.utc)

        fake_now_values = iter(
            [
                datetime(2026, 3, 1, 23, 59, 0, tzinfo=timezone.utc),
                datetime(2026, 3, 2, 0, 1, 0, tzinfo=timezone.utc),
            ]
        )

        class _FakeDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                return next(fake_now_values)

        with patch("app.services.sharepoint.datetime", _FakeDateTime):
            first = sharepoint.safe_transcript_filename("Retry meeting", created_at)
            second = sharepoint.safe_transcript_filename("Retry meeting", created_at)

        self.assertEqual(
            first,
            second,
            "filename must be stable across retries regardless of "
            "wall-clock time, or a delayed retry orphans the first "
            "uploaded file (IN-387)",
        )

    def test_safe_transcript_filename_uses_created_at_date_not_wallclock(self):
        # created_at is a fixed date in the past; wall clock is "today"
        # (mocked far in the future). The filename must reflect created_at.
        created_at = datetime(2024, 1, 15, 9, 30, 0, tzinfo=timezone.utc)

        class _FakeDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                return datetime(2026, 7, 28, 12, 0, 0, tzinfo=timezone.utc)

        with patch("app.services.sharepoint.datetime", _FakeDateTime):
            filename = sharepoint.safe_transcript_filename("Quarterly Review", created_at)

        self.assertIn("2024-01-15", filename)
        self.assertNotIn("2026-07-28", filename)

    def test_safe_transcript_filename_treats_naive_created_at_as_utc(self):
        # Mirrors test_legacy_naive_created_at_is_treated_as_utc in
        # test_blob_delivery.py for meeting_time_basis_utc: a naive (no
        # tzinfo) created_at must be treated as already-UTC, not
        # misinterpreted as local time or rejected.
        filename = sharepoint.safe_transcript_filename(
            "Legacy meeting", datetime(2026, 7, 27, 3, 4)
        )

        self.assertIn("2026-07-27", filename)

    def test_safe_summary_filename_is_paired_and_collision_safe(self):
        created_at = datetime(2026, 7, 30, 3, 4, tzinfo=timezone.utc)

        transcript = sharepoint.safe_transcript_filename(
            "Quarterly / Review",
            created_at,
        )
        summary = sharepoint.safe_summary_filename(
            "Quarterly / Review",
            created_at,
        )

        # IN-385 naming convention (Jira ticket text, confirmed 31 Jul):
        # "YYYY-MM-DD Title - Transcript.md" / "YYYY-MM-DD Title - Summary.md"
        self.assertEqual(transcript, "2026-07-30 Quarterly - Review - Transcript.md")
        self.assertEqual(summary, "2026-07-30 Quarterly - Review - Summary.md")
        self.assertNotEqual(transcript, summary)

    def test_filenames_follow_in385_date_first_md_convention(self):
        created_at = datetime(2026, 7, 31, 1, 0, tzinfo=timezone.utc)

        transcript = sharepoint.safe_transcript_filename("Weekly Standup", created_at)
        summary = sharepoint.safe_summary_filename("Weekly Standup", created_at)

        self.assertEqual(transcript, "2026-07-31 Weekly Standup - Transcript.md")
        self.assertEqual(summary, "2026-07-31 Weekly Standup - Summary.md")

    def test_empty_title_falls_back_to_meeting(self):
        created_at = datetime(2026, 7, 31, 1, 0, tzinfo=timezone.utc)

        transcript = sharepoint.safe_transcript_filename("...", created_at)

        self.assertEqual(transcript, "2026-07-31 meeting - Transcript.md")


if __name__ == "__main__":
    unittest.main()
