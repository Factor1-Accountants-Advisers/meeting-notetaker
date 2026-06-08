# PyannoteAI Voiceprint-First Speaker Identification Design

Date: 2026-06-08
Project: Meeting Note-Taker
Status: Draft approved conversationally by Joseph for planning

## Summary

Notetaker will move away from a Microsoft Teams-first transcript-import strategy and toward a voiceprint-first speaker identification strategy. The app will rely on pyannoteAI speaker diarization plus voiceprint identification to name known speakers in recorded meeting audio, then merge those speaker time ranges with a timestamped transcription result. Microsoft Graph/Teams transcripts may remain useful as evaluation references during experiments, but they are no longer the product’s primary architecture path.

The new target pipeline is:

1. Record or upload meeting audio/video.
2. Normalize the audio once.
3. Run pyannoteAI speaker diarization + speaker identification against known voiceprints.
4. Run a transcription provider against the same normalized audio.
5. Merge transcription segments with pyannote speaker identity ranges by timestamp overlap.
6. Persist a named transcript through the existing speaker mapping layer.
7. Generate summaries and action items using speaker confidence.
8. Keep speaker review and action-owner review as the safety net.

This should make speaker names reliable for recurring internal Factor1 speakers without depending on Teams meeting transcripts being enabled, available, licensed, or accessible.

## Goals

- Make pyannoteAI voiceprint identification the canonical speaker identity path.
- Identify recurring internal speakers by voiceprint, not only by attendee names or LLM inference.
- Preserve the existing speaker review UX as a correction and confidence workflow.
- Preserve manual speaker/action-owner corrections as authoritative.
- Produce a named transcript with explicit confidence and source metadata.
- Support non-Teams meetings and local/system-audio recordings with the same pipeline.
- Keep the first implementation testable as a controlled spike before product-wide refactor.

## Non-goals

- Do not implement Microsoft Graph Teams transcript import as the primary product path.
- Do not build a Teams bot that joins meetings.
- Do not promise perfect diarization or perfect speaker identity.
- Do not roll out company-wide voiceprints without consent/deletion controls.
- Do not store raw voice sample audio long-term unless explicitly approved.
- Do not remove the review workflow just because pyannoteAI performs well in a demo.

## Key principle

Voiceprints identify known speakers; they do not inherently fix bad diarization. The system must separate these layers:

- transcription: what words were said;
- diarization: when each generic speaker spoke;
- speaker identification: which known person matches each diarized speaker segment;
- speaker mapping: what name/email the product displays;
- action ownership: who owns a task extracted from the transcript.

A named speaker is only trustworthy when both timestamp alignment and identification confidence are good enough. Otherwise the UI should show `Likely`, `Uncertain`, or `Unknown` states and ask for review.

## Current system context

Current backend transcription is centered on `backend/app/services/transcription.py`, which sends audio to AssemblyAI for transcription and speaker diarization in a single call. Existing models already include useful speaker review fields:

- `Meeting.needs_speaker_review`
- `Meeting.speaker_mapping_quality`
- `Meeting.diarization_diagnostics`
- `Transcript.segments`
- `Transcript.speaker_identified`
- `SpeakerMapping`
- `SpeakerMappingSource`
- `ActionOwnerSource`

Existing docs and planned implementation already support speaker review and action-owner confidence. This design should reuse those concepts rather than replacing them.

## Proposed architecture

### Pipeline overview

```text
Desktop recorder / upload
  -> backend processing job
  -> audio normalization
  -> pyannoteAI diarization + voiceprint identification
  -> timestamped transcription
  -> timestamp-overlap merge
  -> speaker mappings + diagnostics
  -> summary/action item generation
  -> speaker/action-owner review UI
```

### Provider boundaries

Introduce explicit provider interfaces instead of embedding provider logic in one transcription function.

```python
class TranscriptionProvider:
    def transcribe(audio_path: str) -> TranscriptionResult: ...

class SpeakerIdentificationProvider:
    def create_voiceprint(sample_path: str, metadata: VoiceprintMetadata) -> VoiceprintResult: ...
    def identify(audio_path: str, voiceprint_ids: list[str]) -> SpeakerIdentificationResult: ...

class TranscriptMerger:
    def merge(transcript_segments, identity_segments, options) -> MergedTranscriptResult: ...
```

Expected first concrete providers:

