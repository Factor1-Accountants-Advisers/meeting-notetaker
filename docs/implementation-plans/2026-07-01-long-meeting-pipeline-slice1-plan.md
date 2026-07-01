# Notetaker Slice 1 long-meeting pipeline plan

Date: 2026-07-01
Owner: Joseph Guerrero
Repo: `/home/josephmiguelguerrero/projects/meeting-notetaker-2`
Jira source checked: `/mnt/c/Users/JosephMiguelGuerrero/Downloads/IN-64_Export_28-06-2026.xlsx`
Supporting source checked: `/mnt/c/Users/JosephMiguelGuerrero/Downloads/notetaker-scoping-document.md`

## 1. Purpose

Prepare Slice 1 Notetaker for realistic long meetings: 20 minutes, 1 hour, 2 hours, and up to 3 hours.

The app must not look hung while processing. It must reliably produce:

- transcript text;
- diarized speaker turns;
- known-speaker labels from voiceprints where confidence is strong;
- Unknown speaker labels where confidence is weak;
- summary;
- decisions;
- action items;
- unresolved questions / follow-ups;
- email attachment delivery to the correct recipients.

Microsoft Teams transcript import is explicitly out of scope for this plan and must not be used for Slice 1.

## 2. Jira alignment check

### Slice 1 requirements that this plan must preserve

From `IN-64` export:

1. Auto-record hosted calendar meetings within ±3 minutes of start.
2. Skip and log when the signed-in user is not organiser.
3. Manual recording works for in-room/ad-hoc meetings.
4. Known speakers are identified by Pyannote voiceprint matching with confidence stored per transcript segment.
5. Auto-stop fires within 60 seconds of meeting end and upload begins automatically.
6. Per-meeting Record button is absent.
7. Action items view, full meeting detail page, transcript/summary/waveform page, and calendar meeting dashboard navigation are absent.
8. Settings → Audio Setup remains present and functional.
9. Calendar-linked upload metadata includes onlineMeetingId, joinWebUrl, and organiser email.
10. Unknown speakers are flagged in processing metadata for Slice 4 correction; no in-app speaker correction UI in Slice 1.
11. Transcripts are saved in a locked-down SharePoint folder for Slice 1.
12. Transcripts are emailed as a text attachment to all meeting invitees, or to the local user for manual/uploaded recordings.

### No-conflict additions in this plan

These are implementation details that support Slice 1 and do not change user-facing scope:

- backend processing stages;
- durable stage/progress state;
- longer or duration-based Pyannote timeout;
- OpenAI transcript chunking;
- structured OpenAI output for summary/decisions/action items/follow-ups;
- final reduce/consolidation pass;
- retry/failure metadata;
- cost/latency instrumentation.

### Potential conflicts to resolve

1. **Meeting review/detail UI**
   - Jira says the full meeting detail page, transcript/summary/waveform, action items view, and dashboard meeting list are absent in Slice 1.
   - Recent debug work reconnected search results to the review screen so Joseph could inspect a stuck meeting.
   - For Slice 1 handoff, this should either be reverted/hidden behind a dev-only flag, or explicitly accepted as a temporary debug affordance. Default recommendation: hide it for production Slice 1 and rely on email + SharePoint output + processing status.

2. **Self-service voiceprint enrollment**
   - Exported Slice 1 mentions admin CLI / initial voiceprint registration and voice samples available.
   - Earlier Joseph direction prefers required post-sign-in enrollment before app use.
   - If required enrollment remains in Slice 1, document it as a Joseph-approved product override because it overlaps the scoping document's Slice 2 self-service enrollment controls.

3. **SharePoint timing**
   - The latest IN-64 export includes locked-down SharePoint transcript saving in Slice 1.
   - Older scoping text puts SharePoint storage in Slice 3.
   - Jira export wins for current planning: include a minimal Slice 1 SharePoint transcript writer if credentials/permissions are available. If permissions are unavailable, email remains the primary delivery path and SharePoint is marked blocked with evidence.

