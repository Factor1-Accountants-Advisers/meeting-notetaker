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
- persistent MSAL token cache so users do not need to sign in before every meeting;
- longer or duration-based Pyannote timeout;
- OpenAI transcript chunking;
- structured OpenAI output for summary/decisions/action items/follow-ups;
- final reduce/consolidation pass;
- retry/failure metadata;
- cost/latency instrumentation.

### Resolved scope decisions from Joseph on 2026-07-01

1. **Meeting review/detail UI**
   - Decision: remove the restored review/search-to-detail path for Slice 1 production handoff.
   - Reason: Jira explicitly says the full meeting detail page, transcript/summary/waveform, action items view, dashboard meeting list, and past-meetings navigation are absent in Slice 1.
   - Replacement: users receive transcript/action output via email and SharePoint; the UI shows processing/delivery status only.

2. **Voiceprint enrollment**
   - Decision: keep the Joseph product direction as an approved Slice 1 override after OpenAI/Pyannote optimization.
   - Required behavior: after sign-in, the app checks the central voiceprint database/registry for the signed-in user. If no registered voiceprint exists, the user must enroll before using the app.
   - Implementation order: do not block the current optimization work on this; first optimize OpenAI and Pyannote API calls, then complete the required-enrollment gate against the central registry.

3. **SharePoint transcript storage**
   - Decision: Slice 1 will use the shared SharePoint folder for transcriptions.
   - Target folder URL: `https://futurebusinessgroup.sharepoint.com/sites/InnovationsandSystems/Transcriptions/Forms/AllItems.aspx`
   - Current access finding: the desktop app currently requests only `User.Read`, `Calendars.Read`, and `Mail.Send`. It does not request SharePoint/Files/Sites scopes yet, and the current local MSAL cache is empty after restart. Therefore live write access is not yet proven. Add SharePoint scopes and run an interactive delegated smoke test before claiming this is working.

4. **Pyannote chunking**
   - Decision: ship full-audio Pyannote plus OpenAI chunking first.
   - Pyannote audio chunking is a fallback spike only if long-meeting tests fail on timeout, latency, cost, or reliability.

5. **Long-meeting SLA**
   - Decision: use these target SLAs for planning and verification:
     - 20 min meeting: under 5 minutes after meeting end;
     - 1 hour meeting: under 10-15 minutes after meeting end;
     - 3 hour meeting: under 30-45 minutes after meeting end.

6. **Calendar auth persistence**
   - Decision: users should sign in once, not before every meeting.
   - Add a persistent MSAL token cache owned by the Electron main process, stored under Electron `userData` and protected on Windows where possible.
   - On app startup/background launch, restore the cached MSAL account, acquire Graph tokens silently, run an immediate calendar sync, then start polling.
   - Only prompt for sign-in when there is no cached account, the user signs out, consent is missing, admin revokes access, or MSAL returns `interaction_required`.
   - The renderer must not store Graph tokens, refresh tokens, or MSAL cache data.

## 3. Target Slice 1 pipeline

### Calendar polling and sign-in baseline

The app should keep calendar detection alive in the Electron main process while the tray app is running.

Current/recommended polling behavior:

- immediate sync on app ready/startup;
- immediate sync after successful MSAL sign-in;
- immediate sync on resume/unlock/network recovery with debounce/jitter;
- normal polling every 5 minutes;
- 24-hour lookahead window for MVP;
- no tight Graph polling near meeting start; use local timers from the last synced event set;
- auto-start eligibility only inside the 3-minute start window;
- respect Graph `Retry-After` on 429 and pause/back off on repeated failures;
- pause polling and show a sign-in-required state when silent token acquisition fails.

Implementation hardening required:

1. Add a persistent MSAL cache plugin/storage layer for `@azure/msal-node`.
2. Restore the first cached account on app startup before the first Graph sync.
3. Keep the cache in Electron main process only.
4. Store cache material under `app.getPath('userData')`; prefer Windows-protected storage/DPAPI or Electron `safeStorage` when available.
5. Add a restart smoke test: sign in once, quit app, relaunch, verify Graph token acquisition and `/me/calendarView` sync happen silently without browser sign-in.

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

### Pyannote full-audio vs audio chunking tradeoff

For Slice 1, use full-audio Pyannote first. The tradeoffs are:

| Dimension | Full-audio Pyannote | Chunked Pyannote audio |
|---|---|---|
| Diarization quality | Usually better because the model sees the whole meeting and can form global speaker clusters. | Riskier because each chunk reclusters speakers independently; `SPEAKER_00` can mean different people in different chunks. |
| Speaker identification | Simpler: one identify job over the whole meeting, one set of identity ranges. | More complex: identify per chunk or reconcile chunk labels after the fact; confidence/evidence stitching is required. |
| Speed | One long provider job; may be slower wall-clock if provider processing is not internally parallelized. | Potentially faster wall-clock because chunks could run in parallel, if Pyannote rate limits and queueing allow it. |
| Cost | Typically simpler and likely cheaper or equal because there are fewer jobs and less duplicated overlap audio. Exact pricing must be confirmed against the account plan. | Potentially more expensive due to multiple jobs, repeated upload overhead, overlap audio, and possible retries/reconciliation. |
| Reliability | One job can timeout/fail for very long meetings; duration-aware timeout mitigates this. | One failed chunk can be retried, but stitching errors become a new failure mode. |
| Implementation risk | Lower. Aligns directly with Jira's confidence-per-segment requirement. | Higher. Requires absolute timestamp stitching, overlap dedupe, cross-chunk speaker reconciliation, and stricter QA. |

Decision: ship full-audio Pyannote + OpenAI transcript chunking first. Only run a Pyannote chunking spike if long-meeting tests fail the agreed SLAs or provider timeouts.

If adopted later, the spike must test:

1. 20 minute David/Joseph call;
2. synthetic 60 minute concatenated audio;
3. 2-3 hour generated or stitched test recording if available.

Compare full-audio vs 15 minute chunks with 30-60 second overlap for:

- transcription completeness;
- diarization speaker consistency;
- known-speaker identification confidence;
- cost;
- latency;
- retry behavior;
- stitching quality.

If chunking is adopted later:

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

## 9. Resolved Joseph answers

1. Remove the meeting review/search path from Slice 1 UI.
2. Accept required signed-in-user voiceprint enrollment as a Joseph-approved override, but implement it after OpenAI/Pyannote optimization.
3. Use the shared SharePoint folder for transcript storage: `https://futurebusinessgroup.sharepoint.com/sites/InnovationsandSystems/Transcriptions/Forms/AllItems.aspx`. Access still needs an app smoke test with SharePoint scopes.
4. Use these SLA targets:
   - 20 min meeting: under 5 min after meeting end;
   - 1 hour meeting: under 10-15 min after meeting end;
   - 3 hour meeting: under 30-45 min after meeting end.
5. Ship full-audio Pyannote + OpenAI chunking first. Only spike Pyannote audio chunking if long-meeting tests fail.

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
