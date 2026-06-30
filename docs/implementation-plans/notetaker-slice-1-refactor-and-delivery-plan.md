# Notetaker Slice 1 refactor and delivery plan

Date: 2026-06-25
Owner: Joseph Guerrero
Project: The Notetaker
Jira parent scope: `IN-50` / `IN-64` — Slice 1: Auto-Triggered Recording, Pyannote Speaker ID, and UI Modernisation

## 1. Purpose

This plan defines how we will refactor and implement Notetaker Slice 1 without turning the work into a risky big-bang rewrite.

The target is a SOTA, production-ready internal notetaker that:

- records online and in-person meetings reliably;
- detects eligible meetings from Microsoft Graph;
- auto-records only when the signed-in user is the organiser;
- keeps manual recording available for in-room and ad-hoc use;
- uses PyannoteAI for transcription and voiceprint speaker identification;
- keeps unknown speakers unknown when confidence is weak;
- sends reviewed transcripts by Outlook email where required;
- remains secure, auditable, and aligned with Factor1 Azure-only requirements.

The implementation strategy is:

1. create a small safe foundation refactor;
2. add observability before automation;
3. complete the Graph detection spike;
4. implement detection, gating, and recording as vertical slices;
5. implement the backend speech/voiceprint pipeline behind provider interfaces;
6. finish delivery UX, email, and packaging after the open DV/installer decisions are resolved.

## 2. Source inputs

### Requirements and repo documents

- `AGENTS.md`
- `docs/requirements.md`
- `docs/azure-setup.md`
- `docs/design-handoff.md`

### Jira CSV

Source CSV used for this plan:

- `C:\Users\JosephMiguelGuerrero\Downloads\Jira.csv`
- WSL path: `/mnt/c/Users/JosephMiguelGuerrero/Downloads/Jira.csv`

Relevant Jira parent:

| Key | Type | Status | Summary |
|---|---|---|---|
| `IN-64` | Story | Scoped | Slice 1 — Auto-Triggered Recording, Pyannote Speaker ID, and UI Modernisation |

### Current repo state inspected

Repo:

- `/home/josephmiguelguerrero/projects/meeting-notetaker-2`

Current branch state at planning time:

- branch: `main`
- remote: `https://github.com/gerdguerrero/meeting-notetaker-2.git`

Current stack:

- Electron + React + Vite + TypeScript desktop client
- FastAPI backend
- local stub providers for storage, speech, LLM, email, and data persistence
- Azure provider seams planned but not fully implemented

## 3. Locked architecture rules

These rules are non-negotiable unless David/Gerd explicitly change the requirements.

1. The renderer must not call Azure, Microsoft Graph, the database, or any external service directly.
2. Renderer traffic goes through preload IPC into the Electron main process, then to FastAPI.
3. The backend is the only component that touches data stores and provider secrets.
4. Desktop must not ship client secrets, Azure OpenAI keys, Speech keys, Graph secrets, database credentials, SAS URLs, voiceprint keys, or Hugging Face tokens.
5. Jira CSV is authoritative over `docs/requirements.md` for Slice 1 scope/provider choices.
6. PyannoteAI owns transcription and voiceprint speaker identification per Jira IN-64/IN-69.
7. Unknown speaker is safer than an incorrect speaker name.
8. Email distribution happens only after review/finalisation unless the product requirement changes.
9. Every mutating backend operation must remain audit logged.
10. Manual recording must continue to work even after auto-recording is added.

## 4. Jira scope map

### Joseph-assigned implementation items

