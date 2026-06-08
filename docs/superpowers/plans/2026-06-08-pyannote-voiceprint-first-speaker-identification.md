# PyannoteAI Voiceprint-First Speaker Identification Implementation Plan

Date: 2026-06-08
Spec: `docs/superpowers/specs/2026-06-08-pyannote-voiceprint-first-speaker-identification-design.md`

## Goal

Validate and then integrate a pyannoteAI voiceprint-first speaker identification pipeline for Meeting Note-Taker. The first deliverable is an experiment-only spike that does not change production processing. Later phases may replace the current AssemblyAI-centered speaker identity path after the spike proves quality, cost, and merge reliability.

## Current constraints

- Current production backend is AssemblyAI-centered in `backend/app/services/transcription.py`.
- Existing speaker mapping/review concepts already exist and should be reused later.
- Current repo has pre-existing untracked Teams proof files and `experiments/`; do not include those accidentally in commits.
- Voiceprints are sensitive identity data. The spike may use manual samples, but production requires consent/disable/delete/audit controls.
- Teams/Graph transcripts are no longer the primary product architecture. They may be used as evaluation references only.

## Phase 0: Experiment-only spike

### Task 0.1: Create isolated experiment directory

Files:
- Create: `experiments/pyannote_voiceprint_identification/README.md`
- Create: `experiments/pyannote_voiceprint_identification/.gitignore`
- Create: `experiments/pyannote_voiceprint_identification/sample_manifest.example.json`

Requirements:
- Explain that this is a throwaway spike and does not modify production pipeline.
- Document required env vars without printing secrets:
  - `PYANNOTE_API_KEY`
  - optional transcription provider keys depending on chosen run mode.
- Ignore local audio, voice samples, generated outputs, caches, and API responses that may contain sensitive speaker data.
- Include a safe manifest shape for test speakers and audio paths.

Verification:

```bash
cd /home/josephmiguelguerrero/projects/meeting-notetaker
python3 -m json.tool experiments/pyannote_voiceprint_identification/sample_manifest.example.json >/dev/null
```

Commit:

```bash
git add experiments/pyannote_voiceprint_identification/README.md \
        experiments/pyannote_voiceprint_identification/.gitignore \
        experiments/pyannote_voiceprint_identification/sample_manifest.example.json
git commit -m "chore: scaffold pyannote voiceprint experiment"
```

### Task 0.2: Add deterministic timestamp overlap merger

Files:
- Create: `experiments/pyannote_voiceprint_identification/merge_segments.py`
- Create: `experiments/pyannote_voiceprint_identification/test_merge_segments.py`

Implementation:
- Pure Python, standard library only.
- Input JSON:
  - transcript segments: `{start, end, text, chunk_offset?}`
  - identity segments: `{start, end, raw_speaker_label, display_name?, email?, confidence?, is_candidate_attendee?, chunk_offset?}`
- Output JSON:
  - merged segments with `speaker`, `speaker_email`, `speaker_confidence`, `overlap_ratio`, `review_flags`, and evidence.
- Use conservative thresholds:
  - discard identity detections below 0.50s;
  - strong assignment >= 0.70 score;
  - likely assignment 0.50-0.70 with review flag;
  - non-attendee needs >= 0.85 score and >= 0.60 overlap or it becomes review/unknown;
  - margin under 0.15 adds `ambiguous_speaker`.
- Prefer Unknown over wrong named speaker.

Tests:
- single strong overlap assigns speaker;
- no overlap returns Unknown with `no_identity_overlap`;
- competing speakers with close scores gets `ambiguous_speaker`;
- low confidence gets review flag;
- short false positive is suppressed;
- non-attendee weak match does not auto-label;
- chunk offsets normalize correctly.

Verification:

```bash
cd experiments/pyannote_voiceprint_identification
python3 -m unittest test_merge_segments.py
python3 -m py_compile merge_segments.py
```

Commit:

```bash
git add experiments/pyannote_voiceprint_identification/merge_segments.py \
        experiments/pyannote_voiceprint_identification/test_merge_segments.py
git commit -m "feat: add pyannote transcript merge experiment"
```

### Task 0.3: Add pyannoteAI API client for experiment runs

Files:
- Create: `experiments/pyannote_voiceprint_identification/pyannote_client.py`
- Create: `experiments/pyannote_voiceprint_identification/create_voiceprints.py`
- Create: `experiments/pyannote_voiceprint_identification/run_identification.py`

Implementation:
- Standard library only (`urllib.request`) unless a dependency already exists in the backend venv.
- Read `PYANNOTE_API_KEY` from env and fail closed if missing.
- Never print the API key, full signed URLs, or raw voiceprint strings unless writing to explicitly ignored output files.
- Support Media API upload flow:
  - `POST /v1/media/input`
  - `PUT` local file bytes to returned signed URL
  - use `media://...` URL in jobs.
- Support voiceprint creation:
  - `POST /v1/voiceprint`
  - poll `/v1/jobs/{jobId}` until terminal state.
- Support speaker identification:
  - `POST /v1/identify`
  - `matching.threshold`, `matching.exclusive`, and optional `numSpeakers`.
- Persist raw API results under ignored `outputs/`.

Verification:

```bash
cd experiments/pyannote_voiceprint_identification
python3 -m py_compile pyannote_client.py create_voiceprints.py run_identification.py
python3 create_voiceprints.py --help
python3 run_identification.py --help
```