- `PyannoteSpeakerIdentificationProvider`
- one transcription provider chosen after spike:
  - GPT-4o-transcribe, or
  - pyannoteAI STT orchestration, or
  - AssemblyAI words-only as a transitional path.

The provider boundary lets the spike compare transcription engines while keeping speaker identity logic stable.

## Voiceprint management

### Voiceprint record

Add a first-class voiceprint record. Exact table names can be refined during implementation, but the domain model should include:

```text
speaker_voiceprints
- id
- person_display_name
- person_email
- app_user_id nullable
- pyannote_voiceprint_id
- status: active | disabled | needs_refresh | deleted
- sample_duration_seconds
- sample_source: admin_upload | self_recording | approved_meeting_clip
- consent_recorded_at nullable
- disabled_at nullable
- deleted_at nullable
- created_by_user_id nullable
- created_at
- updated_at
```

Production should store only the pyannote voiceprint ID and metadata by default. Temporary raw samples should be deleted after voiceprint creation unless a separate retention decision is approved.

### Voiceprint creation modes

Phase 0 / spike:

- Admin/manual sample upload only.
- Use about 20-30 seconds of clean speech per known speaker.
- Store outputs in experiment artifacts, not production tables, unless the spike moves into Phase 1.

Production v1:

- Self-service recording with explicit consent.
- User reads a short prompt or uploads a clean clip.
- App creates a voiceprint and records consent timestamp.
- Admins can disable/delete voiceprints.

Deferred:

- Creating voiceprints from previous meeting clips. This is useful but risky because a wrong clip can poison identity. Add only after the review process is mature.

## Candidate voiceprint selection

False positives increase when too many candidate voiceprints are sent. David’s test already observed a short false positive for DV. Therefore the default candidate set should be narrow.

Selection order:

1. Meeting attendees with active voiceprints.
2. Organizer and current recorder if they have voiceprints.
3. Manually added participants with active voiceprints.
4. Optional fallback: recent/common participants, only when attendee metadata is missing.

Avoid sending all company voiceprints by default.

Non-attendee identity detections must use stricter thresholds before auto-display. If the system detects a person not listed for the meeting, show a diagnostic such as `Possible false positive: David detected for 9 seconds` rather than confidently labeling them.

## Speaker identification output

pyannoteAI identity output should be normalized to app-owned structures:

```text
SpeakerIdentitySegment
- start_seconds
- end_seconds
- raw_speaker_label
- candidate_voiceprint_id
- display_name
- email
- confidence
- source: pyannote_voiceprint
- is_candidate_attendee
- metadata
```

Keep raw labels and identity segments for diagnostics. Display should resolve through `SpeakerMapping`, not by destructively rewriting raw provider output.

## Transcription provider decision

The speaker identification path and transcription path should be evaluated separately.

Spike candidates:

1. GPT-4o-transcribe for words + pyannoteAI for speaker identity.
2. pyannoteAI STT orchestration for speaker-attributed transcript if practical.
3. AssemblyAI words-only as a transitional baseline.

The final v1 transcription provider should be selected by measured quality:

- word accuracy/completeness;
- timestamp quality;
- chunking behavior;
- cost per meeting hour;
- integration simplicity;
- whether word-level timestamps are available for better speaker merge.

If GPT-4o-transcribe is used, the audio must be chunked consistently so timestamps remain mergeable. Every chunk must retain an absolute start offset.

## Timestamp merge design

### Inputs

Transcription segments:

```json
{
  "start": 10.2,
  "end": 15.8,
  "text": "I'll send the updated report tomorrow."
}
```

Speaker identity segments:

```json
{
  "start": 9.9,
  "end": 16.1,
  "raw_speaker_label": "SPEAKER_00",
  "display_name": "Joseph",
  "email": "joseph@example.com",
  "confidence": 0.91
}
```

Merged segment:

```json
{
  "start": 10.2,
  "end": 15.8,
  "text": "I'll send the updated report tomorrow.",
  "speaker": "Joseph",
  "raw_speaker_label": "SPEAKER_00",
  "speaker_email": "joseph@example.com",
  "speaker_confidence": 0.91,
  "speaker_source": "pyannote_voiceprint",
  "speaker_assignment_reason": "0.96 overlap with identified speaker range"
}
```

### Merge rules

For each transcription segment:

1. Find all speaker identity segments overlapping the transcription segment.
2. Compute overlap ratio against the transcription segment duration.
3. Pick the candidate with the highest weighted score:
   - overlap ratio;
   - pyannote confidence;
   - whether candidate is an expected attendee;
   - duration/repetition support.
