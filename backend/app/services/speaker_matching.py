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
from typing import Any, Iterable, Protocol

from app.config import Settings, get_settings
from app.schemas import Meeting, MeetingParticipant, TranscriptSegment
from app.services.pyannote_client import PyannoteAIClient, PyannoteAIError, PyannotePollConfig
from app.services.voiceprints import Voiceprint, get_voiceprint_repository

logger = logging.getLogger(__name__)

MIN_OVERLAP_MS = 800
DEFAULT_MIN_CONFIDENCE = 0.62


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
        return _unknown_only(segments, reason="no_voiceprint_identification")


@dataclass(frozen=True)
class IdentityRange:
    start_ms: int
    end_ms: int
    raw_speaker: str
    display_name: str
    confidence: float | None = None
    source_label: str | None = None
    provider_job_id: str | None = None


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
            return _unknown_only(segments, reason="no_enrolled_voiceprints")

        settings = get_settings()
        if not settings.pyannote_api_key:
            return _unknown_only(segments, reason="pyannote_api_key_missing")

        base_candidates = _candidate_voiceprints_for_meeting(enrolled, meeting)
        if not base_candidates:
            base_result = _unknown_only(segments, reason="no_candidate_voiceprints")
        else:
            base_ranges = await self._identify_ranges(
                base_candidates,
                meeting,
                audio_path,
                settings,
                matching_threshold=_threshold_percent(settings.similarity_threshold),
            )
            if not base_ranges:
                base_result = _unknown_only(segments, reason="no_identity_ranges")
            else:
                base_result = _apply_identity_ranges(
                    segments,
                    base_ranges,
                    min_confidence=_normalised_confidence_threshold(settings.similarity_threshold),
                )

        base_matched, _base_participants, base_unknown_count = base_result
        expansion_ids = _controlled_expansion_ids_from_settings(settings)
        if base_unknown_count == 0 or not expansion_ids:
            return base_result

        expanded_candidates = _candidate_voiceprints_for_meeting(
            enrolled,
            meeting,
            controlled_expansion_employee_ids=expansion_ids,
            max_controlled_expansion=settings.voiceprint_expansion_cap,
        )
        if _candidate_ids(expanded_candidates) == _candidate_ids(base_candidates):
            return base_result

        expansion_ranges = await self._identify_ranges(
            expanded_candidates,
            meeting,
            audio_path,
            settings,
            matching_threshold=_threshold_percent(settings.voiceprint_expansion_min_confidence),
        )
        if not expansion_ranges:
            return base_result

        unresolved = [seg for seg in base_matched if not seg.speaker_known]
        expanded_unknowns, _participants, _unknown_count = _apply_identity_ranges(
            unresolved,
            expansion_ranges,
            min_confidence=_normalised_confidence_threshold(settings.voiceprint_expansion_min_confidence),
            source="pyannote_voiceprint_expansion",
        )
        return _merge_expansion_matches(base_matched, expanded_unknowns)

    async def _identify_ranges(
        self,
        candidates: list[Voiceprint],
        meeting: Meeting,
        audio_path: Path,
        settings: Settings,
        *,
        matching_threshold: float,
    ) -> list[IdentityRange]:
        label_to_name: dict[str, str] = {}
        payload = _build_voiceprint_payload(candidates, label_to_name)
        if not payload:
            return []

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
                matching_threshold=matching_threshold,
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
            return _identity_ranges_from_result(result, label_to_name)
        except PyannoteAIError:
            logger.exception("pyannoteAI identify failed for meeting %s", meeting.id)
            return []


def _controlled_expansion_ids_from_settings(settings: Settings) -> list[str]:
    """Return capped, normalized IN-79 key-person expansion employee ids in priority order."""
    raw = settings.voiceprint_expansion_employee_ids or ""
    ids: list[str] = []
    for item in raw.split(","):
        cleaned = item.strip().lower()
        if cleaned and cleaned not in ids:
            ids.append(cleaned)
    cap = max(0, settings.voiceprint_expansion_cap)
    return ids[:cap]


def _candidate_ids(records: list[Voiceprint]) -> list[str]:
    return [record.employee_id.strip().lower() for record in records]