| Key | Status | Summary | Primary area |
|---|---:|---|---|
| `IN-65` | Draft | Spike: MS Graph meeting detection — subscription vs. polling | Graph spike |
| `IN-68` | Estimated | Implement MS Graph meeting detection in Electron main process | Graph detection |
| `IN-67` | Estimated | Implement host-only recording gate for auto-triggered meetings | Scheduler/gating |
| `IN-66` | Estimated | Wire auto-start and auto-stop recording to Graph meeting events | Recording automation |
| `IN-71` | Estimated | Configure app to run at Windows startup and persist in system tray | Tray/startup |
| `IN-77` | Estimated | UI updates: auto-recording status alongside manual recording | Recording/status UI |
| `IN-69` | Estimated | Wire Pyannote transcription and voiceprint identification into production pipeline | Backend speech/voiceprint pipeline |
| `IN-76` | Estimated | Admin voiceprint upload and registration utility | Voiceprint enrollment |
| `IN-78` | Estimated | Implement attendee-first voiceprint candidate selection | Speaker matching |
| `IN-79` | Estimated | Implement voiceprint candidate expansion rules for key uninvited people | Speaker matching |
| `IN-80` | Estimated | Check: false-positive suppression for non-attendee detections | Speaker matching safety |
| `IN-93` | Planned | Implement MS outlook emailing of Transcript | Graph email |
| `IN-72` | Estimated | UI cleanup: remove per-calendar-meeting Record button | UI cleanup |
| `IN-74` | Estimated | UI cleanup: remove full meeting detail page | UI cleanup |
| `IN-75` | Estimated | UI cleanup: remove action items view and aggregated action items page | UI cleanup |
| `IN-81` | Draft | Packaging, signing, and installer update | Packaging/release |

### Defined test items

| Key | Status | Summary | Validates |
|---|---:|---|---|
| `IN-83` | Defined | Auto-recording starts for meeting organiser | Graph + host gate + auto-start |
| `IN-84` | Defined | Auto-recording is suppressed for non-organiser | host-only gate |
| `IN-85` | Defined | Manual recording still works for in-room/ad-hoc use | regression safety |
| `IN-86` | Defined | Known speaker identified by voiceprint with high confidence | voiceprint matching |
| `IN-87` | Defined | Unregistered speaker stored as anonymous in output | false-positive safety |
| `IN-88` | Defined | Per-meeting calendar Record button absent; manual controls and audio setup present | UI cleanup + manual control preservation |
| `IN-94` | Defined | When a transcript is saved it is sent via email attachment to the correct persons | Graph email |

## 5. Current architecture summary

### Electron main process

Current file:

- `src/main/index.ts`

Current responsibilities:

- window creation;
- API proxy from renderer to FastAPI;
- current stub user / actor header;
- recording save to disk;
- update checks;
- WASAPI loopback media permission handler;
- app lifecycle.

This is acceptable for a prototype, but it should be split before adding Graph, tray, startup, and scheduler logic.

### Renderer

Important files:

- `src/renderer/src/App.tsx`
- `src/renderer/src/lib/api.ts`
- `src/renderer/src/lib/capture.ts`
- `src/renderer/src/lib/recorder.ts`
- `src/renderer/src/screens/RecordingScreen.tsx`
- `src/renderer/src/screens/MeetingReviewScreen.tsx`
- `src/renderer/src/screens/HomeScreen.tsx`
- `src/renderer/src/screens/MeetingsScreen.tsx`
- `src/renderer/src/screens/ActionItemsScreen.tsx`
- `src/renderer/src/screens/PeopleScreen.tsx`
- `src/renderer/src/screens/SettingsScreen.tsx`

Current recording model:

- `src/renderer/src/lib/capture.ts` owns browser `MediaRecorder` capture;
- it mixes microphone plus WASAPI loopback returned by Electron main;
- it is a singleton so capture survives navigation;
- manual recording currently depends on this flow.

This file is platform-sensitive and should be changed only when necessary.

### Backend

Important files:

- `backend/app/main.py`
- `backend/app/config.py`
- `backend/app/schemas.py`
- `backend/app/access.py`
- `backend/app/store.py`
- `backend/app/routers/meetings.py`
- `backend/app/routers/action_items.py`
- `backend/app/routers/people.py`
- `backend/app/services/pipeline.py`
- `backend/app/services/speech.py`
- `backend/app/services/llm.py`
- `backend/app/services/email.py`
- `backend/app/services/retention.py`

Current backend model:

- JSON/in-memory store stands in for PostgreSQL;
- local audio folder stands in for Blob Storage;
- stub speech provider stands in for PyannoteAI transcription/speaker ID;
- stub LLM provider stands in for Azure OpenAI;
- stub email provider stands in for Graph email;
- pipeline stages are currently simulated.

## 6. Target architecture after Slice 1

### Main process module boundaries

Refactor `src/main/index.ts` into small modules:

- `src/main/window.ts`
  - creates/shows/hides windows;
  - handles second-instance behaviour;
  - later integrates with tray open/focus.

