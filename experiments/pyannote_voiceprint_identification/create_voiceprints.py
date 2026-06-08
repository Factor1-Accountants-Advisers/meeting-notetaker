#!/usr/bin/env python3
"""Create pyannoteAI voiceprints from local sample audio listed in a manifest."""

from __future__ import annotations

import argparse
from pathlib import Path

from pyannote_client import PollConfig, PyannoteClient, require_manifest, safe_media_key, write_json


def main() -> None:
    parser = argparse.ArgumentParser(description="Create pyannoteAI voiceprints for experiment speakers.")
    parser.add_argument("--manifest", required=True, type=Path, help="Local manifest JSON")
    parser.add_argument("--output", required=True, type=Path, help="Ignored output JSON for voiceprints")
    parser.add_argument("--dry-run", action="store_true", help="Validate manifest and print planned uploads only")
    args = parser.parse_args()

    manifest = require_manifest(args.manifest)
    pyannote_cfg = manifest.get("pyannote", {})
    prefix = str(pyannote_cfg.get("media_key_prefix") or "notetaker/pyannote-spike")
    poll = PollConfig(
        interval_seconds=int(pyannote_cfg.get("poll_interval_seconds", 10)),
        timeout_seconds=int(pyannote_cfg.get("poll_timeout_seconds", 1800)),
    )
    speakers = manifest.get("speakers") or []
    if not isinstance(speakers, list) or not speakers:
        raise ValueError("Manifest must contain a non-empty speakers list")

    client = None if args.dry_run else PyannoteClient()
    results = []

    for speaker in speakers:
        label = str(speaker.get("label") or speaker.get("display_name") or "").strip()
        sample_path = Path(str(speaker.get("sample_path") or ""))
        if not label:
            raise ValueError("Each speaker needs a label")
        if not sample_path.exists():
            if args.dry_run:
                print(f"DRY RUN missing local sample for {label}: {sample_path}")
                continue
            raise FileNotFoundError(sample_path)
        suffix = sample_path.suffix.lstrip(".") or "wav"
        media_url = safe_media_key(prefix, f"voiceprint-{label}", suffix)
        print(f"Creating voiceprint for {label} from {sample_path.name} via {media_url}")
        if args.dry_run:
            results.append({"label": label, "sample_path": str(sample_path), "media_url": media_url, "dry_run": True})
            continue
        assert client is not None
        client.upload_media_file(sample_path, media_url)
        job = client.create_voiceprint_job(media_url)
        job_id = job.get("jobId")
        if not isinstance(job_id, str):
            raise RuntimeError(f"Voiceprint job for {label} did not return jobId")
        result = client.wait_for_job(job_id, poll)
        output = result.get("output") or {}
        voiceprint = output.get("voiceprint") if isinstance(output, dict) else None
        if not isinstance(voiceprint, str):
            raise RuntimeError(f"Voiceprint job for {label} did not return output.voiceprint")
        results.append(
            {
                "label": label,
                "display_name": speaker.get("display_name") or label,
                "email": speaker.get("email"),
                "voiceprint": voiceprint,
                "job_id": job_id,
                "expected_attendee": bool(speaker.get("expected_attendee", True)),
            }
        )

    write_json(args.output, {"voiceprints": results})
    print(f"Wrote {len(results)} voiceprint records to {args.output}")


if __name__ == "__main__":
    main()