No live API run is required unless `PYANNOTE_API_KEY` and real sample/audio paths are available.

Commit:

```bash
git add experiments/pyannote_voiceprint_identification/pyannote_client.py \
        experiments/pyannote_voiceprint_identification/create_voiceprints.py \
        experiments/pyannote_voiceprint_identification/run_identification.py
git commit -m "feat: add pyannote voiceprint experiment client"
```

### Task 0.4: Add transcription input adapter

Files:
- Create: `experiments/pyannote_voiceprint_identification/transcript_adapters.py`
- Optionally create: `experiments/pyannote_voiceprint_identification/run_openai_transcription.py`

Implementation:
- Normalize provider transcript output into common segment JSON.
- At minimum support loading an existing transcript JSON so we can test merge without spending transcription credits.
- If adding OpenAI transcription runner, use safe chunk offsets and do not print secrets.

Verification:

```bash
cd experiments/pyannote_voiceprint_identification
python3 -m py_compile transcript_adapters.py
```

Commit:

```bash
git add experiments/pyannote_voiceprint_identification/transcript_adapters.py
git commit -m "feat: add transcript adapter for pyannote experiment"
```

If an OpenAI transcription runner is added in the same task, stage that explicit file separately.

### Task 0.5: Add evaluation report generator

Files:
- Create: `experiments/pyannote_voiceprint_identification/evaluate_merge.py`

Implementation:
- Read merged transcript JSON and optional reference CSV/JSON.
- Report:
  - total segments;
  - named/likely/unknown counts;
  - review flag counts;
  - non-attendee detections;
  - average confidence;
  - speaker speaking time totals;
  - if reference is supplied: duration-weighted accuracy and wrong-named duration.

Verification:

```bash
cd experiments/pyannote_voiceprint_identification
python3 -m py_compile evaluate_merge.py
python3 evaluate_merge.py --help
```

Commit:

```bash
git add experiments/pyannote_voiceprint_identification/evaluate_merge.py
git commit -m "feat: add pyannote merge evaluation report"
```

### Task 0.6: Run controlled spike

Prerequisites:
- `PYANNOTE_API_KEY` available in environment, not committed.
- local sample audio files available and ignored.
- one meeting audio or 10-minute clip available and ignored.

Commands shape:

```bash
cd experiments/pyannote_voiceprint_identification
python3 create_voiceprints.py --manifest sample_manifest.local.json --output outputs/voiceprints.json
python3 run_identification.py --manifest sample_manifest.local.json --voiceprints outputs/voiceprints.json --output outputs/identification.json
python3 merge_segments.py --transcript outputs/transcript_segments.json --identification outputs/identification.json --output outputs/merged_transcript.json
python3 evaluate_merge.py --merged outputs/merged_transcript.json --reference optional_reference.json --output outputs/report.md
```

Report to Joseph:
- candidate meeting/audio duration;
- speakers and voiceprint sample durations;
- pyannote identified speakers;
- false positives and suppressed detections;
- percent named/unknown/review-needed;
- transcript merge quality;
- cost/latency estimate;
- recommendation for production integration.

## Phase 1: Backend prototype after successful spike

Do not start until Phase 0 report is reviewed.

### Task 1.1: Add pyannote settings and provider abstraction

Files likely:
- `backend/app/core/config.py`
- `backend/app/services/providers.py` or `backend/app/services/speaker_identification.py`
- tests under `backend/tests/`

Requirements:
- Add `PYANNOTE_API_KEY` config without logging value.
- Add fake/test provider.
- Keep AssemblyAI path working.

### Task 1.2: Add `pyannote_voiceprint` mapping source

Files likely:
- `backend/app/models.py`
- `backend/app/schemas.py`
- migrations/schema upgrade tests.

Requirements:
- Add enum value without breaking existing data.
- Preserve user-corrected mappings over pyannote outputs.

### Task 1.3: Add voiceprint persistence

Files likely:
- `backend/app/models.py`
- `backend/app/schemas.py`
- routes/admin UI later.

Requirements:
- Store pyannote voiceprint strings/IDs securely.
- Add status, consent timestamp, disabled/deleted state.
- No raw audio retention by default.

### Task 1.4: Integrate merger into backend processing

Requirements:
- Use same normalized audio for pyannote and transcription.
- Store pyannote identity mappings through `SpeakerMapping`.
- Ensure summarisation sees resolved names.
- Ensure `process_diarisation()` no longer fights this mapping layer.

## Phase 2: Product integration

- Admin/manual voiceprint upload page.
- Self-service consent/recording flow.
- Speaker review UI improvements for pyannote confidence/non-attendee warnings.
- Audit logs and offboarding controls.
- Cost/latency diagnostics.

## Safety checklist before production refactor

- [ ] Spike output proves quality on a known IAS Sync meeting.
- [ ] False positives are suppressed or clearly review-gated.
- [ ] Transcript merge works on chunked and full audio.
- [ ] Production path has tests for pyannote failure and transcription failure separately.
- [ ] Summarisation uses resolved speaker names.
- [ ] Manual speaker/action-owner corrections survive reprocessing.
- [ ] Voiceprint consent/delete/disable controls are designed.
- [ ] No raw voice samples or provider secrets are committed.