- `src/main/api-proxy.ts`
  - owns calls to FastAPI;
  - attaches actor/auth headers;
  - later attaches Entra tokens if required.

- `src/main/auth-session.ts`
  - owns current user/session state;
  - starts as compatibility wrapper around current stub user;
  - later becomes MSAL/Entra session owner.

- `src/main/media-permissions.ts`
  - owns WASAPI loopback display media handler.

- `src/main/recording-storage.ts`
  - owns temporary recording persistence;
  - keeps dev/prod path logic isolated.

- `src/main/updater.ts`
  - owns electron-updater checks.

- `src/main/logger.ts`
  - persistent structured logs;
  - no tokens/secrets/raw embeddings/SAS URLs.

- `src/main/tray.ts`
  - tray icon, menu, status, quiet startup.

- `src/main/graph/*`
  - Graph client, polling/delta sync, normalisation, filtering.

- `src/main/scheduler/*`
  - meeting scheduler, host gate, idempotency, recording trigger decisions.

### Recording automation boundary

Recommended design:

- Main process owns Graph polling and scheduler decisions.
- Renderer keeps actual MediaRecorder capture because it has browser media APIs.
- Main process sends IPC commands:
  - `recording:auto-start`
  - `recording:auto-stop`
- Renderer reports results:
  - `recording:started`
  - `recording:failed`
  - `recording:stopped`
  - `recording:uploaded`

State machine:

- `idle`
- `manual_recording`
- `auto_pending`
- `auto_recording`
- `stopping`
- `uploading`
- `processing`
- `failed`

Conflict rules:

- only one active capture at a time;
- manual recording wins over auto-recording;
- auto-recording never interrupts manual recording;
- event ID / occurrence start is used for idempotency;
- duplicate timers must not start duplicate recordings;
- stop is idempotent.

### Backend provider boundaries

Backend pipeline should move toward:

- `backend/app/services/storage.py`
  - local file stand-in now;
  - Azure Blob later.

- `backend/app/services/speech.py`
  - `SpeechProvider` protocol;
  - PyannoteAI transcription/speaker-label provider.

- `backend/app/services/speaker_embeddings.py`
  - pyannote embedding extractor.

- `backend/app/services/voiceprints.py`
  - voiceprint repository/enrollment abstraction.

- `backend/app/services/speaker_matching.py`
  - attendee-first matching;
  - candidate expansion;
  - threshold/margin rules;
  - false-positive suppression.

- `backend/app/services/pipeline.py`
  - orchestration only.

- `backend/app/services/diagnostics.py`
  - matching confidence, threshold version, raw label provenance, review-needed metadata.

## 7. Research-backed technical decisions

### Graph meeting detection

For the MVP, use delegated Microsoft Graph polling/delta polling from the Electron main process, not direct Graph webhooks.

Reason:

- Graph change notifications are recommended for server-side near-real-time sync, but they require a public HTTPS webhook endpoint.
- A local Electron app cannot reliably receive Graph webhook callbacks without a backend relay.
- A polling/delta approach is easier to debug, aligns with a desktop recorder, and avoids infrastructure dependencies.

Recommended endpoint pattern:

- use `/me/calendarView` or `/me/calendarView/delta`;
- use a rolling near-future window;
- persist `@odata.deltaLink` where practical;
- recompute schedule on startup, resume, unlock, reconnect, and token refresh.

Filter events client-side:

Include likely recordable meetings:

- `isOnlineMeeting === true`;
- `onlineMeeting.joinUrl` present;
- Teams provider if Teams-only behaviour is required;
- event start/end inside scheduler window;
- signed-in user has not declined;
- `isCancelled === false`;
- `isAllDay === false`.

Usually exclude:

- `showAs === "free"` unless user opts in;
- tentative meetings unless product requires aggressive recording;
- private meetings unless approved;
- meetings already recorded/handled.

Host gate:

- primary signal: `event.isOrganizer === true`;
- do not infer host from title/body/join URL;
- document caveat around delegated organiser/co-organiser semantics.

Timezone rules:

- store scheduler instants in UTC;
- request or normalise a consistent timezone;
- do not manually add offsets;
- re-evaluate events after delta changes and resume from sleep.

