import asyncio
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from uuid import uuid4

import tests.conftest_env  # noqa: F401 — isolate MN_DATA_DIR before app imports
from fastapi import HTTPException

from app.routers import meetings


class FfmpegBoundaryTests(unittest.TestCase):
    def test_parses_final_ffmpeg_progress_timestamp(self) -> None:
        stderr = "frame=1 time=00:02:03.10 speed=1x\nsize=123 time=01:17:03.42 speed=20x"
        self.assertAlmostEqual(meetings._parse_ffmpeg_output_seconds(stderr), 4623.42)

    def test_long_recording_gets_scaled_merge_timeout(self) -> None:
        self.assertGreater(meetings._merge_timeout_seconds(77 * 60), 60)

    def test_materially_short_merge_is_rejected_before_transcription(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            meetings._validate_merged_duration(uuid4(), expected_seconds=77 * 60, actual_seconds=180)
        self.assertEqual(raised.exception.status_code, 500)
        self.assertIn("shorter", raised.exception.detail.lower())

    def test_small_duration_drift_is_allowed(self) -> None:
        meetings._validate_merged_duration(uuid4(), expected_seconds=77 * 60, actual_seconds=77 * 60 - 4)


class AsyncAudioPreparationTests(unittest.IsolatedAsyncioTestCase):
    async def test_two_track_merge_does_not_block_event_loop(self) -> None:
        meeting_id = uuid4()
        with TemporaryDirectory() as temp_dir:
            expected_path = Path(temp_dir) / "merged.webm"
            expected_path.write_bytes(b"merged")

            def slow_merge(*_args, **_kwargs) -> Path:
                time.sleep(0.2)
                return expected_path

            with patch.object(meetings, "_merge_mic_and_system_audio", side_effect=slow_merge):
                started = time.perf_counter()
                task = asyncio.create_task(
                    meetings._prepare_uploaded_audio(
                        meeting_id,
                        b"m" * 1_000,
                        [(b"s" * 1_000, 0)],
                        "audio/webm",
                        77 * 60,
                    )
                )
                await asyncio.sleep(0.02)
                elapsed = time.perf_counter() - started
                self.assertLess(elapsed, 0.1, "audio preparation blocked the event loop")
                self.assertEqual(await task, expected_path)


if __name__ == "__main__":
    unittest.main()
