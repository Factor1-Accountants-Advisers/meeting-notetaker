"""Upload guard: a meeting with a completed pipeline never re-processes.

Motivated by the resurface-on-restart recovery feature (25 Aug 2026): a UI
that offers to re-upload saved captures must not be able to double-transcribe
a meeting that already went through pyannote + OpenAI. The invariant lives at
the API boundary, not in the UI that proposes the upload.
"""

import base64
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from fastapi import HTTPException

from app import store
from app.routers.meetings import UploadAudioRequest, upload_audio
from app.schemas import (
    AccessRole,
    Meeting,
    MeetingAccessEntry,
    MeetingSource,
    PipelineStatus,
)


HEALTHY_AUDIO = base64.b64encode(b"a" * 2_048).decode()


class UploadReprocessGuardTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.meeting = Meeting(
            id=uuid4(),
            title="Guard test",
            source=MeetingSource.online,
            owner_id="Regina",
            created_at=datetime.now(timezone.utc),
        )
        store.MEETINGS[self.meeting.id] = self.meeting
        store.ACCESS[self.meeting.id] = [
            MeetingAccessEntry(user="Regina", role=AccessRole.owner)
        ]

    def tearDown(self):
        store.MEETINGS.pop(self.meeting.id, None)
        store.ACCESS.pop(self.meeting.id, None)

    async def _upload(self):
        with patch(
            "app.routers.meetings._prepare_uploaded_audio",
            new=AsyncMock(return_value=Path("prepared.webm")),
        ) as prepare, patch("app.routers.meetings.kick_pipeline"):
            await upload_audio(
                self.meeting.id,
                UploadAudioRequest(audio_b64=HEALTHY_AUDIO),
                actor="Regina",
            )
        return prepare

    async def test_ready_meeting_rejects_reupload(self):
        self.meeting.pipeline_status = PipelineStatus.ready
        with self.assertRaises(HTTPException) as ctx:
            await self._upload()
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("already", ctx.exception.detail.lower())

    async def test_failed_meeting_still_accepts_reupload(self):
        self.meeting.pipeline_status = PipelineStatus.failed
        prepare = await self._upload()
        self.assertTrue(prepare.await_count, "failed pipelines must stay retryable")

    async def test_pending_audio_accepts_upload(self):
        self.meeting.pipeline_status = PipelineStatus.pending_audio
        prepare = await self._upload()
        self.assertTrue(prepare.await_count)


if __name__ == "__main__":
    unittest.main()
