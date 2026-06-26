"""Transcription + speaker-label provider per Jira IN-64/IN-69.

Jira CSV is the source of truth for Slice 1: PyannoteAI owns transcription and
voiceprint/speaker identification. The stub remains until PyannoteAI API
credentials are configured; the pipeline talks only to this protocol.
"""

from pathlib import Path
from typing import Protocol

from app.config import get_settings
from app.schemas import Meeting, TranscriptSegment


class SpeechProvider(Protocol):
    async def transcribe_diarized(
        self, audio_path: Path, meeting: Meeting
    ) -> list[TranscriptSegment]:
        """Batch transcription with speaker turns labelled Speaker 1, 2, …"""
        ...


class StubSpeechProvider:
    """Generates a plausible diarized transcript so the end-to-end flow can be
    exercised without PyannoteAI. Speaker labels are generic — speaker matching
    happens downstream, exactly as it will with the real service."""

    async def transcribe_diarized(
        self, audio_path: Path, meeting: Meeting
    ) -> list[TranscriptSegment]:
        topic = meeting.title
        return [
            TranscriptSegment(
                speaker="Speaker 1", speaker_known=False, start_ms=8_000, end_ms=22_000,
                text=f"Thanks everyone for joining. Today we're covering {topic} — "
                     "let's start with where things stand.",
            ),
            TranscriptSegment(
                speaker="Speaker 2", speaker_known=False, start_ms=24_000, end_ms=47_000,
                text="From our side the main numbers are in. There are two items that "
                     "need a decision before we can close this off.",
            ),
            TranscriptSegment(
                speaker="Speaker 1", speaker_known=False, start_ms=49_000, end_ms=68_000,
                text="Understood. I'll take the first one and have an update ready by "
                     "next week. Can you own the follow-up on the second?",
            ),
            TranscriptSegment(
                speaker="Speaker 2", speaker_known=False, start_ms=70_000, end_ms=84_000,
                text="Yes, I'll confirm the details and send them through before Friday.",
            ),
        ]


class PyannoteAITranscriptionProvider:
    """Real PyannoteAI transcription/speaker-label client lands once API access exists."""

    async def transcribe_diarized(
        self, audio_path: Path, meeting: Meeting
    ) -> list[TranscriptSegment]:
        raise NotImplementedError("PyannoteAI transcription wiring requires API credentials")


def get_speech_provider() -> SpeechProvider:
    settings = get_settings()
    if settings.pyannote_api_endpoint:
        return PyannoteAITranscriptionProvider()
    return StubSpeechProvider()
