"""Experiment: does submitting 3 voiceprint samples per person beat 1?

Runs pyannoteAI /v1/identify twice on the same meeting audio — once with every
enrolled sample per person, once with only the first sample — and compares the
per-cluster confidence scores. matching.threshold is 0 for both runs so we see
raw scores; the report then applies the real base (0.62) and expansion (0.85)
thresholds offline to show what each condition would have identified.

Usage (from backend/, venv active, MN_PYANNOTE_API_KEY configured):
    python ../scripts/experiment-voiceprint-count.py <audio_path>

Read-only against app state: talks to pyannoteAI only; never touches store.json.
"""

from __future__ import annotations

import sys
from collections import defaultdict
from pathlib import Path

from app.config import get_settings
from app.services.pyannote_client import PyannoteAIClient, PyannotePollConfig
from app.services.voiceprints import get_voiceprint_repository

BASE_THRESHOLD = 0.62
EXPANSION_THRESHOLD = 0.85


def build_payload(samples_per_person: int | None) -> tuple[list[dict[str, str]], dict[str, str]]:
    label_to_name: dict[str, str] = {}
    payload: list[dict[str, str]] = []
    for record in get_voiceprint_repository().get_all():
        samples = record.voiceprints if samples_per_person is None else record.voiceprints[:samples_per_person]
        for idx, value in enumerate(samples):
            if not isinstance(value, str) or not value:
                continue
            label = f"{record.display_name} #{idx + 1}"[:100]
            label_to_name[label] = record.display_name
            payload.append({"label": label, "voiceprint": value})
    return payload[:50], label_to_name


def run_identify(audio_path: Path, condition: str, samples_per_person: int | None) -> dict:
    settings = get_settings()
    payload, label_to_name = build_payload(samples_per_person)
    print(f"[{condition}] submitting {len(payload)} voiceprints "
          f"({len(set(label_to_name.values()))} people)...", flush=True)
    client = PyannoteAIClient(
        settings.pyannote_api_key,
        settings.pyannote_api_endpoint or "https://api.pyannote.ai",
    )
    result = client.identify_audio(
        audio_path,
        payload,
        media_prefix=f"experiment-vp-count/{condition}",
        model=settings.pyannote_model_version or "precision-2",
        matching_threshold=0.0,  # observe raw scores; thresholds applied offline
        exclusive_matching=False,
        poll=PyannotePollConfig(
            interval_seconds=settings.pyannote_poll_interval_seconds,
            timeout_seconds=settings.pyannote_poll_timeout_seconds,
        ),
    )
    import json
    dump = Path(f"var/experiment-vp-{condition}.json")
    dump.write_text(json.dumps(result, indent=2, default=str))
    print(f"[{condition}] raw response saved to {dump}", flush=True)
    return summarize(result, label_to_name)


def summarize(result: dict, label_to_name: dict[str, str]) -> dict:
    """Per (cluster, person): best confidence and total matched speech seconds."""
    output = result.get("output") if isinstance(result.get("output"), dict) else result
    best: dict[tuple[str, str], float] = defaultdict(float)
    seconds: dict[tuple[str, str], float] = defaultdict(float)
    winning_label: dict[tuple[str, str], str] = {}

    # Cluster-level confidence fallback, mirroring _identity_ranges_from_result:
    # identification items may omit per-item confidence; output.voiceprints then
    # carries {speaker, match, confidence: {label: score}} per cluster.
    conf_by_cluster_label: dict[tuple[str, str], float] = {}
    for item in output.get("voiceprints", []) or []:
        if not isinstance(item, dict) or not isinstance(item.get("confidence"), dict):
            continue
        cluster = str(item.get("speaker") or "").strip()
        for label, score in item["confidence"].items():
            if isinstance(score, (int, float)):
                score = float(score) / 100 if score > 1 else float(score)
                conf_by_cluster_label[(cluster, str(label))] = score

    for item in output.get("identification", []) or []:
        if not isinstance(item, dict):
            continue
        label = str(item.get("match") or "").strip()
        person = label_to_name.get(label)
        if not person:
            continue
        cluster = str(item.get("diarizationSpeaker") or item.get("speaker") or "").strip()
        conf = item.get("confidence")
        if not isinstance(conf, (int, float)):
            conf = conf_by_cluster_label.get((cluster, label))
        if not isinstance(conf, (int, float)):
            continue
        conf = conf / 100 if conf > 1 else float(conf)
        key = (cluster, person)
        if conf > best[key]:
            best[key] = conf
            winning_label[key] = label
        try:
            seconds[key] += float(item.get("end", 0)) - float(item.get("start", 0))
        except (TypeError, ValueError):
            pass
    return {
        "best": dict(best),
        "seconds": dict(seconds),
        "winning_label": winning_label,
        "all_scores": conf_by_cluster_label,
    }


def main() -> None:
    audio_path = Path(sys.argv[1])
    if not audio_path.exists():
        sys.exit(f"audio not found: {audio_path}")
    if not get_settings().pyannote_api_key:
        sys.exit("MN_PYANNOTE_API_KEY is not configured")

    three = run_identify(audio_path, "three-samples", None)
    one = run_identify(audio_path, "one-sample", 1)

    keys = sorted(set(three["best"]) | set(one["best"]))
    print(f"\n{'cluster':<12} {'person':<26} {'3-sample':>9} {'1-sample':>9} "
          f"{'delta':>7}  {'passes 0.62':>11} {'passes 0.85':>11}")
    for key in keys:
        c3, c1 = three["best"].get(key, 0.0), one["best"].get(key, 0.0)
        gate = lambda a, b, t: f"{'both' if a >= t and b >= t else '3-only' if a >= t else '1-only' if b >= t else 'neither'}"
        print(f"{key[0]:<12} {key[1]:<26} {c3:>9.3f} {c1:>9.3f} {c3 - c1:>+7.3f}  "
              f"{gate(c3, c1, BASE_THRESHOLD):>11} {gate(c3, c1, EXPANSION_THRESHOLD):>11}")
    print("\nwinning sample per cluster (3-sample run):")
    for key, label in sorted(three["winning_label"].items()):
        print(f"  {key[0]} -> {label} ({three['best'][key]:.3f}, {three['seconds'].get(key, 0):.0f}s matched)")

    print("\nper-sample scores by cluster (3-sample run):")
    for (cluster, label), score in sorted(three["all_scores"].items()):
        print(f"  {cluster:<12} {label:<30} {score:.3f}")
    print("\nper-sample scores by cluster (1-sample run):")
    for (cluster, label), score in sorted(one["all_scores"].items()):
        print(f"  {cluster:<12} {label:<30} {score:.3f}")


if __name__ == "__main__":
    main()
