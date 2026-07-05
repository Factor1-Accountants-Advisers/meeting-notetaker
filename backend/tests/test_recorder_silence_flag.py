import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from uuid import uuid4

from app.routers.meetings import _format_transcript
from app.schemas import Meeting, MeetingSource
from app.services import audio_checks


FFMPEG_SILENT = """[Parsed_volumedetect_0 @ 0x60f59ca72d80] mean_volume: -91.0 dB
[Parsed_volumedetect_0 @ 0x60f59ca72d80] max_volume: -90.3 dB
"""
FFMPEG_LIVE = """[Parsed_volumedetect_0 @ 0x5c2879f7adc0] mean_volume: -25.4 dB
[Parsed_volumedetect_0 @ 0x5c2879f7adc0] max_volume: 0.0 dB
"""


class ParseMaxVolumeTests(unittest.TestCase):
    def test_parses_silent_track(self):
        self.assertEqual(audio_checks.parse_max_volume_db(FFMPEG_SILENT), -90.3)

    def test_parses_live_track(self):
        self.assertEqual(audio_checks.parse_max_volume_db(FFMPEG_LIVE), 0.0)

    def test_missing_marker_returns_none(self):
        self.assertIsNone(audio_checks.parse_max_volume_db("no volume info here"))


class IsSilentTests(unittest.TestCase):
    def test_below_threshold_is_silent(self):
        with patch.object(audio_checks, "max_volume_db", return_value=-90.3):
            self.assertTrue(audio_checks.is_silent(None))

    def test_speech_level_is_not_silent(self):
        with patch.object(audio_checks, "max_volume_db", return_value=-18.0):
            self.assertFalse(audio_checks.is_silent(None))

    def test_unmeasurable_returns_none(self):
        with patch.object(audio_checks, "max_volume_db", return_value=None):
            self.assertIsNone(audio_checks.is_silent(None))


class MinutesNoteTests(unittest.TestCase):
    def _meeting(self, missing: bool) -> Meeting:
        return Meeting(
            id=uuid4(),
            title="Silence check",
            source=MeetingSource.online,
            owner_id="test-owner",
            created_at=datetime.now(timezone.utc),
            recorder_audio_missing=missing,
        )

    def test_note_present_when_recorder_audio_missing(self):
        text = _format_transcript([], "Silence check", [], meeting=self._meeting(True))
        self.assertIn("microphone was silent", text)

    def test_note_absent_when_recorder_audio_present(self):
        text = _format_transcript([], "Silence check", [], meeting=self._meeting(False))
        self.assertNotIn("microphone was silent", text)


if __name__ == "__main__":
    unittest.main()
