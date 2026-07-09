"""Watchdog flips stalled pipelines to retryable-failed (Test10 strand, 2026-07-09).

A meeting can strand at `queued` when its pipeline task never advances (e.g. an
interrupted upload). reconcile only runs at startup; the watchdog catches live
strands so the UI offers Retry instead of hanging.
"""

import unittest
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from app import store
from app.schemas import Meeting, MeetingSource, PipelineStage, PipelineStatus
from app.services.pipeline import sweep_stuck_pipelines


def _put(status, updated_at):
    mid = uuid4()
    store.MEETINGS[mid] = Meeting(
        id=mid,
        title="watchdog test",
        source=MeetingSource.online,
        owner_id="test-owner",
        created_at=datetime.now(timezone.utc),
        pipeline_status=status,
        pipeline_stage=PipelineStage.queued,
        pipeline_updated_at=updated_at,
    )
    return mid


class PipelineWatchdogTests(unittest.TestCase):
    def setUp(self):
        self._meetings = dict(store.MEETINGS)
        store.MEETINGS.clear()

    def tearDown(self):
        store.MEETINGS.clear()
        store.MEETINGS.update(self._meetings)

    def test_long_queued_meeting_is_flipped_to_retryable_failed(self):
        now = datetime.now(timezone.utc)
        mid = _put(PipelineStatus.queued, now - timedelta(minutes=5))
        self.assertEqual(sweep_stuck_pipelines(), 1)
        self.assertEqual(store.MEETINGS[mid].pipeline_status, PipelineStatus.failed)
        self.assertEqual(store.MEETINGS[mid].processing_error_code, "Stalled")

    def test_freshly_queued_meeting_is_left_alone(self):
        now = datetime.now(timezone.utc)
        mid = _put(PipelineStatus.queued, now - timedelta(seconds=5))
        self.assertEqual(sweep_stuck_pipelines(), 0)
        self.assertEqual(store.MEETINGS[mid].pipeline_status, PipelineStatus.queued)

    def test_processing_within_provider_timeout_is_left_alone(self):
        now = datetime.now(timezone.utc)
        mid = _put(PipelineStatus.processing, now - timedelta(minutes=10))
        self.assertEqual(sweep_stuck_pipelines(), 0)
        self.assertEqual(store.MEETINGS[mid].pipeline_status, PipelineStatus.processing)

    def test_ready_meeting_is_never_touched(self):
        mid = _put(PipelineStatus.ready, datetime.now(timezone.utc) - timedelta(hours=2))
        self.assertEqual(sweep_stuck_pipelines(), 0)
        self.assertEqual(store.MEETINGS[mid].pipeline_status, PipelineStatus.ready)
