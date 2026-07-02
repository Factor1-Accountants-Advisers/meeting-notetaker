import unittest
from datetime import datetime, timezone
from uuid import uuid4

from app import store
from app.schemas import DeliveryStatus, Meeting, MeetingSource, PipelineStage, PipelineStatus
from app.services.pipeline import set_delivery_state, set_pipeline_state


class PipelineStageStateTests(unittest.TestCase):
    def setUp(self):
        self._meetings = dict(store.MEETINGS)
        self.meeting_id = uuid4()
        store.MEETINGS[self.meeting_id] = Meeting(
            id=self.meeting_id,
            title="Stage state test",
            source=MeetingSource.online,
            owner_id="test-owner",
            created_at=datetime.now(timezone.utc),
        )

    def tearDown(self):
        store.MEETINGS.clear()
        store.MEETINGS.update(self._meetings)

    def test_pipeline_stage_transition_persists_user_safe_message_and_timestamp(self):
        before = datetime.now(timezone.utc)

        set_pipeline_state(
            self.meeting_id,
            PipelineStatus.processing,
            PipelineStage.transcribing_diarizing,
            "Transcribing and diarizing recording...",
        )

        meeting = store.MEETINGS[self.meeting_id]
        self.assertEqual(meeting.pipeline_status, PipelineStatus.processing)
        self.assertEqual(meeting.pipeline_stage, PipelineStage.transcribing_diarizing)
        self.assertEqual(meeting.pipeline_stage_message, "Transcribing and diarizing recording...")
        self.assertIsNotNone(meeting.pipeline_started_at)
        self.assertIsNotNone(meeting.pipeline_updated_at)
        self.assertGreaterEqual(meeting.pipeline_updated_at, before)
        self.assertIsNone(meeting.processing_error_code)
        self.assertIsNone(meeting.processing_error_message)

    def test_failed_transition_records_safe_error_and_completion_time(self):
        set_pipeline_state(
            self.meeting_id,
            PipelineStatus.failed,
            PipelineStage.failed,
            "Processing failed. The recording is saved and can be retried.",
            error_code="provider_error",
            error_message="Pyannote timed out",
        )

        meeting = store.MEETINGS[self.meeting_id]
        self.assertEqual(meeting.pipeline_status, PipelineStatus.failed)
        self.assertEqual(meeting.pipeline_stage, PipelineStage.failed)
        self.assertEqual(meeting.processing_error_code, "provider_error")
        self.assertEqual(meeting.processing_error_message, "Pyannote timed out")
        self.assertIsNotNone(meeting.pipeline_completed_at)

    def test_delivery_state_is_independent_from_pipeline_ready_state(self):
        set_pipeline_state(
            self.meeting_id,
            PipelineStatus.ready,
            PipelineStage.ready,
            "Transcript ready.",
        )

        set_delivery_state(
            self.meeting_id,
            DeliveryStatus.failed,
            "Email failed. Sign in to Outlook, then retry.",
        )

        meeting = store.MEETINGS[self.meeting_id]
        self.assertEqual(meeting.pipeline_status, PipelineStatus.ready)
        self.assertEqual(meeting.pipeline_stage, PipelineStage.ready)
        self.assertEqual(meeting.delivery_status, DeliveryStatus.failed)
        self.assertEqual(meeting.delivery_error_message, "Email failed. Sign in to Outlook, then retry.")


if __name__ == "__main__":
    unittest.main()