4. Assign the speaker if thresholds are met.
5. Mark as uncertain if thresholds are partially met.
6. Mark as unknown if thresholds are not met.

Recommended first thresholds:

```text
Auto-confirmed:
- identity confidence >= 0.80
- overlap ratio >= 0.60
- not an isolated very-short detection

Likely:
- identity confidence >= 0.65
- overlap ratio >= 0.50

Uncertain:
- confidence below 0.65
- overlap ratio below 0.50
- competing speakers have similar scores
- non-attendee candidate detected briefly

Suppress/ignore:
- non-attendee identity detection under 3 seconds unless confidence is very high and repeated
```

If word-level timestamps are available, the merger may split transcript segments when two speakers clearly overlap different parts of the text. If only segment-level timestamps are available, prefer marking uncertain rather than creating fake precision.

## Speaker mapping and review behavior

The canonical display layer remains `SpeakerMapping`.

Mapping priority at display time:

1. `user_corrected`
2. high-confidence `pyannote_voiceprint`
3. medium-confidence `pyannote_voiceprint` displayed as likely
4. generic raw speaker label
5. Unknown

Review is required when:

- any meaningful speaker label is unknown;
- any important speaker assignment is below threshold;
- a non-attendee was detected;
- the system detects possible false positives;
- many transcript segments have weak timestamp overlap.

Review UI should show:

- detected name;
- confidence;
- attendee/non-attendee status;
- total speaking time;
- representative quotes;
- warning for short/isolated detections;
- actions: confirm, remap, mark unknown.

A user-confirmed mapping should immediately become `user_corrected` and must not be overwritten by future automated runs.

## Action-owner behavior

Existing action-owner confidence work should continue, but speaker identity now comes from pyannote voiceprints.

Owner resolution order:

1. Explicit assignment in transcript text: `Joseph, can you...`, `David will...`.
2. First-person action from an identified speaker: `I'll do that`.
3. Participant/name match.
4. LLM extraction fallback.
5. Unassigned.

Action item metadata should include:

```text
owner_name
owner_email
owner_confidence
owner_source
owner_reason
```

If speaker identity is only likely, owner assignment should also be likely. Manual owner edits remain authoritative and should not be overwritten by re-resolution.

## Diagnostics

Each processed meeting should include compact diagnostics:

```json
{
  "speaker_identification": {
    "provider": "pyannoteAI",
    "voiceprints_used": 4,
    "identified_speaker_count": 4,
    "candidate_non_attendee_detections": 1,
    "average_identity_confidence": 0.86,
    "low_confidence_segments": 8,
    "short_detection_suppressed_count": 2
  },
  "transcript_merge": {
    "segments_total": 120,
    "segments_named": 108,
    "segments_likely": 7,
    "segments_unknown": 5,
    "average_overlap_ratio": 0.82,
    "strategy": "timestamp_overlap"
  }
}
```

Diagnostics should be visible enough for support/debugging but not overwhelm normal users.

## Privacy, consent, and retention

Voiceprints should be treated as sensitive identity data.

Production requirements:

- explicit consent before creating a user’s voiceprint;
- visible explanation of purpose: meeting speaker identification;
- ability to disable/delete a voiceprint;
- no long-term raw sample retention by default;
- audit log for create/disable/delete/use events;
- offboarding flow disables or deletes voiceprints according to company policy;
- admin-only voiceprint management.

The spike may use manual samples, but it should not be presented as production-ready until these controls exist.

## Error handling

- If pyannoteAI identification fails, keep the transcription result and mark speaker identity unavailable.
- If transcription fails but identification succeeds, store diagnostics and mark processing failed/incomplete.
- If merge confidence is low, keep generic speakers and require review.
- If no active voiceprints exist for participants, skip identification and show generic speaker review.
- If a voiceprint creation fails, do not store partial active voiceprint records.
- Provider errors should not leak API keys, raw audio paths, or sensitive sample details in logs.

## Cost controls

- Log provider, duration, voiceprint count, and estimated cost per job.
- Do not run voiceprint identification for recordings below a minimum useful duration unless manually requested.
- Limit candidate voiceprints to expected meeting participants.
- Avoid automatic retries that double cost unless they are bounded and justified.
- For spikes, use 10-minute clips before full 1.5-hour recordings.

## Evaluation spike

