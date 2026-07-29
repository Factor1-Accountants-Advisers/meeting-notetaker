"""IN-391 taxonomy wiring for the pipeline catch-all (Task 3)."""

import logging
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from app import store
from app.schemas import Meeting, MeetingSource, PipelineStatus
from app.services import pipeline


class _ExplodingSpeech:
    async def transcribe_diarized(self, audio_path, meeting):
        raise ValueError("boom SECRET")


class PipelineFailureClassificationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._old_meetings = dict(store.MEETINGS)
        self.meeting = Meeting(
            id=uuid4(),
            title="Failure classification pipeline",
            source=MeetingSource.online,
            owner_id="Joseph",
            created_at=datetime.now(timezone.utc),
            pipeline_status=PipelineStatus.queued,
        )
        store.MEETINGS[self.meeting.id] = self.meeting

    def tearDown(self):
        store.MEETINGS.clear()
        store.MEETINGS.update(self._old_meetings)

    async def test_pipeline_exception_is_classified_and_audio_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            audio_path = Path(directory) / "meeting.webm"
            audio_path.write_bytes(b"audio")

            with patch.object(pipeline, "STAGE_DELAY_S", 0), patch.object(
                pipeline, "get_speech_provider", return_value=_ExplodingSpeech()
            ):
                with self.assertLogs(
                    "app.services.failure_reasons", level=logging.WARNING
                ) as captured:
                    await pipeline.run_pipeline(
                        self.meeting.id,
                        audio_path,
                        storage_token="token-123",
                        storage_actor="Joseph",
                        recorder_email="recorder@example.com",
                    )

            meeting = store.MEETINGS[self.meeting.id]
            self.assertEqual(meeting.pipeline_status, PipelineStatus.failed)
            self.assertEqual(meeting.processing_error_code, "processing_error")
            self.assertNotIn("SECRET", meeting.processing_error_message)

            self.assertTrue(
                any("delivery_failure" in line for line in captured.output)
            )

            self.assertTrue(audio_path.exists())


if __name__ == "__main__":
    unittest.main()
