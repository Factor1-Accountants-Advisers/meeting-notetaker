"""IN-378 processing requests propagate delegated identity in memory only."""

import base64
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from app import store
from app.routers.meetings import retry_pipeline, upload_audio
from app.schemas import (
    AccessRole,
    Meeting,
    MeetingAccessEntry,
    MeetingSource,
    PipelineStatus,
    UploadAudioRequest,
)


class MeetingProcessingAuthTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.meeting = Meeting(
            id=uuid4(),
            title="Processing auth",
            source=MeetingSource.online,
            owner_id="Joseph",
            created_at=datetime.now(timezone.utc),
        )
        store.MEETINGS[self.meeting.id] = self.meeting
        store.ACCESS[self.meeting.id] = [
            MeetingAccessEntry(user="Joseph", role=AccessRole.owner)
        ]

    def tearDown(self):
        store.MEETINGS.pop(self.meeting.id, None)
        store.ACCESS.pop(self.meeting.id, None)

    async def test_upload_passes_storage_token_and_recorder_email_to_pipeline(self):
        prepared = Path("prepared.webm")
        body = UploadAudioRequest(
            audio_b64=base64.b64encode(b"a" * 2048).decode("ascii"),
        )

        with patch(
            "app.routers.meetings._prepare_uploaded_audio",
            new=AsyncMock(return_value=prepared),
        ), patch("app.routers.meetings.kick_pipeline") as kick:
            await upload_audio(
                self.meeting.id,
                body,
                actor="Joseph",
                storage_token=" token-123 ",
                user_email=" Recorder@Example.com ",
            )

        kick.assert_called_once_with(
            self.meeting.id,
            prepared,
            storage_token="token-123",
            recorder_email="recorder@example.com",
        )

    async def test_retry_passes_fresh_request_identity_to_pipeline(self):
        store.MEETINGS[self.meeting.id] = self.meeting.model_copy(
            update={"pipeline_status": PipelineStatus.failed}
        )
        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / "meeting.webm"
            audio.write_bytes(b"audio")
            with patch(
                "app.routers.meetings.audio_path_for",
                return_value=audio,
            ), patch("app.routers.meetings.kick_pipeline") as kick:
                await retry_pipeline(
                    self.meeting.id,
                    actor="Joseph",
                    storage_token="retry-token",
                    user_email="recorder@example.com",
                )

        kick.assert_called_once_with(
            self.meeting.id,
            audio,
            storage_token="retry-token",
            recorder_email="recorder@example.com",
        )


if __name__ == "__main__":
    unittest.main()