Throttling:

- no tight polling loops;
- respect `429` and `Retry-After`;
- exponential backoff with jitter if no retry header;
- use delta queries where possible.

### PyannoteAI

Per Jira IN-64/IN-69, PyannoteAI owns:

- transcription;
- speaker labels / diarization where available;
- voiceprint speaker identification;
- embedding extraction;
pyannote:

- embedding / voiceprint matching only;
- do not treat it as the primary transcription source;
- select clean representative audio snippets from Azure diarized speaker clusters;
- avoid overlapped/crosstalk snippets where possible;
- normalise to mono 16 kHz where required;
- compare with enrolled staff embeddings using cosine similarity/distance;
- require threshold and margin before naming a speaker;
- keep unknown when confidence is weak.

Voiceprints:

- treat as sensitive biometric templates;
- explicit consent / firm onboarding required;
- delete enrollment audio immediately after embedding extraction;
- store model version and re-enrollment status;
- encrypt at rest and protect keys through Key Vault;
- never log embeddings, raw clips, SAS URLs, or secrets.

## 8. Phase plan

### Phase 0 — Baseline and evidence setup

Purpose:

- Establish current behaviour before refactor.

Tasks:

- run desktop checks:
  - `npm run typecheck`
  - `npm run build`
- run backend health/API smoke check;
- record current manual workflow:
  - create meeting;
  - manual record/upload;
  - stub pipeline completes;
  - review/finalise;
  - email stub path;
- create/update Jira-to-code map.

Deliverables:

- baseline verification note;
- Jira implementation map;
- risk register.

Exit criteria:

- current app behaviour is known;
- no implementation work starts from an unknown baseline.

### Phase 1 — Main-process foundation refactor

Purpose:

- Create safe boundaries before Graph, scheduler, tray, and startup work.

Tasks:

- split `src/main/index.ts` into modules listed in section 6;
- preserve IPC channel names;
- preserve current renderer API;
- preserve manual recording save;
- preserve backend proxy behaviour.

Deliverables:

- main-process modules with no intentional product behaviour change.

Verification:

- `npm run typecheck`;
- `npm run build`;
- app launches;
- manual recording still works;
- backend proxy still works.

### Phase 2 — Persistent logging and diagnostics

Purpose:

- Make auto-recording and Graph decisions debuggable before automation is enabled.

Tasks:

- add `src/main/logger.ts`;
- log app startup, current user/session state, backend proxy failures, recording lifecycle, and future scheduler decisions;
- expose log location in Settings/About later if needed.

Log rules:

- no tokens;
- no API keys;
- no raw embeddings;
- no SAS URLs;
- no full transcript/prompt payloads.

Deliverables:

- persistent log file;
- structured event names for later scheduler and recording diagnostics.

Verification:

- launch app;
- perform manual recording;
- verify logs exist and contain lifecycle events;
- verify secrets are not logged.

### Phase 3 — `IN-65` Graph detection spike

Purpose:

- Decide the Graph sync strategy before implementation.

Expected recommendation:

- MVP: delegated `Calendars.Read`, Electron main-process polling/delta polling, not webhooks.

Spike questions:

- polling vs subscription;
- required scopes and admin consent;
- event filtering rules;
- timezone strategy;
- throttle/backoff rules;
- sleep/resume recovery;
- host-only semantics;
- privacy opt-in/notice requirements.

Deliverables:

- `docs/spikes/ms-graph-meeting-detection.md`;
- recommendation attached to `IN-65`;
- live Graph payload sample if credentials are available.

Exit criteria:

- David can approve polling or ask for a backend webhook relay.

### Phase 4 — `IN-68` Graph detection implementation

Purpose:

- Detect recordable meetings without starting recordings yet.

Tasks:

- add Graph client/poller/normaliser/filter modules;
- persist scheduler state;
- log include/exclude decisions;
- handle recurring meetings through calendarView;
- handle app startup/resume/reconnect/token refresh.

Deliverables:

- detected upcoming eligible meeting state;
- skipped/excluded event reasons;
- no auto-recording yet.

Verification:

- unit-style fixture checks for cancelled/all-day/free/non-organizer/declined events;
- live/manual smoke if Graph auth exists;
- logs prove correct event selection.

### Phase 5 — `IN-67` Host-only gate

