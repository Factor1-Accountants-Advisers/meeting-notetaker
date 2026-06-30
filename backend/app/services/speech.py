"""Transcription + speaker-label provider per Jira IN-64/IN-69.

Jira is the source of truth for Slice 1: pyannoteAI owns transcription,
diarization, and voiceprint speaker identification. OpenAI is used separately
for summaries/action items only; direct Whisper transcription is not the Jira
provider.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from app.config import get_settings
from app.schemas import Meeting, TranscriptSegment
from app.services.pyannote_client import PyannoteAIClient, PyannoteAIError, PyannotePollConfig

logger = logging.getLogger(__name__)


def _turns_from_pyannote_result(result: dict[str, Any]) -> list[dict[str, Any]]:
    output = result.get("output") if isinstance(result.get("output"), dict) else result
    if not isinstance(output, dict):
        return []

    turns = output.get("turnLevelTranscription")
    if isinstance(turns, list):
        return [turn for turn in turns if isinstance(turn, dict)]

    # Fallback for older/non-STT diarization outputs. These turns do not contain
    # transcript text but keep timing/speaker labels visible instead of failing.
    diarization = output.get("diarization") or output.get("exclusiveDiarization")
    if isinstance(diarization, list):
        return [turn for turn in diarization if isinstance(turn, dict)]
    return []


def _segment_from_turn(turn: dict[str, Any], index: int) -> TranscriptSegment | None:
    try:
        start = float(turn.get("start", 0) or 0)
        end = float(turn.get("end", start) or start)
    except (TypeError, ValueError):
        start = 0.0
        end = 0.0

    text = str(turn.get("text") or "").strip()
    if not text:
        text = "(No transcript text returned for this speaker turn.)"

    speaker = str(turn.get("speaker") or turn.get("label") or f"SPEAKER_{index:02d}")
    return TranscriptSegment(
        speaker=speaker,
        speaker_known=False,
        start_ms=max(0, int(start * 1000)),
        end_ms=max(0, int(end * 1000)),
        text=text,
    )


def _segments_from_pyannote_result(result: dict[str, Any]) -> list[TranscriptSegment]:
    segments: list[TranscriptSegment] = []
    for index, turn in enumerate(_turns_from_pyannote_result(result)):
        segment = _segment_from_turn(turn, index)
        if segment is not None:
            segments.append(segment)
    return segments


class PyannoteAITranscriptionProvider:
    """pyannoteAI transcription + diarization provider.

    Uses `/v1/diarize` with `transcription: true`, which pyannoteAI documents
    as STT orchestration: precision-2 diarization plus STT reconciliation into
    speaker-attributed transcript turns.
    """

    async def transcribe_diarized(
        self, audio_path: Path, meeting: Meeting
    ) -> list[TranscriptSegment]:
        settings = get_settings()
        if not settings.pyannote_api_key:
            raise RuntimeError("pyannoteAI API key is not configured")

        def run_job() -> list[TranscriptSegment]:
            client = PyannoteAIClient(
                settings.pyannote_api_key,
                settings.pyannote_api_endpoint or "https://api.pyannote.ai",
            )
            media_url = client.upload_media_file(audio_path, "meeting-audio")
            job_id = client.submit_diarize_with_transcription(
                media_url,
                model=settings.pyannote_model_version or "precision-2",
                transcription_model=settings.pyannote_transcription_model or None,
                language=settings.pyannote_transcription_language or None,
            )
            result = client.wait_for_job(
                job_id,
                PyannotePollConfig(
                    interval_seconds=settings.pyannote_poll_interval_seconds,
                    timeout_seconds=settings.pyannote_poll_timeout_seconds,
                ),
            )
            status = str(result.get("status") or "").lower()
            if status != "succeeded":
                raise PyannoteAIError(f"pyannoteAI diarize job ended with status {status}")

            segments = _segments_from_pyannote_result(result)
            if not segments:
                raise PyannoteAIError("pyannoteAI returned no transcript segments")
            return segments

        segments = await asyncio.to_thread(run_job)
        logger.info("pyannoteAI transcription complete: %d segments", len(segments))
        return segments


class StubSpeechProvider:
    """Explicit unavailable-provider response when pyannoteAI is not configured."""

    async def transcribe_diarized(
        self, audio_path: Path, meeting: Meeting
    ) -> list[TranscriptSegment]:
        return [
            TranscriptSegment(
                speaker="Speaker 1",
                speaker_known=False,
                start_ms=0,
                end_ms=10_000,
                text="(Transcription unavailable — configure MN_PYANNOTE_API_KEY.)",
            )
        ]


def get_speech_provider():
    settings = get_settings()
    if settings.pyannote_api_key:
        return PyannoteAITranscriptionProvider()
    return StubSpeechProvider()
