"""Transcription + speaker-label provider per Jira IN-64/IN-69.

Jira CSV is the source of truth for Slice 1: PyannoteAI owns transcription and
voiceprint/speaker identification. Two backends available:

  1. OpenAI Whisper (via MN_OPENAI_API_KEY) — primary for dev / WSL where
     HuggingFace DNS may not resolve.
  2. HuggingFace Inference API (via MN_PYANNOTE_HF_TOKEN) — used when
     whisper is unavailable or HF endpoint is reachable (packaged Windows).

Pipeline:
  transcribe (whisper or HF) → diarize (HF pyannote) → align segments
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
    token = get_settings().pyannote_hf_token
    if not token:
        raise RuntimeError("PyannoteAI HF token is not configured")
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _hf_call(model: str, payload: dict, timeout: int = 120) -> dict:
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
    except urllib.error.URLError as exc:
        logger.error("HF API unreachable for %s: %s", model, exc)
        raise RuntimeError(f"HuggingFace API unreachable: {exc}") from exc


def _read_audio_b64(audio_path: Path) -> str:
    data = audio_path.read_bytes()
    return base64.b64encode(data).decode("ascii")


# ── OpenAI Whisper ──────────────────────────────────────────────────────


def _whisper_headers() -> dict[str, str]:
    key = get_settings().openai_api_key
    if not key:
        raise RuntimeError("OpenAI API key is not configured")
    return {"Authorization": f"Bearer {key}"}


def _transcribe_via_openai(audio_path: Path) -> str:
    """Transcribe via OpenAI Whisper API.

    Uses multipart form-data because the OpenAI transcription endpoint
    expects a file upload, not a base64 JSON payload.
    """
    import io
    import uuid

    logger.info("transcribing %s via OpenAI whisper-1", audio_path.name)

    boundary = uuid.uuid4().hex
    data = audio_path.read_bytes()

    body_parts = []
    body_parts.append(f"--{boundary}".encode())
    body_parts.append(
            b'Content-Disposition: form-data; name="model"'
            + b"\r\n\r\n"
            + b"whisper-1"
    )
    body_parts.append(f"--{boundary}".encode())
    body_parts.append(
        b'Content-Disposition: form-data; name="file"; filename="audio.webm"'
        + b"\r\nContent-Type: audio/webm\r\n\r\n"
        + data
    )
    body_parts.append(f"--{boundary}".encode())
    body_parts.append(
        b'Content-Disposition: form-data; name="response_format"'
        + b"\r\n\r\n"
        + b"text"
    )
    body_parts.append(f"--{boundary}--".encode())

    body = b"\r\n".join(body_parts)

    req = urllib.request.Request(
        "https://api.openai.com/v1/audio/transcriptions",
        data=body,
        headers={
            **_whisper_headers(),
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.read().decode("utf-8").strip()
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode()
        logger.error("OpenAI whisper error %s: %s", exc.code, body_text[:300])
        raise RuntimeError(f"OpenAI whisper returned {exc.code}") from exc


# ── HuggingFace transcription (fallback) ─────────────────────────────────


def _transcribe_via_hf(audio_path: Path) -> str:
    """Transcribe via HuggingFace whisper-large-v3 Inference API."""
    logger.info("transcribing %s via HF whisper-large-v3", audio_path.name)
    result = _hf_call(
        "openai/whisper-large-v3",
        {"inputs": _read_audio_b64(audio_path)},
    )
    return result.get("text", "")


# ── Diarization ─────────────────────────────────────────────────────────


def _diarize_via_hf(audio_path: Path) -> list[dict]:
    """Speaker diarization via HuggingFace pyannote/speaker-diarization-3.1."""
    logger.info("diarizing %s via HF pyannote/speaker-diarization-3.1", audio_path.name)
    result = _hf_call(
        "pyannote/speaker-diarization-3.1",
        {"inputs": _read_audio_b64(audio_path)},
        timeout=300,
    )
    return result if isinstance(result, list) else []


# ── Segment alignment ───────────────────────────────────────────────────


def _align_transcript_segments(
    full_text: str, diarization: list[dict]
) -> list[TranscriptSegment]:
    """Align transcription text with diarization speaker turns."""
    if not diarization:
        return [
            TranscriptSegment(
                speaker="Speaker 1",
                speaker_known=False,
                start_ms=0,
                end_ms=max(len(full_text) * 80, 10_000),
                text=full_text,
            )
        ]

    segments: list[TranscriptSegment] = []
    total_duration_ms = int(diarization[-1].get("end", 0) * 1000) if diarization else 0
    if total_duration_ms <= 0:
        total_duration_ms = 60_000

    for turn in diarization:
        start = turn.get("start", 0)
        end = turn.get("end", start + 1)
        start_ms = int(start * 1000)
        end_ms = int(end * 1000)
        speaker = turn.get("speaker", "SPEAKER_00")

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


# ── Provider ─────────────────────────────────────────────────────────────


class PyannoteAITranscriptionProvider:
    """Transcription using OpenAI Whisper (primary) or HuggingFace (fallback).

    Diarization uses HF pyannote when the token is set; otherwise segments
    are returned without speaker labels.
    """

    async def transcribe_diarized(
        self, audio_path: Path, meeting: Meeting
    ) -> list[TranscriptSegment]:
        # Primary: OpenAI Whisper (reliable from WSL/anywhere)
        settings = get_settings()
        if settings.openai_api_key:
            full_text = _transcribe_via_openai(audio_path)
        elif settings.pyannote_hf_token:
            full_text = _transcribe_via_hf(audio_path)
        else:
            full_text = "(Transcription unavailable — no API key configured.)"

        logger.info("transcription complete: %d chars", len(full_text))

        # Diarization via HF pyannote
        diarization: list[dict] = []
        if settings.pyannote_hf_token:
            try:
                diarization = _diarize_via_hf(audio_path)
                logger.info("diarization complete: %d speaker turns", len(diarization))
            except Exception as exc:
                logger.warning("diarization failed (continuing without speaker labels): %s", exc)

        segments = _align_transcript_segments(full_text, diarization)
        logger.info("aligned %d transcript segments", len(segments))
        return segments


class StubSpeechProvider:
    """Fallback when no API key is configured."""

    async def transcribe_diarized(
        self, audio_path: Path, meeting: Meeting
    ) -> list[TranscriptSegment]:
        return [
            TranscriptSegment(
                speaker="Speaker 1",
                speaker_known=False,
                start_ms=0,
                end_ms=10_000,
                text="(Transcription unavailable — configure an API key.)",
            )
        ]


def get_speech_provider():
    settings = get_settings()
    if settings.openai_api_key or settings.pyannote_hf_token:
        return PyannoteAITranscriptionProvider()
    return StubSpeechProvider()
