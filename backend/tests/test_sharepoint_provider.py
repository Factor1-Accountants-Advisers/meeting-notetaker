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

    async def test_graph_provider_grants_view_access_to_recipients(self):
        captured = {}

        def fake_urlopen(req, timeout=0):
            captured["url"] = req.full_url
            captured["method"] = req.get_method()
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return _Response(
                {"value": [{"id": "perm-1"}, {"id": "perm-2"}]}
            )

        provider = GraphSharePointProvider("drive-123", "")
        with patch("urllib.request.urlopen", fake_urlopen):
            await provider.grant_view(
                item_id="item-abc-123",
                recipients=["bb@factor1.com.au", "jt@factor1.com.au"],
                access_token="token",
            )

        self.assertEqual(
            captured["url"],
            "https://graph.microsoft.com/v1.0/drives/drive-123/items/item-abc-123/invite",
        )
        self.assertEqual(captured["method"], "POST")
        self.assertEqual(captured["body"]["roles"], ["read"])
        self.assertEqual(captured["body"]["sendInvitation"], False)
        self.assertEqual(
            captured["body"]["recipients"],
            [{"email": "bb@factor1.com.au"}, {"email": "jt@factor1.com.au"}],
        )

    async def test_graph_provider_grant_view_raises_when_response_grants_fewer_than_requested(self):
        def fake_urlopen(req, timeout=0):
            # Graph returned HTTP 200 but only resolved one of the two
            # requested recipients — a partial grant that must be treated
            # as a full failure so the caller's atomic retry logic kicks in.
            return _Response({"value": [{"id": "perm-1"}]})

        provider = GraphSharePointProvider("drive-123", "")
        with patch("urllib.request.urlopen", fake_urlopen):
            with self.assertRaises(RuntimeError):
                await provider.grant_view(
                    item_id="item-abc-123",
                    recipients=["bb@factor1.com.au", "jt@factor1.com.au"],
                    access_token="token",
                )

    async def test_graph_provider_grant_view_is_noop_for_empty_recipients(self):
        def fake_urlopen(req, timeout=0):
            raise AssertionError("should not call Graph when there are no recipients")

        provider = GraphSharePointProvider("drive-123", "")
        with patch("urllib.request.urlopen", fake_urlopen):
            await provider.grant_view(item_id="item-abc-123", recipients=[], access_token="token")

    async def test_graph_provider_grant_view_requires_token(self):
        provider = GraphSharePointProvider("drive-123", "")
        with self.assertRaises(ValueError):
            await provider.grant_view(
                item_id="item-abc-123", recipients=["bb@factor1.com.au"], access_token=None
            )

    async def test_local_provider_grant_view_is_noop(self):
        provider = sharepoint.LocalSharePointProvider()
        # Should not raise even with no real permission system behind it.
        await provider.grant_view(
            item_id="anything", recipients=["bb@factor1.com.au"], access_token=None
        )

    def test_folder_path_default_is_library_root(self):
        from app.config import Settings

        self.assertEqual(Settings().sharepoint_folder_path, "")


if __name__ == "__main__":
    unittest.main()