4. **Pyannote chunking**
   - Jira requires Pyannote transcription + voiceprint identification with confidence per transcript segment.
   - Audio chunking may make speaker continuity and confidence harder. It should not replace the full-audio baseline until proven.
   - Recommendation: full-audio Pyannote is the Slice 1 default; Pyannote chunking is a spike/fallback only.

## 3. Target Slice 1 pipeline

### Current baseline

Current backend pipeline roughly does:

1. save audio;
2. mark queued/processing;
3. call Pyannote diarize with transcription;
4. call Pyannote identify against stored voiceprints;
5. merge identity ranges onto transcript segments by timestamp overlap;
6. call OpenAI once for summary;
7. call OpenAI once for action items;
8. mark ready;
9. frontend tries to email after polling detects ready.

Problems observed:

- frontend polling can go stale;
- backend status is too coarse;
- long meetings can exceed fixed timeouts or LLM context;
- summary/action item extraction is not chunked;
- email can fail/not trigger if frontend state gets stuck;
- no durable stage/progress for users;
- speaker identity confidence is not stored per segment yet;
- raw speaker labels and mapped speaker names are not first-class separate records.

### New target pipeline

1. Recording saved / uploaded
   - Persist mic/system/merged audio metadata.
   - Set `pipeline_status = processing` and `pipeline_stage = audio_uploaded`.
   - Persist duration, source, graph metadata, owner, recipients, and meeting type.

2. Pyannote transcription + diarization
   - Default: submit the full merged audio to Pyannote diarize with transcription.
   - Use duration-aware timeout.
   - Prefer webhook/status polling if available; polling remains acceptable locally.
   - Persist raw transcript segments with raw diarization speaker labels, timestamps, provider metadata, and turn confidence where returned.
   - Set stage `transcribing_diarizing`.

3. Pyannote voiceprint identification
   - Build voiceprint candidate set.
   - Candidate order:
     1. attendee voiceprints;
     2. organiser/recorder voiceprint;
     3. controlled expansion list for key internal people such as David/Benjamin if allowed by IN-79;
     4. optional wider staff expansion only if threshold rules permit.
   - Submit identify job against the same full meeting audio.
   - Persist identity ranges with label, person, confidence, start/end, provider job id.
   - Set stage `identifying_speakers`.

4. Speaker merge
   - Resolve transcript display speakers by timestamp overlap between transcript segments and identity ranges.
   - Store both raw and resolved forms:
     - raw diarization label, e.g. `SPEAKER_00`;
     - resolved display name, e.g. `Joseph Miguel Guerrero`;
     - speaker source: `pyannote_voiceprint`, `unknown`, later `user_corrected`;
     - confidence;
     - evidence range/job id.
   - If confidence/overlap is weak, keep `Unknown N`.
   - Set unknown speaker count for Slice 4 correction metadata.

5. OpenAI chunk extraction
   - Split transcript into 10-15 minute chunks by timestamp.
   - Preserve speaker labels and timestamps inside each chunk.
   - Add small overlap in transcript text only if needed for context, not for audio.
   - Run chunk jobs in parallel with bounded concurrency.
   - Each chunk returns strict structured JSON:
     - chunk summary bullets;
     - decisions;
     - action items;
     - unresolved questions;
     - follow-ups;
     - important dates/deadlines;
     - owner evidence;
     - confidence flags.
   - Set stage `extracting_chunk_insights`.

6. OpenAI reduce/consolidation
   - Merge all chunk outputs.
   - Deduplicate actions and decisions.
   - Resolve owners from speaker mappings and explicit name mentions.
   - Produce final summary, action list, decisions, and unresolved questions.
   - Keep source chunk/timestamp references for auditability.
   - Set stage `consolidating_notes`.

