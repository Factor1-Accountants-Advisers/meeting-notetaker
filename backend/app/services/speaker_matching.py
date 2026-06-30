"""Speaker matching service (IN-69, IN-78, IN-79, IN-80).

Known-speaker naming is done with pyannoteAI `/v1/identify` using enrolled
voiceprints. The fallback never guesses identities: if pyannoteAI cannot match a
segment confidently, it remains Unknown for later review.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from app.config import get_settings
from app.schemas import Meeting, MeetingParticipant, TranscriptSegment
from app.services.pyannote_client import PyannoteAIClient, PyannoteAIError, PyannotePollConfig
from app.services.voiceprints import Voiceprint, get_voiceprint_repository

logger = logging.getLogger(__name__)

MIN_OVERLAP_MS = 800


class SpeakerMatcher(Protocol):
    """Match diarized speaker labels to known people."""

    async def match_speakers(
        self,
        segments: list[TranscriptSegment],
        meeting: Meeting,
        audio_path: Path,
    ) -> tuple[list[TranscriptSegment], list[MeetingParticipant], int]:
        ...


class UnknownOnlySpeakerMatcher:
    """Safe fallback when real pyannoteAI voiceprint identification is unavailable."""

    async def match_speakers(
        self,
        segments: list[TranscriptSegment],
        meeting: Meeting,
        audio_path: Path,
    ) -> tuple[list[TranscriptSegment], list[MeetingParticipant], int]:
        return _unknown_only(segments)


@dataclass(frozen=True)
class IdentityRange:
    start_ms: int
    end_ms: int
    raw_speaker: str
    display_name: str
    confidence: float | None = None


class PyannoteAIVoiceprintMatcher:
    """Use pyannoteAI `/v1/identify` to map diarized turns to enrolled staff."""

    async def match_speakers(
        self,
        segments: list[TranscriptSegment],
        meeting: Meeting,
        audio_path: Path,
    ) -> tuple[list[TranscriptSegment], list[MeetingParticipant], int]:
        repo = get_voiceprint_repository()
        enrolled = repo.get_all()
        if not enrolled:
            return _unknown_only(segments)

        settings = get_settings()
        if not settings.pyannote_api_key:
            return _unknown_only(segments)

        label_to_name: dict[str, str] = {}
        payload = _build_voiceprint_payload(enrolled, label_to_name)
        if not payload:
            return _unknown_only(segments)

        threshold = _threshold_percent(settings.similarity_threshold)

        def identify() -> dict[str, Any]:
            client = PyannoteAIClient(
                settings.pyannote_api_key,
                settings.pyannote_api_endpoint or "https://api.pyannote.ai",
            )
            return client.identify_audio(
                audio_path,
                payload,
                media_prefix=f"meeting-identify/{meeting.id}",
                model=settings.pyannote_model_version or "precision-2",
                matching_threshold=threshold,
                # False lets the same enrolled speaker match multiple diarized
                # clusters if pyannote splits their voice into SPEAKER_00/03.
                # Threshold + overlap checks still suppress weak matches.
                exclusive_matching=False,
                poll=PyannotePollConfig(
                    interval_seconds=settings.pyannote_poll_interval_seconds,
                    timeout_seconds=settings.pyannote_poll_timeout_seconds,
                ),
            )

        try:
            result = await asyncio.to_thread(identify)
            identity_ranges = _identity_ranges_from_result(result, label_to_name)
        except PyannoteAIError:
            logger.exception("pyannoteAI identify failed for meeting %s", meeting.id)
            return _unknown_only(segments)

        if not identity_ranges:
            return _unknown_only(segments)

        return _apply_identity_ranges(segments, identity_ranges)


def _build_voiceprint_payload(
    records: list[Voiceprint], label_to_name: dict[str, str]
) -> list[dict[str, str]]:
    payload: list[dict[str, str]] = []
    for record in records:
        for idx, value in enumerate(record.voiceprints):
            if not isinstance(value, str) or not value:
                continue
            # Labels must not start with SPEAKER_ and must be <=100 chars. Keep
            # them unique so multiple samples from one person can be submitted.
            label = f"{record.display_name} #{idx + 1}"[:100]
            label_to_name[label] = record.display_name
            payload.append({"label": label, "voiceprint": value})
    return payload[:50]


def _threshold_percent(value: float) -> float:
    # Existing config uses 0.62 style similarity threshold. pyannoteAI matching
    # expects 0–100. Also accept direct 62-style values for future config.
    return max(0.0, min(100.0, value * 100 if value <= 1 else value))


def _output(result: dict[str, Any]) -> dict[str, Any]:
    output = result.get("output") if isinstance(result.get("output"), dict) else result
    return output if isinstance(output, dict) else {}


def _identity_ranges_from_result(
    result: dict[str, Any], label_to_name: dict[str, str]
) -> list[IdentityRange]:
    output = _output(result)
    confidence_by_raw: dict[str, float] = {}
    voiceprint_confidence = output.get("voiceprints")
    if isinstance(voiceprint_confidence, list):
        for item in voiceprint_confidence:
            if not isinstance(item, dict):
                continue
            raw = item.get("speaker")
            match = item.get("match")
            conf = item.get("confidence")
            if isinstance(raw, str) and isinstance(match, str) and isinstance(conf, dict):
                value = conf.get(match)
                if isinstance(value, (int, float)):
                    confidence_by_raw[raw] = float(value)

    ranges: list[IdentityRange] = []
    identification = output.get("identification")
    if not isinstance(identification, list):
        return ranges

    for item in identification:
        if not isinstance(item, dict):
            continue
        label = str(item.get("match") or item.get("speaker") or "").strip()
        display_name = label_to_name.get(label)
        if not display_name:
            continue
        try:
            start_ms = int(float(item.get("start", 0) or 0) * 1000)
            end_ms = int(float(item.get("end", 0) or 0) * 1000)
        except (TypeError, ValueError):
            continue
        if end_ms <= start_ms:
            continue
        raw = str(
            item.get("diarizationSpeaker")
            or item.get("raw_speaker_label")
            or item.get("speaker")
            or ""
        ).strip()
        confidence = item.get("confidence")
        if not isinstance(confidence, (int, float)):
            confidence = confidence_by_raw.get(raw)
        ranges.append(
            IdentityRange(
                start_ms=max(0, start_ms),
                end_ms=max(0, end_ms),
                raw_speaker=raw,
                display_name=display_name,
                confidence=float(confidence) if isinstance(confidence, (int, float)) else None,
            )
        )
    return ranges


def _apply_identity_ranges(
    segments: list[TranscriptSegment], ranges: list[IdentityRange]
) -> tuple[list[TranscriptSegment], list[MeetingParticipant], int]:
    unknown_names: dict[str, str] = {}
    participant_known: dict[str, bool] = {}
    matched: list[TranscriptSegment] = []

    for seg in segments:
        best = _best_range_for_segment(seg, ranges)
        if best is not None:
            matched.append(seg.model_copy(update={"speaker": best.display_name, "speaker_known": True}))
            participant_known[best.display_name] = True
            continue

        unknown = unknown_names.setdefault(seg.speaker, f"Unknown {len(unknown_names) + 1}")
        matched.append(seg.model_copy(update={"speaker": unknown, "speaker_known": False}))
        participant_known.setdefault(unknown, False)

    participants = [
        MeetingParticipant(name=name, known=known)
        for name, known in participant_known.items()
    ]
    unknown_count = sum(1 for known in participant_known.values() if not known)
    return matched, participants, unknown_count


def _best_range_for_segment(seg: TranscriptSegment, ranges: list[IdentityRange]) -> IdentityRange | None:
    best: tuple[int, IdentityRange] | None = None
    for item in ranges:
        overlap = min(seg.end_ms, item.end_ms) - max(seg.start_ms, item.start_ms)
        if overlap < MIN_OVERLAP_MS:
            continue
        if best is None or overlap > best[0]:
            best = (overlap, item)
    return best[1] if best else None


def _unknown_only(
    segments: list[TranscriptSegment],
) -> tuple[list[TranscriptSegment], list[MeetingParticipant], int]:
    label_map: dict[str, str] = {}
    for seg in segments:
        if seg.speaker not in label_map:
            label_map[seg.speaker] = f"Unknown {len(label_map) + 1}"

    matched = [
        seg.model_copy(
            update={
                "speaker": label_map[seg.speaker],
                "speaker_known": False,
            }
        )
        for seg in segments
    ]
    participants = [MeetingParticipant(name=name, known=False) for name in label_map.values()]
    return matched, participants, len(label_map)


def get_speaker_matcher() -> SpeakerMatcher:
    settings = get_settings()
    if settings.pyannote_api_key:
        return PyannoteAIVoiceprintMatcher()
    return UnknownOnlySpeakerMatcher()
