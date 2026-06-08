#!/usr/bin/env python3
"""Merge timestamped transcript segments with pyannote speaker identity ranges.

This is experiment-only code. It is deliberately deterministic and standard-library
only so we can evaluate the merge strategy before touching production services.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

MIN_IDENTITY_DURATION = 0.50
SHORT_IDENTITY_DURATION = 1.00
MIN_OVERLAP_SECONDS = 0.20
ASSIGNMENT_THRESHOLD = 0.50
CONFIDENT_THRESHOLD = 0.70
AMBIGUOUS_MARGIN = 0.15
NON_ATTENDEE_THRESHOLD = 0.85
NON_ATTENDEE_OVERLAP = 0.60


@dataclass(frozen=True)
class TranscriptSegment:
    start: float
    end: float
    text: str
    index: int = 0

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


@dataclass(frozen=True)
class IdentitySegment:
    start: float
    end: float
    raw_speaker_label: str
    display_name: str | None = None
    email: str | None = None
    confidence: float = 0.70
    is_candidate_attendee: bool = True

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)

    @property
    def identity_key(self) -> str:
        if self.email:
            return self.email.strip().lower()
        if self.display_name:
            return " ".join(self.display_name.strip().lower().split())
        return self.raw_speaker_label

    @property
    def duration_weight(self) -> float:
        return 0.70 if self.duration < SHORT_IDENTITY_DURATION else 1.0


def _float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def normalize_transcript_segments(items: list[dict[str, Any]]) -> list[TranscriptSegment]:
    segments: list[TranscriptSegment] = []
    for index, item in enumerate(items):
        offset = _float(item.get("chunk_offset"), 0.0)
        start = _float(item.get("start"), 0.0) + offset
        end = _float(item.get("end"), start) + offset
        text = str(item.get("text") or "").strip()
        if end <= start or not text:
            continue
        segments.append(TranscriptSegment(start=start, end=end, text=text, index=index))
    return sorted(segments, key=lambda segment: (segment.start, segment.end, segment.index))


def normalize_identity_segments(items: list[dict[str, Any]]) -> list[IdentitySegment]:
    segments: list[IdentitySegment] = []
    for item in items:
        offset = _float(item.get("chunk_offset"), 0.0)
        start = _float(item.get("start"), 0.0) + offset
        end = _float(item.get("end"), start) + offset
        raw_label = str(item.get("raw_speaker_label") or item.get("diarizationSpeaker") or item.get("speaker") or "").strip()
        if not raw_label or end <= start:
            continue
        confidence = _float(item.get("confidence"), 0.70)
        # pyannote confidence can arrive as 0-100 or 0-1 depending on source normalization.
        if confidence > 1.0:
            confidence = confidence / 100.0
        confidence = max(0.0, min(1.0, confidence))
        segment = IdentitySegment(
            start=start,
            end=end,
            raw_speaker_label=raw_label,
            display_name=_optional_str(item.get("display_name") or item.get("match")),
            email=_optional_str(item.get("email")),
            confidence=confidence,
            is_candidate_attendee=bool(item.get("is_candidate_attendee", item.get("expected_attendee", True))),
        )
        if segment.duration >= MIN_IDENTITY_DURATION:
            segments.append(segment)
    return sorted(segments, key=lambda segment: (segment.start, segment.end, segment.identity_key))


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def overlap_seconds(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def score_identity(transcript: TranscriptSegment, identity: IdentitySegment, overlap: float) -> tuple[float, float]:
    if transcript.duration <= 0 or identity.duration <= 0:
        return 0.0, 0.0
    transcript_overlap_ratio = overlap / transcript.duration
    identity_coverage = overlap / identity.duration
    attendee_weight = 1.0 if identity.is_candidate_attendee else 0.60
    score = (
        0.55 * transcript_overlap_ratio
        + 0.25 * identity.confidence
        + 0.10 * identity_coverage
        + 0.10 * identity.duration_weight
    ) * attendee_weight
    return score, transcript_overlap_ratio


def merge_segments(
    transcript_items: list[dict[str, Any]],
    identity_items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    transcripts = normalize_transcript_segments(transcript_items)
    identities = normalize_identity_segments(identity_items)
    merged: list[dict[str, Any]] = []

    for transcript in transcripts:
        flags: list[str] = []
        if transcript.duration < 0.30:
            flags.append("very_short_transcript_segment")

        candidate_scores: dict[str, dict[str, Any]] = {}
        for identity in identities:
            if identity.end < transcript.start:
                continue
            if identity.start > transcript.end:
                break
            overlap = overlap_seconds(transcript.start, transcript.end, identity.start, identity.end)
            if overlap < MIN_OVERLAP_SECONDS:
                continue
            score, overlap_ratio = score_identity(transcript, identity, overlap)
            record = candidate_scores.setdefault(
                identity.identity_key,
                {
                    "identity": identity,
                    "score": 0.0,
                    "overlap": 0.0,
                    "max_overlap_ratio": 0.0,
                    "max_confidence": 0.0,
                    "evidence": [],
                },
            )
            record["score"] += score * overlap
            record["overlap"] += overlap
            record["max_overlap_ratio"] = max(record["max_overlap_ratio"], overlap_ratio)
            record["max_confidence"] = max(record["max_confidence"], identity.confidence)
            record["evidence"].append(
                {
                    "raw_speaker_label": identity.raw_speaker_label,
                    "display_name": identity.display_name,
                    "email": identity.email,
                    "start": identity.start,
                    "end": identity.end,
                    "overlap_seconds": round(overlap, 3),
                    "confidence": round(identity.confidence, 3),
                    "is_candidate_attendee": identity.is_candidate_attendee,
                }
            )

        if not candidate_scores:
            merged.append(_unknown_segment(transcript, flags + ["speaker_unassigned", "no_identity_overlap"]))
            continue

        ranked = sorted(
            candidate_scores.values(),
            key=lambda record: (record["score"] / max(transcript.duration, 0.001), record["overlap"]),
            reverse=True,
        )
        best = ranked[0]
        second = ranked[1] if len(ranked) > 1 else None
        best_score = best["score"] / max(transcript.duration, 0.001)
        best_overlap_ratio = best["overlap"] / max(transcript.duration, 0.001)
        margin = best_score - (second["score"] / max(transcript.duration, 0.001) if second else 0.0)
        identity: IdentitySegment = best["identity"]

        if best_overlap_ratio < 0.35:
            flags.append("low_overlap_ratio")
        if best_score < ASSIGNMENT_THRESHOLD:
            merged.append(_unknown_segment(transcript, flags + ["speaker_unassigned_low_score"], best, best_score, best_overlap_ratio))
            continue
        if best_score < CONFIDENT_THRESHOLD or best["max_confidence"] < 0.65:
            flags.append("low_confidence_speaker")
        if second and margin < AMBIGUOUS_MARGIN:
            flags.append("ambiguous_speaker")
        if second and second["overlap"] / max(transcript.duration, 0.001) >= 0.30:
            flags.append("possible_speaker_change")
        if not identity.is_candidate_attendee:
            flags.append("non_attendee_detected")
            if best_score < NON_ATTENDEE_THRESHOLD or best_overlap_ratio < NON_ATTENDEE_OVERLAP:
                merged.append(_unknown_segment(transcript, flags + ["non_attendee_requires_review"], best, best_score, best_overlap_ratio))
                continue

        merged.append(
            {
                "start": round(transcript.start, 3),
                "end": round(transcript.end, 3),
                "text": transcript.text,
                "speaker": identity.display_name or identity.raw_speaker_label,
                "raw_speaker_label": identity.raw_speaker_label,
                "speaker_email": identity.email,
                "speaker_confidence": round(max(0.0, min(1.0, best_score)), 3),
                "overlap_ratio": round(best_overlap_ratio, 3),
                "speaker_source": "pyannote_voiceprint",
                "review_flags": sorted(set(flags)),
                "evidence": best["evidence"],
            }
        )

    return merged


def _unknown_segment(
    transcript: TranscriptSegment,
    flags: list[str],
    best: dict[str, Any] | None = None,
    best_score: float = 0.0,
    best_overlap_ratio: float = 0.0,
) -> dict[str, Any]:
    return {
        "start": round(transcript.start, 3),
        "end": round(transcript.end, 3),
        "text": transcript.text,
        "speaker": None,
        "raw_speaker_label": None,
        "speaker_email": None,
        "speaker_confidence": round(max(0.0, min(1.0, best_score)), 3),
        "overlap_ratio": round(best_overlap_ratio, 3),
        "speaker_source": None,
        "review_flags": sorted(set(flags)),
        "evidence": [] if best is None else best.get("evidence", []),
    }


def load_identity_segments(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text())
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        if isinstance(data.get("identity_segments"), list):
            return data["identity_segments"]
        output = data.get("output")
        if isinstance(output, dict) and isinstance(output.get("identification"), list):
            return output["identification"]
    raise ValueError(f"Could not find identity segments in {path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Merge transcript segments with pyannote identity ranges.")
    parser.add_argument("--transcript", required=True, type=Path, help="JSON list or {segments: [...]} transcript segments")
    parser.add_argument("--identification", required=True, type=Path, help="JSON identity segments or pyannote identify response")
    parser.add_argument("--output", required=True, type=Path, help="Merged transcript JSON output path")
    args = parser.parse_args()

    transcript_data = json.loads(args.transcript.read_text())
    transcript_segments = transcript_data.get("segments", transcript_data) if isinstance(transcript_data, dict) else transcript_data
    if not isinstance(transcript_segments, list):
        raise ValueError("Transcript file must be a list or an object with a segments list")
    identity_segments = load_identity_segments(args.identification)
    merged = merge_segments(transcript_segments, identity_segments)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"segments": merged}, indent=2))
    print(f"Wrote {len(merged)} merged segments to {args.output}")


if __name__ == "__main__":
    main()