7. Delivery
   - Write transcript text attachment.
   - Send email through delegated Graph Mail.Send.
   - Calendar-linked recording: recipients are Graph attendees, deduped.
   - Manual/ad-hoc/upload: recipient is signed-in recorder email.
   - If SharePoint credentials/permissions are available, save transcript/summary to locked-down SharePoint folder.
   - Set stage `emailing`, then `ready` or `ready_email_failed` depending on delivery result.

8. User-visible completion
   - UI shows durable backend stage, not a frontend-only timer.
   - If email fails, meeting stays processed and shows retryable delivery failure.
   - Never leave indefinite spinner without backend evidence.

## 4. OpenAI long-transcript strategy

### Standard practice to use

Use a map-reduce pattern:

- map: process each 10-15 minute transcript chunk independently;
- reduce: consolidate the chunk outputs into final meeting notes.

Use OpenAI Structured Outputs with strict JSON schema so the app can reliably parse the response. Keep static schema and instructions stable across requests so prompt caching can apply where supported.

### Chunk schema

Each chunk extraction should return:

```json
{
  "chunk_index": 0,
  "time_range": { "start_ms": 0, "end_ms": 900000 },
  "summary_bullets": [],
  "decisions": [
    {
      "text": "",
      "made_by": null,
      "confidence": "high|medium|low",
      "evidence": [{ "speaker": "", "start_ms": 0, "quote": "" }]
    }
  ],
  "action_items": [
    {
      "description": "",
      "owner_name": null,
      "owner_email": null,
      "owner_confidence": "high|medium|low|unknown",
      "due_date": null,
      "priority": "high|medium|low",
      "evidence": [{ "speaker": "", "start_ms": 0, "quote": "" }]
    }
  ],
  "unresolved_questions": [],
  "follow_ups": [],
  "quality_flags": []
}
```

### Reduce schema

Final reduce should return:

```json
{
  "summary": "",
  "key_points": [],
  "decisions": [],
  "action_items": [],
  "unresolved_questions": [],
  "follow_ups": [],
  "quality_flags": [],
  "source_chunks": []
}
```

### Cost and speed strategy

- Use one structured call per chunk, not separate summary/action calls.
- Run chunks in parallel with bounded concurrency, e.g. 3-5 concurrent calls.
- Use a cheaper model for chunk extraction if quality is acceptable.
- Use a stronger model for final reduce only if needed.
- Store chunk outputs so retries do not rerun completed chunks.
- Avoid sending full transcript to final reduce; send compact chunk JSON only.

## 5. Pyannote long-audio strategy

### Default for Slice 1

Use one full-audio Pyannote diarize+transcription job and one full-audio Pyannote identify job.

Reasons:

- better global speaker clustering;
- simpler timestamp alignment;
- no cross-chunk speaker-label reconciliation problem;
- less risk of `SPEAKER_00` meaning different people in different chunks;
- aligns more directly with Jira's requirement for confidence per transcript segment.

### Timeout changes

Replace fixed 30-minute timeout with duration-aware timeout.

Proposed rule:

- minimum timeout: 30 minutes;
- timeout = max(30 minutes, recording_duration_minutes * 3 minutes);
- cap: 2 hours for local dev unless configured higher.

Examples:

- 20 minute recording → 60 minute timeout;
- 60 minute recording → 180 minute calculated, but cap applies depending environment;
- production can set cap higher if Pyannote SLA requires it.

This should be configured by environment, not hardcoded.

### Pyannote chunking spike only

Run a small spike before implementing audio chunking. Test with known recordings:

1. 20 minute David/Joseph call;
2. synthetic 60 minute concatenated audio;
3. 2-3 hour generated or stitched test recording if available.

Compare:

- full-audio Pyannote result;
- 15 minute audio chunks with 30-60 sec overlap;
- chunk stitching quality;
- speaker consistency across chunks;
- known-speaker identification confidence;
- cost;
- latency;
- retry behavior.

Only adopt Pyannote chunking if it clearly improves reliability or latency without degrading speaker identity.

