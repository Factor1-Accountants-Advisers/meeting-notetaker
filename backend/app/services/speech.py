"""Transcription + speaker-label provider per Jira IN-64/IN-69.

Jira CSV is the source of truth for Slice 1: PyannoteAI owns transcription and
voiceprint/speaker identification. Uses HuggingFace Inference API with the
configured HF token.

Pipeline:
  1. HuggingFace whisper-large-v3 for speech-to-text transcription
  2. HuggingFace pyannote/speaker-diarization-3.1 for speaker labels
  3. Align transcript segments with diarized speaker turns
"""

import base64
import json
import logging
import urllib.error
import urllib.request
from pathlib import Path

from app.config import get_settings
from app.schemas import Meeting, TranscriptSegment

logger = logging.getLogger(__name__)

HF_API_BASE = "https://api-inference.huggingface.co/models"


def _hf_headers() -> dict[str, str]:
    settings = get_settings()
    token = settings.pyannote_hf_token
    if not token:
        raise RuntimeError("PyannoteAI HF token is not configured")
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _call_hf(model: str, payload: dict, timeout: int = 120) -> dict:
    url = f"{HF_API_BASE}/{model}"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=_hf_headers(),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode()
        logger.error("HF API error %s for %s: %s", exc.code, model, body[:300])
        raise RuntimeError(f"HuggingFace API returned {exc.code}") from exc


def _read_audio_b64(audio_path: Path) -> str:
    data = audio_path.read_bytes()
    return base64.b64encode(data).decode("ascii")


async def transcribe_with_hf(audio_path: Path) -> str:
    """Full audio transcription via HuggingFace whisper-large-v3."""
    logger.info("transcribing %s via HF whisper-large-v3", audio_path.name)
    result = _call_hf(
        "openai/whisper-large-v3",
        {"inputs": _read_audio_b64(audio_path)},
    )
    return result.get("text", "")


async def diarize_with_hf(audio_path: Path) -> list[dict]:
    """Speaker diarization via HuggingFace pyannote/speaker-diarization-3.1.

    Returns a list of speaker segments with start/end times and speaker labels.
    """
    logger.info("diarizing %s via HF pyannote/speaker-diarization-3.1", audio_path.name)
    result = _call_hf(
        "pyannote/speaker-diarization-3.1",
        {"inputs": _read_audio_b64(audio_path)},
        timeout=300,
    )
    return result if isinstance(result, list) else []


def _align_transcript_segments(
    full_text: str, diarization: list[dict]
) -> list[TranscriptSegment]:
    """Align transcription text with diarization speaker turns.

    Falls back to a single segment per speaker if fine-grained alignment
    isn't available from the APIs.
    """
    if not diarization:
        return [
            TranscriptSegment(
                speaker="Speaker 1",
                speaker_known=False,
                start_ms=0,
                end_ms=len(full_text) * 80,
                text=full_text,
            )
        ]

    # Build segments: one per diarization turn, splitting transcript text
    # proportionally across speaker turns
    segments: list[TranscriptSegment] = []
    total_duration_ms = int(diarization[-1].get("end", 0) * 1000)
    if total_duration_ms <= 0:
        total_duration_ms = 60_000  # 1 minute default

    for i, turn in enumerate(diarization):
        start = turn.get("start", 0)
        end = turn.get("end", start + 1)
        start_ms = int(start * 1000)
        end_ms = int(end * 1000)
        speaker = turn.get("speaker", "Speaker 1")

        # Proportional text split based on turn duration
        turn_ratio = (end_ms - start_ms) / max(total_duration_ms, 1)
        char_start = int(len(full_text) * (start_ms / max(total_duration_ms, 1)))
        char_end = int(len(full_text) * (end_ms / max(total_duration_ms, 1)))

        char_start = max(0, min(char_start, len(full_text)))
        char_end = max(char_start, min(char_end, len(full_text)))

        text = full_text[char_start:char_end].strip()

        if text:
            segments.append(
                TranscriptSegment(
                    speaker=speaker,
                    speaker_known=False,
                    start_ms=start_ms,
                    end_ms=end_ms,
                    text=text,
                )
            )

    if not segments:
        segments.append(
            TranscriptSegment(
                speaker="Speaker 1",
                speaker_known=False,
                start_ms=0,
                end_ms=len(full_text) * 80,
                text=full_text,
            )
        )

    return segments


class PyannoteAITranscriptionProvider:
    """Real transcription using HuggingFace Inference API (whisper + pyannote)."""

    async def transcribe_diarized(
        self, audio_path: Path, meeting: Meeting
    ) -> list[TranscriptSegment]:
        full_text = await transcribe_with_hf(audio_path)
        logger.info("transcription complete: %d chars", len(full_text))

        diarization = await diarize_with_hf(audio_path)
        logger.info("diarization complete: %d speaker turns", len(diarization))

        segments = _align_transcript_segments(full_text, diarization)
        logger.info("aligned %d transcript segments", len(segments))
        return segments


class StubSpeechProvider:
    """Fallback when no HF token is configured. Produces generic output."""

    async def transcribe_diarized(
        self, audio_path: Path, meeting: Meeting
    ) -> list[TranscriptSegment]:
        return [
            TranscriptSegment(
                speaker="Speaker 1",
                speaker_known=False,
                start_ms=0,
                end_ms=10_000,
                text="(Transcription unavailable — configure a HuggingFace token.)",
            )
        ]


def get_speech_provider():
    settings = get_settings()
    if settings.pyannote_hf_token:
        return PyannoteAITranscriptionProvider()
    return StubSpeechProvider()