Purpose:

- Ensure auto-recording only starts for meetings organised by the signed-in user.

Tasks:

- compare signed-in user identity with event organiser / `isOrganizer`;
- skip non-organiser meetings;
- show passive status, not modal spam;
- log skip reason.

Deliverables:

- host gate helper;
- scheduler integration;
- non-organiser skip diagnostics.

Verification:

- `IN-84`: non-organiser meeting does not auto-record;
- organiser fixture passes;
- manual recording still works.

### Phase 6 — `IN-66` Auto-start / auto-stop recording state machine

Purpose:

- Wire Graph meeting events to recording while preserving manual capture.

Tasks:

- implement main-to-renderer recording commands;
- add renderer-side auto-recording handler around existing `capture` singleton;
- implement recording state machine;
- add idempotency by event ID + occurrence start;
- upload completed recording with meeting metadata.

Deliverables:

- auto-start command flow;
- auto-stop command flow;
- conflict rules for manual vs auto;
- duplicate-trigger protection.

Verification:

- `IN-83`: organiser auto-recording starts;
- `IN-85`: manual recording still works;
- duplicate scheduler events do not start duplicate recordings;
- auto-stop is idempotent.

### Phase 7 — `IN-71` and `IN-77` Tray/startup/status UX

Purpose:

- Make the app work like a background recorder without interrupting users.

Tasks:

- implement tray module;
- support quiet startup;
- support app login item / Windows startup behaviour;
- display status for idle, recording, processing, skipped;
- update UI to show auto-recording status alongside manual controls.

Deliverables:

- tray icon/menu/status;
- startup persistence;
- recording status UI.

Verification:

- app can start quietly;
- tray opens app;
- status changes during recording;
- manual controls remain visible.

### Phase 8 — `IN-69`, `IN-78`, `IN-79`, `IN-80` Backend pipeline split and matching logic

Purpose:

- Prepare and implement the real speech/voiceprint pipeline cleanly.

Tasks:

- split speaker matching out of `pipeline.py`;
- add speaker embedding provider interface;
- add voiceprint repository interface;
- implement attendee-first candidate selection;
- implement controlled candidate expansion for key uninvited people;
- implement false-positive suppression;
- store confidence, threshold version, source, and reason.

Deliverables:

- backend pipeline services;
- speaker matching diagnostics;
- unknown-safe output.

Verification:

- stub pipeline still works;
- known speaker maps above threshold;
- weak/non-attendee match remains unknown;
- `IN-86` and `IN-87` pass against fixtures or test recordings.

### Phase 9 — `IN-76` Voiceprint enrollment/admin utility

Purpose:

- Enroll staff voiceprints safely.

Tasks:

- implement admin CLI or backend endpoint first;
- require exactly three clips;
- extract and average/store embedding;
- delete source audio immediately;
- store model version;
- support re-enrollment flag;
- prepare encryption/key vault boundary.

Deliverables:

- voiceprint enrollment utility;
- voiceprint metadata model;
- re-enrollment behaviour.

Verification:

- rejects fewer/more than 3 clips;
- raw clip not persisted;
- embedding stored securely via abstraction;
- no embedding/audio data logged.

### Phase 10 — `IN-93`, `IN-94`, `IN-72`, `IN-74`, `IN-75`, `IN-88` Email and UI cleanup

Purpose:

- Align the app with final transcript delivery and simplified UI.

Email tasks:

- implement Graph email provider;
- attach transcript;
- send only after finalisation unless requirements change;
- choose recipients from meeting participants/invitees;
- handle ad-hoc recording recipient fallback;
- log result without leaking content.

UI cleanup tasks:

- remove per-calendar meeting Record button;
- remove full meeting detail page only if it is no longer needed;
- remove aggregate action items view only if scope confirms it;
- preserve manual recording and audio setup controls.

Important caution:

Current requirements still mention review, dashboard, and action items. Do not remove review/finalise/action-item functionality beyond what Jira explicitly requires without David confirming the product change.

Verification:

- `IN-88`: calendar Record button absent, manual controls present;
- `IN-94`: transcript email attachment sent to correct people;
- no email before finalisation;
- UI still supports review and unknown speaker resolution if required.

### Phase 11 — `IN-81` Packaging, signing, installer update