If adopted later:

- preserve absolute timestamps;
- overlap chunks;
- discard duplicate overlap transcript turns;
- do not trust raw speaker labels across chunks;
- use voiceprint identity, confidence, and timestamp evidence to reconcile speakers;
- keep uncertain segments Unknown.

## 6. Backend data model additions

Add fields to meeting/pipeline state:

- `pipeline_status`: existing terminal/coarse status;
- `pipeline_stage`: current detailed stage;
- `pipeline_stage_message`: user-safe stage copy;
- `pipeline_started_at`;
- `pipeline_updated_at`;
- `pipeline_completed_at`;
- `processing_error_code`;
- `processing_error_message`;
- `processing_attempt`;
- `duration_seconds`;
- `delivery_status`: `not_started | emailing | emailed | failed`;
- `delivery_error_message`.

Add persisted processing artifacts:

- raw transcript segments;
- resolved transcript segments;
- speaker identity ranges;
- chunk extraction outputs;
- final consolidated notes;
- delivery/audit records.

## 7. Frontend behavior

Slice 1 frontend should show status, not meeting detail.

Recommended production UI:

- Home shows recording/new meeting card.
- A compact status banner appears after upload/auto-stop:
  - `Uploading recording...`
  - `Transcribing and diarizing...`
  - `Identifying speakers...`
  - `Extracting notes...`
  - `Emailing transcript...`
  - `Transcript emailed to ...`
  - `Email failed — retry`.
- Search/detail review screen should be disabled in production unless explicitly approved as a debug-only affordance.
- Add `Refresh status` only if it stays compact; otherwise polling should keep status current automatically.

## 8. Implementation phases

### Phase 0 — Clean up Jira conflicts before handoff

Deliverables:

- Decide whether the recently restored review/search path is dev-only or removed.
- Confirm whether required self-service voiceprint enrollment is Slice 1 override or future Slice 2.
- Update docs to reflect Jira export precedence.

Verification:

- `npm run typecheck`;
- `npm run build`;
- review UI/navigation against IN-64 acceptance criteria.

### Phase 1 — Durable pipeline stage model

Files likely touched:

- `backend/app/schemas.py`
- `backend/app/store.py`
- `backend/app/services/pipeline.py`
- `backend/app/routers/meetings.py`
- `src/renderer/src/lib/api.ts`
- `src/renderer/src/App.tsx`
- `src/renderer/src/screens/HomeScreen.tsx`

Tasks:

1. Add pipeline stage/status fields.
2. Update pipeline at every stage.
3. Persist status on every stage transition.
4. Expose status via list/review/current-status endpoint.
5. Update Home status banner to use backend status.
6. Add retryable email failure state.

Verification:

- backend compile;
- frontend typecheck/build;
- create/upload smoke confirms stage transitions;
- stuck frontend cannot leave a false spinner after backend ready.

### Phase 2 — Duration-aware Pyannote timeout and instrumentation

Files likely touched:

- `backend/app/config.py`
- `backend/app/services/speech.py`
- `backend/app/services/speaker_matching.py`
- `backend/app/services/pyannote_client.py`
- `backend/app/services/pipeline.py`

Tasks:

1. Add timeout config.
2. Calculate timeout from meeting duration.
3. Log Pyannote job ids, start/end, elapsed time, segment count.
4. Store provider diagnostics without secrets.
5. Keep full-audio Pyannote as baseline.

Verification:

- unit/fake-provider timeout tests;
- real short recording smoke;
- no secrets in logs.

### Phase 3 — OpenAI structured chunk extraction

Files likely touched:

- `backend/app/services/llm.py`
- new `backend/app/services/transcript_chunks.py`
- new `backend/app/services/meeting_insights.py`
- `backend/app/schemas.py`
- `backend/app/services/pipeline.py`

Tasks:

