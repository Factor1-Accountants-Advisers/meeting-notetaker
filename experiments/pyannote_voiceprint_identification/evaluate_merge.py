#!/usr/bin/env python3
"""Evaluate merged named transcript output from the pyannote spike."""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


def load_segments(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text())
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("segments"), list):
        return data["segments"]
    raise ValueError(f"Could not find segments in {path}")


def segment_duration(segment: dict[str, Any]) -> float:
    try:
        return max(0.0, float(segment.get("end", 0)) - float(segment.get("start", 0)))
    except (TypeError, ValueError):
        return 0.0


def summarize(segments: list[dict[str, Any]]) -> dict[str, Any]:
    flags = Counter()
    speaker_time: dict[str, float] = defaultdict(float)
    named = likely = unknown = 0
    total_duration = 0.0
    confidence_sum = 0.0
    confidence_count = 0

    for segment in segments:
        duration = segment_duration(segment)
        total_duration += duration
        speaker = segment.get("speaker")
        review_flags = segment.get("review_flags") or []
        for flag in review_flags:
            flags[str(flag)] += 1
        if speaker:
            speaker_time[str(speaker)] += duration
            if review_flags:
                likely += 1
            else:
                named += 1
        else:
            unknown += 1
        confidence = segment.get("speaker_confidence")
        if isinstance(confidence, (int, float)):
            confidence_sum += float(confidence)
            confidence_count += 1

    return {
        "segments_total": len(segments),
        "segments_named": named,
        "segments_likely_or_reviewed": likely,
        "segments_unknown": unknown,
        "duration_seconds": round(total_duration, 3),
        "average_confidence": round(confidence_sum / confidence_count, 3) if confidence_count else None,
        "review_flag_counts": dict(flags.most_common()),
        "speaker_time_seconds": {speaker: round(seconds, 3) for speaker, seconds in sorted(speaker_time.items())},
    }


def render_markdown(summary: dict[str, Any]) -> str:
    lines = [
        "# Pyannote Voiceprint Merge Evaluation",
        "",
        "## Summary",
        "",
        f"- Total segments: {summary['segments_total']}",
        f"- Named segments: {summary['segments_named']}",
        f"- Likely/reviewed segments: {summary['segments_likely_or_reviewed']}",
        f"- Unknown segments: {summary['segments_unknown']}",
        f"- Duration seconds: {summary['duration_seconds']}",
        f"- Average confidence: {summary['average_confidence']}",
        "",
        "## Speaker time",
        "",
    ]
    speaker_time = summary.get("speaker_time_seconds") or {}
    if speaker_time:
        for speaker, seconds in speaker_time.items():
            lines.append(f"- {speaker}: {seconds}s")
    else:
        lines.append("- No named speaker time.")
    lines.extend(["", "## Review flags", ""])
    flags = summary.get("review_flag_counts") or {}
    if flags:
        for flag, count in flags.items():
            lines.append(f"- {flag}: {count}")
    else:
        lines.append("- No review flags.")
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate merged pyannote/transcript segments.")
    parser.add_argument("--merged", required=True, type=Path, help="Merged transcript JSON")
    parser.add_argument("--output", type=Path, help="Markdown report output path")
    parser.add_argument("--json-output", type=Path, help="Optional JSON summary output path")
    args = parser.parse_args()

    summary = summarize(load_segments(args.merged))
    print(json.dumps(summary, indent=2))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(render_markdown(summary))
        print(f"Wrote markdown report to {args.output}")
    if args.json_output:
        args.json_output.parent.mkdir(parents=True, exist_ok=True)
        args.json_output.write_text(json.dumps(summary, indent=2))
        print(f"Wrote JSON summary to {args.json_output}")


if __name__ == "__main__":
    main()
