"""Segmented system-audio merge (IN-468).

A mid-recording output-device switch forces the renderer to restart its
loopback MediaRecorder, so system audio arrives as N webm segments with
timeline offsets. The backend must place each segment at its offset
(adelay) and mix all of them with the mic track — a plain 2-input amix
would drop everything after the first segment.
"""

from __future__ import annotations

import base64
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

import tests.conftest_env  # noqa: F401 — isolate MN_DATA_DIR before app imports
from pydantic import ValidationError

from app.routers import meetings
from app.schemas import SystemAudioSegment, UploadAudioRequest


class BuildSegmentMergeFilterTests(unittest.TestCase):
    def test_single_segment_at_zero_offset(self) -> None:
        self.assertEqual(
            meetings._build_segment_merge_filter([0]),
            "[1:a]adelay=delays=0:all=1[s0];"
            "[0:a][s0]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[a]",
        )

    def test_two_segments_with_offsets(self) -> None:
        self.assertEqual(
            meetings._build_segment_merge_filter([0, 130000]),
            "[1:a]adelay=delays=0:all=1[s0];"
            "[2:a]adelay=delays=130000:all=1[s1];"
            "[0:a][s0][s1]amix=inputs=3:duration=longest:dropout_transition=0:normalize=0[a]",
        )

    def test_rejects_empty_and_negative_offsets(self) -> None:
        with self.assertRaises(ValueError):
            meetings._build_segment_merge_filter([])
        with self.assertRaises(ValueError):
            meetings._build_segment_merge_filter([0, -5])


class UploadSchemaSegmentTests(unittest.TestCase):
    def test_accepts_system_segments(self) -> None:
        body = UploadAudioRequest(
            audio_b64="QUJD",
            system_segments=[
                SystemAudioSegment(audio_b64="QUJD", offset_ms=0),
                SystemAudioSegment(audio_b64="QUJD", offset_ms=90_500),
            ],
        )
        self.assertEqual(len(body.system_segments or []), 2)

    def test_rejects_negative_segment_offset(self) -> None:
        with self.assertRaises(ValidationError):
            SystemAudioSegment(audio_b64="QUJD", offset_ms=-1)


class DecodeSystemSegmentsTests(unittest.TestCase):
    B64 = base64.b64encode(b"x" * 1_200).decode()

    def test_legacy_single_system_blob_becomes_zero_offset_segment(self) -> None:
        body = UploadAudioRequest(audio_b64=self.B64, system_audio_b64=self.B64)
        segments = meetings._decode_system_segments(body)
        self.assertEqual([offset for _, offset in segments], [0])

    def test_segments_decoded_and_sorted_by_offset(self) -> None:
        body = UploadAudioRequest(
            audio_b64=self.B64,
            system_segments=[
                SystemAudioSegment(audio_b64=self.B64, offset_ms=90_000),
                SystemAudioSegment(audio_b64=self.B64, offset_ms=0),
            ],
        )
        segments = meetings._decode_system_segments(body)
        self.assertEqual([offset for _, offset in segments], [0, 90_000])
        self.assertTrue(all(isinstance(data, bytes) for data, _ in segments))

    def test_no_system_audio_returns_empty_list(self) -> None:
        body = UploadAudioRequest(audio_b64=self.B64)
        self.assertEqual(meetings._decode_system_segments(body), [])


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not on PATH")
class SegmentMergeFfmpegIntegrationTests(unittest.TestCase):
    """Real-ffmpeg proof that a delayed segment lands at its offset."""

    def _tone(self, path: Path, seconds: float, hz: int) -> bytes:
        subprocess.run(
            [
                "ffmpeg", "-y", "-f", "lavfi",
                "-i", f"sine=frequency={hz}:duration={seconds}",
                "-c:a", "libopus", str(path),
            ],
            capture_output=True, check=True,
        )
        return path.read_bytes()

    def _duration(self, path: Path) -> float:
        out = subprocess.run(
            [
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", str(path),
            ],
            capture_output=True, text=True, check=True,
        )
        return float(out.stdout.strip())

    def test_merged_output_spans_last_segment_offset_plus_length(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            mic = self._tone(tmp_path / "mic.webm", 2.0, 300)
            seg0 = self._tone(tmp_path / "s0.webm", 2.0, 600)
            seg1 = self._tone(tmp_path / "s1.webm", 2.0, 900)

            from unittest.mock import patch

            meeting_id = uuid4()
            with patch.object(meetings, "audio_dir", return_value=tmp_path), patch.object(
                meetings, "mic_track_path", return_value=tmp_path / f"{meeting_id}.mic.webm"
            ):
                merged = meetings._merge_mic_and_system_audio(
                    meeting_id,
                    mic,
                    [(seg0, 0), (seg1, 8_000)],
                    expected_seconds=10,
                )
                # Segment at 8s offset + 2s length → merged file ≈ 10s.
                self.assertAlmostEqual(self._duration(merged), 10.0, delta=0.5)


if __name__ == "__main__":
    unittest.main()
