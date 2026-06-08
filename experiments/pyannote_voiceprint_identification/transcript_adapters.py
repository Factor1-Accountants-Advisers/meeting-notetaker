#!/usr/bin/env python3
"""Normalize transcript JSON into the common experiment segment format."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def load_segments(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text())
    if isinstance(data, list):
        return [_normalize_segment(item, index) for index, item in enumerate(data) if isinstance(item, dict)]
    if isinstance(data, dict):
        for key in ("segments", "transcript_segments", "utterances"):
            value = data.get(key)
            if isinstance(value, list):
                return [_normalize_segment(item, index) for index, item in enumerate(value) if isinstance(item, dict)]
    raise ValueError(f"Could not find transcript segments in {path}")


def _normalize_segment(item: dict[str, Any], index: int) -> dict[str, Any]:
    start = _float(item.get("start"), _float(item.get("start_seconds"), 0.0))
    end = _float(item.get("end"), _float(item.get("end_seconds"), start))
    # AssemblyAI sometimes uses milliseconds.
    if start > 10_000 or end > 10_000:
        start = start / 1000.0
        end = end / 1000.0
    return {
        "start": start,
        "end": end,
        "text": str(item.get("text") or item.get("transcript") or "").strip(),
        "speaker": item.get("speaker"),
        "chunk_offset": _float(item.get("chunk_offset"), 0.0),
        "source_index": index,
    }


def _float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def main() -> None:
    parser = argparse.ArgumentParser(description="Normalize transcript segments for the pyannote merge experiment.")
    parser.add_argument("--input", required=True, type=Path, help="Transcript JSON file")
    parser.add_argument("--output", required=True, type=Path, help="Normalized transcript segments JSON")
    args = parser.parse_args()
    segments = [segment for segment in load_segments(args.input) if segment["text"] and segment["end"] > segment["start"]]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"segments": segments}, indent=2))
    print(f"Wrote {len(segments)} normalized transcript segments to {args.output}")


if __name__ == "__main__":
    main()