Purpose:

- Produce a deployable desktop app.

Dependency:

- wait for `IN-89` / DV confirmation on Intune and installer approach.

Open packaging decision:

- NSIS one-click per-user installer from current requirements;
- or Intune Win32/MSI-style deployment if DV requires centrally managed install.

Tasks after decision:

- update electron-builder configuration;
- ensure signing strategy;
- update release workflow;
- inspect packaged app for secrets/local artefacts;
- create release notes.

Verification:

- `npm run package:dir`;
- packaged app launches;
- no `.env`, tokens, secrets, logs, local DB, local recordings, pycache, or dev artefacts included;
- update/feed strategy matches chosen installer.

## 9. File/module implementation map

| Area | Current files | Target/new files |
|---|---|---|
| Main process foundation | `src/main/index.ts` | `window.ts`, `api-proxy.ts`, `auth-session.ts`, `media-permissions.ts`, `recording-storage.ts`, `updater.ts` |
| Logging | none central | `src/main/logger.ts` |
| Graph sync | none | `src/main/graph/client.ts`, `calendar-poller.ts`, `event-normalizer.ts`, `event-filters.ts` |
| Scheduler | none | `src/main/scheduler/meeting-scheduler.ts`, `host-gate.ts`, `scheduler-state.ts` |
| Recording automation | `src/renderer/src/lib/capture.ts`, `src/renderer/src/App.tsx`, `src/preload/index.ts` | renderer auto-record handlers, stable IPC contracts, recording state hook/service |
| Tray/startup | `src/main/index.ts` | `src/main/tray.ts`, startup settings module |
| Pipeline orchestration | `backend/app/services/pipeline.py` | orchestration only after extracting matching/voiceprint services |
| Speech | `backend/app/services/speech.py` | PyannoteAI transcription/speaker ID provider implementation |
| Voiceprints | `backend/app/routers/people.py`, `backend/app/store.py` | `voiceprints.py`, `speaker_embeddings.py`, admin utility |
| Speaker matching | `_match_speakers` in `pipeline.py` | `speaker_matching.py`, `diagnostics.py` |
| Email | `backend/app/services/email.py` | Graph email provider |
| UI cleanup | renderer screens | targeted removals after scope confirmation |

## 10. Test and verification strategy

### Minimum gate for every PR/change

Desktop:

```bash
npm run typecheck
npm run build
```

Backend:

```bash
cd backend
.venv/bin/python -m uvicorn app.main:app --port 8787
```

Manual smoke:

- app launches;
- backend reachable;
- manual recording still works;
- upload/pipeline/review path works;
- no console/runtime errors.

### Tests to add as work proceeds

Because the repo currently has no dedicated automated test runner, add lightweight tests or fixture-driven scripts where they give high value.

Graph tests:

- cancelled event excluded;
- all-day event excluded;
- free/declined event excluded;
- recurring occurrence handled;
- organiser event eligible;
- non-organiser event skipped;
- timezone conversion around DST safe;
- duplicate event update does not duplicate recording.

Scheduler tests:

- only one recording at a time;
- manual recording wins over auto;
- auto-stop idempotent;
- sleep/resume recomputes schedule;
- stale event revalidated before recording.

Speaker matching tests:

- high-confidence known speaker maps;
- weak match remains unknown;
- non-attendee false positive suppressed;
- attendee-first matching preferred;
- candidate expansion only for approved uninvited people;
- model version/threshold version recorded.

Email tests:

- no send before finalisation;
- transcript attachment present;
- correct recipient selection;
- ad-hoc fallback recipient correct;
- failures logged without leaking content.

Packaging tests:

- package builds;
- app launches installed/unpacked;
- packaged resources do not include secrets/local data;
- update/feed config matches release approach.