def _merge_expansion_matches(
    base_matched: list[TranscriptSegment],
    expanded_unknowns: list[TranscriptSegment],
) -> tuple[list[TranscriptSegment], list[MeetingParticipant], int]:
    # Key each segment by its unique audio-span + text identity, not by raw_speaker
    # (the diarization cluster label). Using raw_speaker as a dict key collapses
    # every segment in a cluster into a single object, overwriting distinct
    # text/timestamps for all but the last matched segment.
    def _key(seg: TranscriptSegment) -> tuple[str | None, int, int, str]:
        return (seg.raw_speaker, seg.start_ms, seg.end_ms, seg.text)
    expanded_by_key = {_key(seg): seg for seg in expanded_unknowns if seg.speaker_known}
    merged = [expanded_by_key.get(_key(seg), seg) for seg in base_matched]

    participant_known: dict[str, bool] = {}
    for seg in merged:
        participant_known.setdefault(seg.speaker, seg.speaker_known)
    participants = [MeetingParticipant(name=name, known=known) for name, known in participant_known.items()]
    unknown_count = sum(1 for known in participant_known.values() if not known)
    return merged, participants, unknown_count


def _candidate_voiceprints_for_meeting(
    records: list[Voiceprint],
    meeting: Meeting,
    controlled_expansion_employee_ids: Iterable[str] | None = None,
    max_controlled_expansion: int | None = None,
) -> list[Voiceprint]:
    """Order candidates attendee-first, then organiser/recorder, then controlled expansion.

    This avoids broad staff matching in Slice 1 and reduces false positives for
    people who were not expected in the meeting.
    """
    by_id = {record.employee_id.strip().lower(): record for record in records}
    by_alias: dict[str, str] = {}

    def alias_key(value: str | None) -> str:
        return " ".join((value or "").strip().lower().replace(".", " ").split())

    for key, record in by_id.items():
        local = key.split("@", 1)[0]
        by_alias.setdefault(local, key)
        display_alias = alias_key(record.display_name)
        if display_alias:
            by_alias.setdefault(display_alias, key)
        compact_display_alias = display_alias.replace(" ", "")
        if compact_display_alias:
            by_alias.setdefault(compact_display_alias, key)
        # Local dev owner IDs are often short handles like "joseph" while the
        # voiceprint employee id is josephguerrero@factor1.com.au. Add conservative
        # prefix aliases from display-name tokens so in-person recordings can still
        # identify the enrolled recorder without broad staff matching.
        for token in display_alias.split():
            if len(token) >= 3 and local.startswith(token):
                by_alias.setdefault(token, key)
    ordered_ids: list[str] = []

    def add(email: str | None) -> None:
        cleaned = (email or "").strip().lower()
        employee_id = cleaned if cleaned in by_id else by_alias.get(cleaned)
        if not employee_id:
            employee_id = by_alias.get(alias_key(cleaned))
        if not employee_id:
            employee_id = by_alias.get(alias_key(cleaned).replace(" ", ""))
        if employee_id and employee_id not in ordered_ids:
            ordered_ids.append(employee_id)

    if meeting.graph_metadata:
        for attendee in meeting.graph_metadata.attendees:
            add(attendee.email)
        add(meeting.graph_metadata.organizer_email)

    add(meeting.owner_id)

    expansion_ids = list(controlled_expansion_employee_ids or [])
    if not isinstance(controlled_expansion_employee_ids, list):
        expansion_ids = sorted(expansion_ids)
    if max_controlled_expansion is not None:
        expansion_ids = expansion_ids[: max(0, max_controlled_expansion)]
    for employee_id in expansion_ids:
        add(employee_id)

    return [by_id[employee_id] for employee_id in ordered_ids]


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
    # expects 0-100. Also accept direct 62-style values for future config.
    return max(0.0, min(100.0, value * 100 if value <= 1 else value))


def _normalised_confidence_threshold(value: float) -> float:
    return max(0.0, min(1.0, value if value <= 1 else value / 100))


def _normalise_confidence(value: float | None) -> float | None:
    if value is None:
        return None
    return max(0.0, min(1.0, value if value <= 1 else value / 100))


def _output(result: dict[str, Any]) -> dict[str, Any]:
    output = result.get("output") if isinstance(result.get("output"), dict) else result
    return output if isinstance(output, dict) else {}


def _provider_job_id(result: dict[str, Any]) -> str | None:
    value = result.get("jobId") or result.get("id")
    return str(value) if value else None


def _identity_ranges_from_result(
    result: dict[str, Any], label_to_name: dict[str, str]
) -> list[IdentityRange]:
    output = _output(result)
    provider_job_id = _provider_job_id(result)
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
                    confidence_by_raw[raw] = _normalise_confidence(float(value)) or 0.0

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
                confidence=_normalise_confidence(float(confidence)) if isinstance(confidence, (int, float)) else None,
                source_label=label,
                provider_job_id=provider_job_id,
            )
        )
    return ranges


