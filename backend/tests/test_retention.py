"""Retention must preserve retry audio until processing succeeds (IN-391)."""

import os
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from app import store
from app.schemas import Meeting, MeetingSource, PipelineStatus
from app.services import retention


class RetentionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._old_meetings = dict(store.MEETINGS)
        self._old_audit = list(store.AUDIT_LOG)
        store.MEETINGS.clear()
        store.AUDIT_LOG.clear()
        self._temp = tempfile.TemporaryDirectory()
        self.audio_root = Path(self._temp.name)
        self.settings = SimpleNamespace(audio_retention_days=30)

    def tearDown(self) -> None:
        self._temp.cleanup()
        store.MEETINGS.clear()
        store.MEETINGS.update(self._old_meetings)
        store.AUDIT_LOG[:] = self._old_audit

    def _meeting(self, status: PipelineStatus) -> Meeting:
        meeting = Meeting(
            id=uuid4(),
            title=f"Retention {status.value}",
            source=MeetingSource.online,
            owner_id="Joseph",
            created_at=datetime.now(timezone.utc),
            pipeline_status=status,
        )
        store.MEETINGS[meeting.id] = meeting
        return meeting

    def _audio(
        self,
        meeting: Meeting,
        suffix: str = ".webm",
        *,
        age_days: int = 31,
    ) -> Path:
        path = self.audio_root / f"{meeting.id}{suffix}"
        path.write_bytes(b"retry source")
        modified = time.time() - age_days * 24 * 3600
        os.utime(path, (modified, modified))
        return path

    def _sweep(self) -> int:
        with (
            patch.object(retention, "audio_dir", return_value=self.audio_root),
            patch.object(retention, "get_settings", return_value=self.settings),
            patch.object(store, "save_snapshot"),
        ):
            return retention.sweep_once()

    def test_old_ready_audio_and_mic_track_are_deleted_and_audited(self) -> None:
        meeting = self._meeting(PipelineStatus.ready)
        audio = self._audio(meeting)
        mic = self._audio(meeting, ".mic.webm")

        self.assertEqual(self._sweep(), 2)

        self.assertFalse(audio.exists())
        self.assertFalse(mic.exists())
        self.assertEqual(len(store.AUDIT_LOG), 2)
        self.assertTrue(
            all(entry.meeting_id == meeting.id for entry in store.AUDIT_LOG)
        )

    def test_old_failed_audio_is_preserved_for_retry(self) -> None:
        meeting = self._meeting(PipelineStatus.failed)
        audio = self._audio(meeting)

        self.assertEqual(self._sweep(), 0)

        self.assertTrue(audio.exists())
        self.assertEqual(store.AUDIT_LOG, [])

    def test_in_flight_and_pending_audio_are_preserved(self) -> None:
        paths = [
            self._audio(self._meeting(status))
            for status in (
                PipelineStatus.pending_audio,
                PipelineStatus.queued,
                PipelineStatus.processing,
            )
        ]

        self.assertEqual(self._sweep(), 0)

        self.assertTrue(all(path.exists() for path in paths))

    def test_old_audio_uses_original_mtime_after_retry_reaches_ready(self) -> None:
        meeting = self._meeting(PipelineStatus.failed)
        audio = self._audio(meeting)
        meeting.pipeline_status = PipelineStatus.ready

        self.assertEqual(self._sweep(), 1)

        self.assertFalse(audio.exists())

    def test_young_ready_audio_is_preserved(self) -> None:
        meeting = self._meeting(PipelineStatus.ready)
        audio = self._audio(meeting, age_days=29)

        self.assertEqual(self._sweep(), 0)

        self.assertTrue(audio.exists())

    def test_unmatched_old_audio_is_preserved_without_safe_meeting_state(self) -> None:
        orphan = self.audio_root / "orphan.webm"
        orphan.write_bytes(b"unknown")
        modified = time.time() - 31 * 24 * 3600
        os.utime(orphan, (modified, modified))

        self.assertEqual(self._sweep(), 0)

        self.assertTrue(orphan.exists())


if __name__ == "__main__":
    unittest.main()