## 11. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Big-bang refactor delays delivery | High | Refactor only boundaries that directly enable Jira items |
| Graph webhook architecture overcomplicates MVP | High | Use polling/delta for desktop MVP; defer webhook relay |
| Auto-recording starts wrong meeting | High | host gate, filters, logs, idempotency, revalidation before start |
| Manual recording regression | High | keep `capture.ts` low-churn; verify `IN-85` every recording change |
| Timezone/DST bug starts late/early | High | store UTC instants, fixture tests, avoid manual offset math |
| Windows sleep/resume misses meeting | High | use Electron `powerMonitor`; resync on resume/unlock/network |
| False speaker identification | High | threshold + margin + attendee-first + Unknown fallback |
| Voiceprint privacy issue | High | consent, encryption, no raw enrollment audio retention, no logging embeddings |
| PyannoteAI processing delays | Medium | async status, retry, do not promise instant results |
| Removing UI still required by product | Medium | confirm with David before removing review/action functionality |
| Packaging requirement changes to Intune | Medium | block `IN-81` until `IN-89` answered |
| Secrets leak into desktop package | High | package inspection gate; no secrets in renderer/main |

## 12. Open decisions for David/DV

1. Is desktop MVP approved to use Graph polling/delta polling instead of webhook subscriptions?
2. Is `Calendars.Read` acceptable, or should we first attempt `Calendars.ReadBasic` and escalate only if fields are insufficient?
3. Are private meetings excluded from auto-recording by default?
4. How should tentative meetings be handled?
5. What is the exact auto-start grace window before/after meeting start?
6. What is the exact auto-stop grace window after meeting end?
7. If the user manually records while an eligible meeting starts, should auto-record skip or prompt?
8. Are Teams meetings the only auto-recording target, or should Zoom/Google Meet calendar events also trigger loopback recording?
9. Who is allowed in the voiceprint candidate expansion list for key uninvited people?
10. What formal consent artefact is required for voiceprint enrollment?
11. Does final transcript email go to all invitees, attendees, organiser only, or user-selected recipients?
12. Should ad-hoc recordings email only the recorder by default?
13. Does DV require Intune/MSI packaging instead of NSIS per-user installer?
14. What is the approved code-signing approach?

## 13. Definition of done per Jira item

### `IN-65` Graph detection spike

Done when:

- spike document exists;
- polling vs subscription decision is recorded;
- permissions/admin consent notes are recorded;
- filter/timezone/throttle/sleep-resume strategy is recorded;
- David can approve next implementation.

### `IN-68` Graph meeting detection

Done when:

- eligible meetings are detected and normalised;
- skipped/excluded meetings have logged reasons;
- recurring calendar occurrences are handled through calendarView;
- no recording is started from stale event state.

### `IN-67` Host-only gate

Done when:

- organiser meetings can proceed;
- non-organiser meetings are skipped;
- skip reason is logged and visible/passively diagnosable;
- manual recording bypasses the gate.

### `IN-66` Auto-start/auto-stop

Done when:

- eligible organiser meeting starts capture automatically;
- scheduled end stops capture safely;
- duplicate triggers cannot create duplicate recordings;
- manual recording remains available.

### `IN-71` Startup/tray

Done when:

- app can run at startup;
- app persists in tray;
- quiet startup does not interrupt user;
- tray opens app and displays useful status.

### `IN-77` Recording status UI

Done when:

- UI shows auto-recording status alongside manual controls;
- manual controls remain clear;
- skipped/idle/recording/processing states are understandable.

### `IN-69` Speech + voiceprint pipeline

Done when:

- PyannoteAI provider path is defined/implemented behind interface;
- provider speaker labels flow into speaker matching;
- PyannoteAI/voiceprint matches identify staff only above safe confidence;
- unknown speakers stay unknown.

### `IN-76` Voiceprint admin utility

Done when:

- exactly three clips can enroll staff;
- raw clip audio is not retained;
- embedding metadata includes model version;
- re-enrollment can be flagged.

### `IN-78`, `IN-79`, `IN-80` Speaker matching rules

Done when:

- attendee-first candidate selection is implemented;
- controlled expansion rules are implemented;
- false-positive suppression prevents unsafe non-attendee naming;
- tests/fixtures prove known and unknown outcomes.

### `IN-93` / `IN-94` Transcript email

Done when:

- transcript can be sent through Outlook/Graph;
- attachment is present;
- recipient logic is correct;
- no email sends before required review/finalisation;
- failure states are logged and visible.

### `IN-72`, `IN-74`, `IN-75`, `IN-88` UI cleanup

Done when:

- agreed obsolete UI is removed;
- per-calendar Record button is absent;
- manual controls and audio setup remain;
- review/finalisation requirements are not accidentally removed.

