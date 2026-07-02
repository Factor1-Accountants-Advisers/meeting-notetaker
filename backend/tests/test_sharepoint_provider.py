import json
import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from uuid import uuid4

from app.schemas import Meeting, MeetingSource
from app.services import sharepoint
from app.services.sharepoint import GraphSharePointProvider


class _Response:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self):
        return json.dumps({"webUrl": "https://sharepoint.example/transcript.txt"}).encode("utf-8")


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
            web_url = await provider.save_transcript(
                meeting=meeting,
                filename="minutes.txt",
                content="transcript",
                access_token="token",
            )

        self.assertEqual(web_url, "https://sharepoint.example/transcript.txt")
        self.assertEqual(
            captured_urls,
            ["https://graph.microsoft.com/v1.0/drives/drive-123/root:/minutes.txt:/content"],
        )

    async def test_graph_provider_uploads_to_configured_subfolder(self):
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


if __name__ == "__main__":
    unittest.main()
