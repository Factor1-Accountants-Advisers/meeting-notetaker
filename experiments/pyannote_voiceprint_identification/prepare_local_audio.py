#!/usr/bin/env python3
"""Prepare local audio files for the pyannote voiceprint experiment.

This script is safe to commit because it does not contain meeting data. It reads an
ignored local segments file and writes ignored local audio clips.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from typing import Any


def parse_timestamp(value: str | int | float) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if not text:
        raise ValueError("empty timestamp")
    parts = text.split(":")
    try:
        if len(parts) == 1:
            return float(parts[0])
        if len(parts) == 2:
            minutes, seconds = parts
            return int(minutes) * 60 + float(seconds)
        if len(parts) == 3:
            hours, minutes, seconds = parts
            return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    except ValueError as exc:
        raise ValueError(f"invalid timestamp: {value!r}") from exc
    raise ValueError(f"invalid timestamp: {value!r}")


def run_ffmpeg(args: list[str]) -> None:
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args]
    subprocess.run(command, check=True)


def extract_wav(source: Path, start: float | None, end: float | None, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    args: list[str] = []
    if start is not None:
        args.extend(["-ss", f"{start:.3f}"])
    args.extend(["-i", str(source)])
    if start is not None and end is not None:
        duration = max(0.0, end - start)
        args.extend(["-t", f"{duration:.3f}"])
    args.extend(["-vn", "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", str(output)])
    run_ffmpeg(args)


def load_segments(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text())
    segments = data.get("voice_samples") if isinstance(data, dict) else data
    if not isinstance(segments, list):
        raise ValueError("segments file must be a list or an object with voice_samples list")
    return [item for item in segments if isinstance(item, dict)]


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract meeting audio and clean voiceprint samples from a recording.")
    parser.add_argument("--source", required=True, type=Path, help="Source recording, e.g. MP4 from Downloads")
    parser.add_argument("--segments", required=True, type=Path, help="Ignored local JSON with voice sample timestamps")
    parser.add_argument("--meeting-output", default=Path("audio/ias-sync-full.wav"), type=Path, help="Ignored full meeting audio output")
    parser.add_argument("--skip-meeting", action="store_true", help="Only extract voice samples")
    parser.add_argument("--meeting-only", action="store_true", help="Only extract the full meeting audio, not voice samples")
    args = parser.parse_args()

    if not args.source.exists():
        raise FileNotFoundError(args.source)

    if not args.skip_meeting:
        print(f"Extracting full meeting audio -> {args.meeting_output}")
        extract_wav(args.source, None, None, args.meeting_output)

    if args.meeting_only:
        return

    for item in load_segments(args.segments):
        label = str(item.get("label") or "").strip()
        output = Path(str(item.get("output") or ""))
        if not label or not output:
            raise ValueError("each voice sample needs label and output")
        if str(item.get("start", "")).startswith("START_") or str(item.get("end", "")).startswith("END_"):
            print(f"Skipping {label}: timestamp placeholder not filled")
            continue
        start = parse_timestamp(item["start"])
        end = parse_timestamp(item["end"])
        if end <= start:
            raise ValueError(f"{label}: end must be after start")
        duration = end - start
        if duration > 30.0:
            print(f"WARNING {label}: sample is {duration:.1f}s; pyannote voiceprints should be <=30s")
        if duration < 10.0:
            print(f"WARNING {label}: sample is only {duration:.1f}s; 20-30s is preferred")
        print(f"Extracting {label}: {start:.3f}-{end:.3f}s -> {output}")
        extract_wav(args.source, start, end, output)


if __name__ == "__main__":
    main()
