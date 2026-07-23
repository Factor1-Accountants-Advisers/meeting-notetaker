"""IN-378 pipeline wiring for ephemeral Storage API identity."""

import asyncio
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from app import store
from app.schemas import (
    Meeting,
    MeetingParticipant,
    MeetingSource,
    PipelineStatus,
    TranscriptSegment,
)
from app.services import pipeline
from app.services.meeting_voiceprints import (
    MeetingVoiceprintResolution,
    MeetingVoiceprintsUnavailable,
)
from app.services.voiceprints import Voiceprint


def _segment() -> TranscriptSegment:
    return TranscriptSegment(
        speaker="Speaker 1",
        speaker_known=False,
        text="hello",
        start_ms=0,
        end_ms=1000,
        raw_speaker="SPEAKER_00",
    )


class _Speech:
    async def transcribe_diarized(self, audio_path, meeting):
        return [_segment()]


class PipelineVoiceprintTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._old_meetings = dict(store.MEETINGS)
        self._old_transcripts = dict(store.TRANSCRIPTS)
        self._old_participants = dict(store.PARTICIPANTS)
        self.meeting = Meeting(
            id=uuid4(),
            title="Voiceprint pipeline",
            source=MeetingSource.online,
            owner_id="Joseph",
            created_at=datetime.now(timezone.utc),
            pipeline_status=PipelineStatus.queued,
        )
        store.MEETINGS[self.meeting.id] = self.meeting

    def tearDown(self):
        store.MEETINGS.clear()
        store.MEETINGS.update(self._old_meetings)
        store.TRANSCRIPTS.clear()
        store.TRANSCRIPTS.update(self._old_transcripts)
        store.PARTICIPANTS.clear()
        store.PARTICIPANTS.update(self._old_participants)

    async def test_run_pipeline_resolves_once_and_injects_central_records(self):
        central_record = Voiceprint(
            employee_id="invitee@example.com",
            display_name="Invitee",
            voiceprints=["opaque"],
            model_version="precision-2",
            enrolled_at="2026-07-24T00:00:00+00:00",
        )
        resolution = MeetingVoiceprintResolution(
            records=[central_record],
            degraded=False,
            request_count=1,
        )
        matcher = AsyncMock()
        matcher.match_speakers.return_value = (
            [_segment()],
            [MeetingParticipant(name="Speaker 1", known=False)],
            1,
        )

        with patch.object(pipeline, "STAGE_DELAY_S", 0), patch.object(
            pipeline, "get_speech_provider", return_value=_Speech()
        ), patch.object(
            pipeline,
            "resolve_meeting_voiceprints",
            return_value=resolution,
        ) as resolve, patch.object(
            pipeline, "get_speaker_matcher", return_value=matcher
        ):
            await pipeline.run_pipeline(
                self.meeting.id,
                Path("meeting.webm"),
                storage_token="token-123",
                recorder_email="recorder@example.com",
            )

        resolve.assert_called_once_with(
            self.meeting,
            recorder_email="recorder@example.com",
            access_token="token-123",
        )
        matcher.match_speakers.assert_awaited_once()
        self.assertEqual(
            matcher.match_speakers.await_args.kwargs["enrolled_voiceprints"],
            [central_record],
        )

    async def test_unavailable_resolution_fails_retryably_and_preserves_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / "meeting.webm"
            audio.write_bytes(b"audio")
            with patch.object(pipeline, "STAGE_DELAY_S", 0), patch.object(
                pipeline, "get_speech_provider", return_value=_Speech()
            ), patch.object(
                pipeline,
                "resolve_meeting_voiceprints",
                side_effect=MeetingVoiceprintsUnavailable(
                    "Voiceprint lookup is temporarily unavailable; retry processing."
                ),
            ), patch.object(pipeline, "get_speaker_matcher") as matcher:
                await pipeline.run_pipeline(
                    self.meeting.id,
                    audio,
                    storage_token="token-123",
                    recorder_email="recorder@example.com",
                )

            self.assertTrue(audio.exists())
            matcher.assert_not_called()
            failed = store.MEETINGS[self.meeting.id]
            self.assertEqual(failed.pipeline_status, PipelineStatus.failed)
            self.assertEqual(
                failed.processing_error_code,
                "MeetingVoiceprintsUnavailable",
            )
            self.assertIn("retry", failed.processing_error_message.lower())

    async def test_kick_pipeline_forwards_identity_only_to_background_task(self):
        runner = AsyncMock()
        with patch.object(pipeline, "run_pipeline", runner):
            pipeline.kick_pipeline(
                self.meeting.id,
                Path("meeting.webm"),
                storage_token="token-123",
                recorder_email="recorder@example.com",
            )
            await asyncio.gather(*pipeline._PIPELINE_TASKS)

        runner.assert_awaited_once_with(
            self.meeting.id,
            Path("meeting.webm"),
            storage_token="token-123",
            recorder_email="recorder@example.com",
        )
        serialized = store.MEETINGS[self.meeting.id].model_dump_json()
        self.assertNotIn("token-123", serialized)
        self.assertNotIn("recorder@example.com", serialized)


if __name__ == "__main__":
    unittest.main()