1. Split transcript by 10-15 minute windows.
2. Define strict structured output schemas.
3. Implement chunk extraction provider.
4. Run chunks with bounded concurrency.
5. Store chunk outputs.
6. Implement final reduce/consolidation.
7. Replace separate summary/action calls with one chunk+reduce flow.

Verification:

- deterministic unit tests for chunk boundaries;
- fake LLM provider tests for chunk/reduce;
- long synthetic transcript test;
- real David call reprocess test;
- compare action items and summary quality.

### Phase 4 — Speaker identity evidence model

Files likely touched:

- `backend/app/schemas.py`
- `backend/app/services/speaker_matching.py`
- `backend/app/services/pipeline.py`
- `backend/app/store.py`

Tasks:

1. Preserve raw diarization labels.
2. Store identity ranges.
3. Store confidence/source per resolved segment.
4. Implement attendee-first candidate pool.
5. Implement controlled expansion.
6. Enforce false-positive suppression.
7. Keep Unknown for low confidence.

Verification:

- no voiceprints → all Unknown;
- Joseph voiceprint only → only Joseph-labelled ranges resolve;
- non-attendee false positive below threshold stays Unknown;
- unknown speaker count is correct.

### Phase 5 — Delivery reliability: email + SharePoint

Files likely touched:

- `backend/app/routers/meetings.py`
- `backend/app/services/email.py`
- new `backend/app/services/sharepoint.py`
- `src/main/api-proxy.ts`
- `src/renderer/src/App.tsx`

Tasks:

1. Make email delivery backend-triggered or backend-resumable, not dependent only on frontend polling.
2. Preserve Graph delegated token boundary.
3. Store delivery status and error.
4. Add retry path when Outlook token is refreshed.
5. Add minimal SharePoint transcript writer if credentials are available.
6. Attach summary/action items/transcript in one text file.

Verification:

- no Graph token → clear 401/retry state, no fake success;
- Graph token → email sent and audit logged;
- manual recording recipient = recorder;
- calendar recording recipients = attendees;
- SharePoint unavailable → email still works and SharePoint status is blocked/failed with safe error.

### Phase 6 — Long-meeting verification pack

Test set:

1. 2-3 minute smoke recording;
2. 20 minute David/Joseph recording;
3. 60 minute synthetic transcript through OpenAI chunking;
4. 2-3 hour synthetic transcript through OpenAI chunking;
5. real or stitched long audio through Pyannote if credits allow.

Evidence to collect:

- processing stage timeline;
- Pyannote elapsed time;
- OpenAI chunk count/concurrency elapsed time;
- token/cost estimate;
- transcript segment count;
- known/unknown speaker counts;
- email delivery timestamp;
- failure/retry behavior.

## 9. Questions for Joseph

1. Should the recently restored review/search path be removed or hidden behind a dev-only flag for Slice 1 handoff?

2. Should required post-sign-in self-service voiceprint enrollment remain in Slice 1 as a Joseph override, or should Slice 1 use admin/seeded voiceprints only and leave self-service enrollment to Slice 2?

3. For SharePoint in Slice 1: do we already have the target folder/library and Graph write permission, or should this plan mark SharePoint transcript save as blocked until IT grants access?

4. For long meetings, what is the acceptable completion SLA after meeting end?
   - 20 min meeting: target under 5 min?
   - 1 hour meeting: target under 10-15 min?
   - 3 hour meeting: target under 30-45 min?

5. For Pyannote chunking, do we want a spike now, or should we first ship full-audio Pyannote + OpenAI chunking and only spike chunked audio if long-meeting tests fail?

## 10. Recommendation

Proceed with:

1. backend stage model;
2. OpenAI chunked structured extraction;
3. duration-aware Pyannote timeout;
4. speaker identity evidence model;
5. reliable email/SharePoint delivery;
6. long-meeting verification pack.

Do not make Pyannote audio chunking the default yet. Treat it as a measured spike after the full-audio baseline is tested on long recordings.

Do not use Microsoft Teams transcript import in Slice 1.
