# PyannoteAI Voiceprint Identification Spike

This directory is an experiment-only workspace for validating pyannoteAI voiceprint speaker identification for Meeting Note-Taker.

It does **not** modify the production backend pipeline. The goal is to prove quality, cost, false-positive handling, and timestamp merge reliability before refactoring the app.

## What this spike tests

1. Create voiceprints from clean 20-30 second single-speaker samples.
2. Run pyannoteAI speaker identification on meeting audio.
3. Load or create timestamped transcription segments.
4. Merge transcript segments with speaker identity ranges by timestamp overlap.
5. Generate a metrics report showing named/unknown/review-needed segments.

## Required environment variables

Do not print or commit secret values.

```bash
export PYANNOTE_API_KEY=...
```

Optional transcription provider keys may be needed later depending on the chosen transcription runner.

## Privacy and retention rules

- Treat voice samples and voiceprints as sensitive identity data.
- Do not commit raw audio, generated voiceprints, API responses, or merged transcripts containing personal data.
- Store local test artifacts only under ignored folders such as `samples/`, `audio/`, and `outputs/`.
- Delete local voice samples when no longer needed.
- This spike is not production-ready until consent, deletion, disable, and audit controls are implemented.

## Expected workflow

```bash
cd experiments/pyannote_voiceprint_identification

# 1. Copy and fill a local manifest. The local manifest is ignored.
cp sample_manifest.example.json sample_manifest.local.json

# 2. Create voiceprints from local samples once API client scripts are present.
python3 create_voiceprints.py --manifest sample_manifest.local.json --output outputs/voiceprints.json

# 3. Run speaker identification.
python3 run_identification.py --manifest sample_manifest.local.json --voiceprints outputs/voiceprints.json --output outputs/identification.json

# 4. Merge identification with timestamped transcript segments.
python3 merge_segments.py --transcript outputs/transcript_segments.json --identification outputs/identification.json --output outputs/merged_transcript.json

# 5. Evaluate the result.
python3 evaluate_merge.py --merged outputs/merged_transcript.json --output outputs/report.md
```

## Safe output policy

Only commit source code, tests, examples, and docs. Do not commit:

- `sample_manifest.local.json`
- audio/video files
- generated voiceprints
- pyannote API responses
- OpenAI/AssemblyAI responses
- merged named transcripts from real meetings
- cost/latency logs containing meeting identifiers