Before product refactor, run a controlled spike using known meeting audio and known voiceprints.

Inputs:

- IAS Sync full audio and/or 10-minute clip.
- 20-30 second voice samples for Joseph, David, Benjamin, and Jose/DV/DF as available.
- Current AssemblyAI Notetaker output as baseline.
- Teams transcript may be used only as ground-truth reference, not as product dependency.

Outputs:

- pyannote identity segments JSON;
- transcription segments JSON;
- merged named transcript JSON;
- metrics report;
- cost/latency report;
- recommendation for transcription provider.

Metrics:

- speaker segment accuracy;
- false positive count and duration;
- non-attendee detection behavior;
- percentage of segments confidently named;
- percentage of segments requiring review;
- timestamp merge quality;
- action-owner accuracy on extracted tasks;
- cost per meeting hour;
- latency per meeting hour.

Spike acceptance criteria:

- Most meaningful speech from known speakers is correctly identified.
- False positives are either suppressed or clearly marked uncertain.
- Non-attendee detections are not confidently displayed without strong evidence.
- The merged transcript is readable enough for summaries/action items.
- Review is needed only for genuinely uncertain cases, not every speaker in every meeting.
- Cost and latency are acceptable for normal Factor1 meeting volume.

## Phased rollout

### Phase 0: Experiment-only spike

- Build a standalone experiment script under `experiments/pyannote_voiceprint_identification/`.
- Do not change production pipeline.
- Use sample audio and voiceprints.
- Produce metrics and merged transcript.

### Phase 1: Backend prototype

- Add pyannoteAI client/service with test doubles.
- Add transcript merger with unit tests.
- Add voiceprint creation utility or admin-only script.
- Store pyannote mappings into existing `SpeakerMapping` structures.
- Keep AssemblyAI path available during comparison.

### Phase 2: Product integration

- Add voiceprint management table.
- Add admin/manual voiceprint creation flow.
- Add meeting processing branch using pyannote voiceprint identification.
- Show pyannote confidence/reasons in review UI.
- Keep all manual correction preservation behavior.

### Phase 3: Replace old speaker identity path

- Stop treating AssemblyAI speaker identification as canonical.
- Use pyannote voiceprint identification as canonical speaker identity.
- Keep the chosen transcription provider for words.
- Remove or downgrade old Teams-first docs/UI copy.

### Phase 4: Production hardening

- Add self-service consent/onboarding.
- Add deletion/disable/offboarding controls.
- Add audit logs.
- Add cost dashboards/alerts.
- Add retry and provider-failure monitoring.

## Risks and mitigations

### False positives

Risk: pyannote identifies a person who was not in the meeting.

Mitigation:

- limit candidate voiceprints to attendees;
- stricter thresholds for non-attendees;
- suppress short isolated detections;
- show review warnings.

### Bad diarization remains bad identity

Risk: if speakers are badly separated, identity assignment may still be wrong.

Mitigation:

- use confidence and overlap thresholds;
- preserve review UI;
- do not auto-confirm weak matches;
- improve audio capture later if needed.

### Timestamp drift

Risk: transcription timestamps and speaker identity timestamps do not align.

Mitigation:

- use the same normalized audio for both jobs;
- retain absolute offsets for chunks;
- use overlap-based merge with tolerances;
- measure merge quality during spike.

### Voiceprint privacy

Risk: voiceprints introduce biometric-like data concerns.

Mitigation:

- explicit consent;
- no raw sample retention by default;
- disable/delete controls;
- audit logs;
- admin-only management.

### Provider cost

Risk: multiple providers increase cost.

Mitigation:

- choose one transcription provider after spike;
- limit voiceprint candidates;
- log costs;
- run identification only when useful.

## Open implementation choices to resolve in the spike

1. Which transcription provider gives the best timestamped words for merging?
2. Does pyannoteAI STT orchestration remove the need for a separate transcription provider?
3. What confidence thresholds suppress David-style false positives without hiding true speakers?
4. How many candidate voiceprints can be sent before false positives become common?
5. Are segment-level timestamps enough, or do we need word-level timestamps for acceptable merge quality?
6. How much local UI/DB refactor is required to support voiceprint management cleanly?

## Success definition

The design succeeds when Notetaker can process a local/system-audio meeting recording and produce a named transcript for known Factor1 speakers without depending on Teams transcripts. The output must include confidence and review states so users can trust, correct, or reject speaker names before relying on summaries and action ownership.