### `IN-81` Packaging/signing/installer

Done when:

- DV installer approach is confirmed;
- package builds;
- app launches;
- no secrets/local dev artefacts are included;
- release/update notes are complete.

## 14. Recommended execution order

1. Phase 0 — baseline and evidence setup.
2. Phase 1 — main-process foundation refactor.
3. Phase 2 — persistent logging.
4. Phase 3 — `IN-65` Graph spike.
5. Phase 4 — Graph detection without recording.
6. Phase 5 — host-only gate.
7. Phase 6 — auto-start/auto-stop state machine.
8. Phase 7 — tray/startup/status UX.
9. Phase 8 — backend pipeline split and speaker matching.
10. Phase 9 — voiceprint enrollment.
11. Phase 10 — Outlook email and UI cleanup.
12. Phase 11 — packaging/signing/installer after DV confirmation.

## 15. Final pre-implementation review — 2026-06-25

A final repo/readiness check was performed before implementation.

### Repo verification

Commands run from `/home/josephmiguelguerrero/projects/meeting-notetaker-2`:

```bash
npm run typecheck
npm run build
cd backend && .venv/bin/python - <<'PY'
from app.main import app
print('backend import ok', app.title if hasattr(app, 'title') else type(app))
PY
cd backend && .venv/bin/python -m uvicorn app.main:app --port 8787
# then checked http://127.0.0.1:8787/health
```

Observed results:

- TypeScript typecheck passed.
- Electron/Vite production build passed.
- Backend app import passed: `Meeting Notetaker API`.
- Backend health endpoint returned `200 {"status":"ok","environment":"dev"}` at `/health`.
- `/api/v1/health` returned 404; the current health route is `/health`.
- Git working tree only showed this new implementation plan folder as untracked.

### External practice check

Current Microsoft/Electron/Azure docs still support the plan:

- Microsoft Graph change notifications have limited subscription lifetimes and require renewal; local Electron cannot directly receive webhook callbacks without public HTTPS infrastructure.
- Microsoft Graph `calendarView` is the right API family for bounded calendar windows and recurring occurrences.
- Microsoft Graph event delta queries provide `@odata.nextLink` / `@odata.deltaLink` state tokens for incremental sync.
- Microsoft Graph throttling guidance requires respecting `429` and `Retry-After`.
- Electron `powerMonitor` exposes suspend/resume events needed for scheduler recovery.
- Electron `Tray` supports the background/tray-first UX required by `IN-71`.
- PyannoteAI API capabilities for transcription, speaker labels, and timestamps must be confirmed against Jira IN-69 before replacing the stub.
- Azure Blob lifecycle management supports the 30-day raw audio retention direction.
- Azure Key Vault guidance supports RBAC, auditing, and avoiding embedded credentials.

### Final caveats before coding

1. The current repo has no dedicated automated test runner. We should add fixture-driven tests/scripts where they give high value, especially for Graph filters, scheduler state, speaker matching, and email recipient rules.
2. `backend/app/routers/meetings.py` currently serves meeting audio without an actor check because the renderer audio element cannot send the actor header. This is acceptable as a local stand-in but must be replaced by authorised streaming or short-lived Blob SAS URLs before real deployment.
3. The app currently has health at `/health`, not `/api/v1/health`; implementation docs and smoke scripts should use the current route unless the API prefix is standardised later.
4. The remote currently points to `gerdguerrero/meeting-notetaker-2`. Confirm the long-term GitHub org/repo before pushing production implementation work if Factor1 org ownership is required.
5. The Jira UI-removal items must be handled carefully because `docs/requirements.md` still requires review, dashboard, and in-app action item tracking. Do not remove those broader behaviours unless David confirms the product scope changed.

Conclusion: the plan remains implementation-ready. Proceed with Phase 0 evidence capture, then Phase 1 no-behaviour-change main-process refactor.

## 16. Immediate next step

Start with Phase 0.

Concrete next actions:

1. record the above baseline results in Jira/evidence notes;
2. commit this implementation plan if desired;
3. implement Phase 1 as a no-behaviour-change refactor of `src/main/index.ts`;
4. rerun `npm run typecheck`, `npm run build`, and `/health` after the refactor;
5. then proceed to Phase 2 persistent logging.
