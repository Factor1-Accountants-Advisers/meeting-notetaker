#!/usr/bin/env python3
"""Run pyannoteAI speaker identification for one experiment meeting audio file."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from pyannote_client import PollConfig, PyannoteClient, load_json, require_manifest, safe_media_key, write_json


def build_voiceprint_payload(voiceprints_path: Path) -> list[dict[str, str]]:
    data = load_json(voiceprints_path)
    records = data.get("voiceprints") if isinstance(data, dict) else data
    if not isinstance(records, list) or not records:
        raise ValueError("Voiceprints file must contain a non-empty voiceprints list")
    payload: list[dict[str, str]] = []
    for record in records:
        if not isinstance(record, dict):
            continue
        label = str(record.get("label") or record.get("display_name") or "").strip()
        voiceprint = record.get("voiceprint")
        if not label or not isinstance(voiceprint, str):
            raise ValueError("Each voiceprint record must contain label/display_name and voiceprint")
        payload.append({"label": label, "voiceprint": voiceprint})
    return payload


def normalize_identification_output(result: dict[str, Any], voiceprints_path: Path) -> dict[str, Any]:
    voiceprint_records = load_json(voiceprints_path).get("voiceprints", [])
    by_label = {str(record.get("label")): record for record in voiceprint_records if isinstance(record, dict)}
    output = result.get("output") if isinstance(result, dict) else {}
    identification = output.get("identification", []) if isinstance(output, dict) else []
    voiceprint_confidence = output.get("voiceprints", []) if isinstance(output, dict) else []
    confidence_by_raw = {}
    if isinstance(voiceprint_confidence, list):
        for item in voiceprint_confidence:
            if not isinstance(item, dict):
                continue
            raw = item.get("speaker")
            conf = item.get("confidence")
            match = item.get("match")
            if isinstance(raw, str) and isinstance(conf, dict) and isinstance(match, str):
                confidence_by_raw[raw] = conf.get(match)

    segments = []
    if isinstance(identification, list):
        for item in identification:
            if not isinstance(item, dict):
                continue
            label = str(item.get("match") or item.get("speaker") or "").strip()
            voiceprint_record = by_label.get(label, {})
            raw = str(item.get("diarizationSpeaker") or item.get("raw_speaker_label") or item.get("speaker") or "").strip()
            segments.append(
                {
                    "start": item.get("start"),
                    "end": item.get("end"),
                    "raw_speaker_label": raw,
                    "display_name": voiceprint_record.get("display_name") or label,
                    "email": voiceprint_record.get("email"),
                    "confidence": confidence_by_raw.get(raw, item.get("confidence", 70)),
                    "is_candidate_attendee": bool(voiceprint_record.get("expected_attendee", True)),
                }
            )
    return {"raw_result": result, "identity_segments": segments}


def main() -> None:
    parser = argparse.ArgumentParser(description="Run pyannoteAI voiceprint speaker identification.")
    parser.add_argument("--manifest", required=True, type=Path, help="Local manifest JSON")
    parser.add_argument("--voiceprints", required=True, type=Path, help="Ignored voiceprints JSON from create_voiceprints.py")
    parser.add_argument("--output", required=True, type=Path, help="Ignored output JSON for identification result")
    parser.add_argument("--dry-run", action="store_true", help="Validate inputs and print planned job only")
    args = parser.parse_args()

    manifest = require_manifest(args.manifest)
    meeting = manifest.get("meeting") or {}
    pyannote_cfg = manifest.get("pyannote", {})
    prefix = str(pyannote_cfg.get("media_key_prefix") or "notetaker/pyannote-spike")
    meeting_label = str(meeting.get("label") or "meeting")
    audio_path = Path(str(meeting.get("audio_path") or ""))
    if not audio_path.exists():
        if args.dry_run:
            print(f"DRY RUN missing local meeting audio: {audio_path}")
        else:
            raise FileNotFoundError(audio_path)
    voiceprints = build_voiceprint_payload(args.voiceprints)
    suffix = audio_path.suffix.lstrip(".") or "wav"
    media_url = safe_media_key(prefix, f"meeting-{meeting_label}", suffix)
    num_speakers = meeting.get("expected_speakers")
    num_speakers = int(num_speakers) if num_speakers else None
    print(f"Identification plan: audio={audio_path.name}, media={media_url}, voiceprints={len(voiceprints)}, expected_speakers={num_speakers}")
    if args.dry_run:
        write_json(args.output, {"dry_run": True, "media_url": media_url, "voiceprints_count": len(voiceprints)})
        return

    client = PyannoteClient()
    poll = PollConfig(
        interval_seconds=int(pyannote_cfg.get("poll_interval_seconds", 10)),
        timeout_seconds=int(pyannote_cfg.get("poll_timeout_seconds", 1800)),
    )
    client.upload_media_file(audio_path, media_url)
    job = client.identify_job(
        media_url=media_url,
        voiceprints=voiceprints,
        matching_threshold=int(pyannote_cfg.get("matching_threshold", 60)),
        exclusive_matching=bool(pyannote_cfg.get("exclusive_matching", True)),
        num_speakers=num_speakers,
    )
    job_id = job.get("jobId")
    if not isinstance(job_id, str):
        raise RuntimeError("Identification job did not return jobId")
    result = client.wait_for_job(job_id, poll)
    normalized = normalize_identification_output(result, args.voiceprints)
    normalized["job_id"] = job_id
    write_json(args.output, normalized)
    print(f"Wrote identification output to {args.output}")


if __name__ == "__main__":
    main()