def _apply_identity_ranges(
    segments: list[TranscriptSegment],
    ranges: list[IdentityRange],
    *,
    min_confidence: float = DEFAULT_MIN_CONFIDENCE,
    min_overlap_ms: int = MIN_OVERLAP_MS,
    source: str = "pyannote_voiceprint",
) -> tuple[list[TranscriptSegment], list[MeetingParticipant], int]:
    unknown_names: dict[str, str] = {}
    unknown_reasons: dict[str, str] = {}
    participant_known: dict[str, bool] = {}
    matched: list[TranscriptSegment] = []

    for seg in segments:
        best, reason = _best_range_for_segment(
            seg,
            ranges,
            min_confidence=min_confidence,
            min_overlap_ms=min_overlap_ms,
        )
        raw_speaker = seg.raw_speaker or seg.speaker
        if best is not None:
            matched.append(
                seg.model_copy(
                    update={
                        "speaker": best.display_name,
                        "speaker_known": True,
                        "raw_speaker": raw_speaker,
                        "speaker_source": source,
                        "speaker_confidence": best.confidence,
                        "speaker_evidence_start_ms": best.start_ms,
                        "speaker_evidence_end_ms": best.end_ms,
                        "speaker_evidence_job_id": best.provider_job_id,
                        "unknown_reason": None,
                    }
                )
            )
            participant_known[best.display_name] = True
            continue

        unknown = unknown_names.setdefault(raw_speaker, f"Speaker {len(unknown_names) + 1}")
        unknown_reason = unknown_reasons.setdefault(raw_speaker, reason)
        matched.append(
            seg.model_copy(
                update={
                    "speaker": unknown,
                    "speaker_known": False,
                    "raw_speaker": raw_speaker,
                    "speaker_source": "unknown",
                    "speaker_confidence": None,
                    "speaker_evidence_start_ms": None,
                    "speaker_evidence_end_ms": None,
                    "speaker_evidence_job_id": None,
                    "unknown_reason": unknown_reason,
                }
            )
        )
        participant_known.setdefault(unknown, False)

    participants = [
        MeetingParticipant(name=name, known=known)
        for name, known in participant_known.items()
    ]
    unknown_count = sum(1 for known in participant_known.values() if not known)
    return matched, participants, unknown_count


def _best_range_for_segment(
    seg: TranscriptSegment,
    ranges: list[IdentityRange],
    *,
    min_confidence: float = DEFAULT_MIN_CONFIDENCE,
    min_overlap_ms: int = MIN_OVERLAP_MS,
) -> tuple[IdentityRange | None, str]:
    best: tuple[int, IdentityRange] | None = None
    saw_any = False
    saw_overlap = False
    saw_low_confidence = False
    raw_speaker = seg.raw_speaker or seg.speaker

    for item in ranges:
        if item.raw_speaker and item.raw_speaker != raw_speaker:
            continue
        saw_any = True
        overlap = min(seg.end_ms, item.end_ms) - max(seg.start_ms, item.start_ms)
        if overlap < min_overlap_ms:
            continue
        saw_overlap = True
        if item.confidence is not None and item.confidence < min_confidence:
            saw_low_confidence = True
            continue
        if best is None or overlap > best[0]:
            best = (overlap, item)

    if best:
        return best[1], "matched"
    if saw_low_confidence:
        return None, "low_confidence"
    if saw_any and not saw_overlap:
        return None, "insufficient_overlap"
    return None, "no_identity_match"


def _unknown_only(
    segments: list[TranscriptSegment],
    *,
    reason: str,
) -> tuple[list[TranscriptSegment], list[MeetingParticipant], int]:
    label_map: dict[str, str] = {}
    for seg in segments:
        raw_speaker = seg.raw_speaker or seg.speaker
        if raw_speaker not in label_map:
            label_map[raw_speaker] = f"Speaker {len(label_map) + 1}"

    matched = [
        seg.model_copy(
            update={
                "speaker": label_map[seg.raw_speaker or seg.speaker],
                "speaker_known": False,
                "raw_speaker": seg.raw_speaker or seg.speaker,
                "speaker_source": "unknown",
                "speaker_confidence": None,
                "speaker_evidence_start_ms": None,
                "speaker_evidence_end_ms": None,
                "speaker_evidence_job_id": None,
                "unknown_reason": reason,
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
