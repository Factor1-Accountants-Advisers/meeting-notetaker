# Jira progress ledger

Date started: 2026-06-26
Owner: Joseph Guerrero

This ledger tracks Slice 1 Jira implementation items as we complete and verify them in this repo. It is intentionally evidence-focused so David/Benjamin can map commits back to the plan.

## Current implementation evidence

- [x] Phase 1 — Durable backend pipeline stage model
  - Added backend-owned `pipeline_stage`, user-safe stage messages, stage timestamps, processing attempt/error fields, and independent `delivery_status`/`delivery_error_message`.
  - Pipeline now persists stage transitions for queued, transcribing/diarizing, identifying speakers, extracting notes, ready, and failed states.
  - Email delivery now records emailing/emailed/failed status; 401/502 delivery failures are persisted instead of being frontend-only.
  - Renderer polling now displays backend `pipeline_stage_message`, so refresh/reopen can recover from backend state instead of local timers only.
  - Verification: `PYTHONPATH=. .venv/bin/python -m unittest discover -s tests -v`, `.venv/bin/python -m compileall app tests`, `npm run typecheck`, `npm run build`, `git diff --check`, and direct model serialization smoke passed.
  - Commit: `5440eec`

- [x] Phase 2a — Speaker identity evidence and false-positive suppression foundation
  - Added transcript segment identity evidence fields for raw diarization speaker, source, confidence, evidence timestamp range/job id, and Unknown reason.
  - Added attendee-first candidate selection: Graph attendees first, organiser/recorder next, controlled expansion only when explicitly supplied; no broad staff matching by default.
  - Strengthened speaker resolution so low-confidence or short-overlap identify ranges stay Unknown with explicit reasons.
  - Added tests for attendee-first ordering, high-confidence evidence preservation, low-confidence suppression, and short-overlap suppression.
  - Verification: `PYTHONPATH=. .venv/bin/python -m unittest discover -s tests -v`, `.venv/bin/python -m compileall app tests`, `npm run typecheck`, `npm run build`, and `git diff --check` passed.
  - Commit: `79ebd97`

- [x] Phase 2b — Live pyannoteAI identify smoke
  - Verified local pyannoteAI config is present via `.env` without printing secrets.
  - Verified enrolled voiceprint registry contains Joseph Miguel Guerrero with 3 precision-2 voiceprints.
  - Ran live `/v1/identify` against `backend/var/audio/389c0852-adbf-4e89-afa9-69cf27382f0b.webm`.
  - Provider job succeeded; output included `confidence`, `diarization`, `exclusiveDiarization`, `identification`, and `voiceprints`.
  - Parser produced 8 Joseph identity ranges from 13 identification rows; sample confidence normalized to `0.7`; evidence job id present.
  - `_apply_identity_ranges` resolved `SPEAKER_01` to Joseph Miguel Guerrero with source `pyannote_voiceprint`, confidence `0.7`, and no Unknown reason.
  - Added in-person owner alias handling so local owner id `joseph` selects `josephguerrero@factor1.com.au` without broad staff expansion.
  - Verification: `PYTHONPATH=. .venv/bin/python -m unittest discover -s tests -v`, `.venv/bin/python -m compileall app tests`, `npm run typecheck`, `npm run build`, and `git diff --check` passed.

- [x] Phase 3 — OpenAI long-meeting chunking/reduce foundation
  - Replaced single-prompt OpenAI summarisation/action extraction with a 15-minute transcript window map-reduce path.
  - Chunk calls return structured JSON for summary bullets, decisions, risks, questions, and action items; a final reduce pass deduplicates and consolidates final summary/action items.
  - Added bounded chunk concurrency and per-provider cache so `summarize()` followed by `extract_action_items()` reuses the same chunk/reduce result instead of paying/running twice.
  - Labelled transcript prompts now include timestamps and speaker display names; owner prompts require exact speaker display names where available.
  - Added tests for chunk boundaries, labelled transcript formatting, and chunk-then-reduce behavior.
  - Live OpenAI smoke passed with configured `.env`: summary generated, 2 action items returned, cache had 1 entry, owners preserved as Joseph Guerrero and Benjamin Bryant.
  - Verification: `PYTHONPATH=. .venv/bin/python -m unittest discover -s tests -v`, `.venv/bin/python -m compileall app tests`, `npm run typecheck`, `npm run build`, and `git diff --check` passed.

- [x] Phase 4 — Delivery reliability foundation
  - Added SharePoint delivery state on meetings: `sharepoint_status`, `sharepoint_error_message`, and `sharepoint_web_url`, separate from email delivery state.
  - Added SharePoint transcript save provider with local locked-folder stand-in plus Graph upload path when `MN_SHAREPOINT_DRIVE_ID`/`MN_SHAREPOINT_FOLDER_PATH` and delegated Graph token are available.
  - Added `POST /api/v1/meetings/{id}/sharepoint` to save the generated transcript artifact without mutating/deleting transcript, summary, participants, or action items on delivery failure.
  - Refactored delivery artifact formatting so email and SharePoint use the same transcript/summary/action output.
  - Added tests proving Graph email failure marks delivery failed while preserving ready pipeline outputs, and SharePoint save records the saved location/status.
  - Local SharePoint smoke passed: endpoint returned `saved`, `file:` URL, and no error.
  - Verification: `PYTHONPATH=. .venv/bin/python -m unittest discover -s tests -v` (13 tests), `.venv/bin/python -m compileall app tests`, `npm run typecheck`, `npm run build`, and `git diff --check` passed.

- [x] Phase 5 — MSAL token cache persistence and cold-start recovery
  - MSAL token cache now serialized to `userData/auth/msal-cache.json` after interactive sign-in and after every successful silent token refresh, and deserialized on app startup + new client-application creation.
  - `clearCurrentMsalAccount()` also deletes the persisted cache file so sign-out reliably destroys all tokens.
  - Added `auth:sign-out` IPC handler to clear local session + persisted MSAL cache from the renderer.
  - Added `auth:status` IPC handler so the renderer can check persisted cache existence on cold start.
  - Renderer `App.tsx` now calls `getAuthStatus` on mount: if a persisted cache is found but localStorage is empty, it auto-restores a session from the cached account email so auto-record + email/SharePoint delivery work after restart without re-prompting the user.
  - Sign-out in the renderer now also triggers the `auth:sign-out` IPC to clear the MSAL cache, not just localStorage.
  - API proxy now also injects the Graph access token for SharePoint POST endpoints, not only email.
  - Verification: `npm run typecheck`, `npm run build`, `PYTHONPATH=. .venv/bin/python -m unittest discover -s tests -v` (13 tests), `.venv/bin/python -m compileall app tests`, and `git diff --check` passed.

- [x] Phase 6 — Verification pack
  - Full test suite: 13 tests in 4 modules passing (pipeline stage state, speaker identity matching, long-meeting chunking, delivery reliability).
  - End-to-end pipeline smoke with real stored audio: live pyannoteAI transcription (9 segments), voiceprint identification (Joseph matched, 1 Unknown), OpenAI summary (290 chars, 2 action items), SharePoint local save (file:// URL), no-token email refusal (delivery state correctly refused).
  - All delivery outputs survive failures: summary, transcript, and participants intact after email and SharePoint delivery attempts.
  - Cross-cutting audit: `save_snapshot` called in 4 delivery paths, `set_pipeline_state` and `set_delivery_state` guarding all state transitions. No secrets in tracked files (config.py fields are empty-string defaults). Backend 11 service files, 4 test files; frontend 14 main-process files, 8 renderer screens.
  - Verification: `npm run typecheck`, `npm run build`, `.venv/bin/python -m compileall app tests`, `PYTHONPATH=. .venv/bin/python -m unittest discover -s tests -v`, `git diff --check`, and secrets audit passed.

- [x] Phase 7 — Post-live voiceprint and delivery hardening
  - Enrolled David Ahlhaus locally with 3 precision-2 voiceprints and added him to controlled expansion for Slice 1 testing.
  - Diagnosed and fixed IN-79 expansion merge corruption: `_merge_expansion_matches` previously keyed by raw diarization cluster (`SPEAKER_01`), replacing every segment in a cluster with one matched segment object.
  - Fix now keys expansion merge by segment identity `(raw_speaker, start_ms, end_ms, text)`, preserving each segment's transcript text and timestamps while still applying per-segment confidence/overlap gating.
  - Added regression coverage for a multi-segment cluster where only one segment passes the expansion gate; unknown segments remain Unknown instead of being renamed or overwritten.
  - Removed UUID suffix from SharePoint/email transcript filenames; filenames now use human-readable meeting title + date, e.g. `Test 3-2026-07-03.txt`.
  - Verified SharePoint transcript retention behavior: transcripts are not auto-deleted; only raw audio is covered by the 30-day retention sweep.
  - Verification: `PYTHONPATH=. .venv/bin/python -m unittest discover -s tests -v` (19 tests), `.venv/bin/python -m compileall app tests`, `npm run typecheck`, `npm run build`, and `git diff --check` passed.
  - Commits: `7065f4c`, `8896c8b`.

- [x] 2026-07-10 — IN-64 reconciliation pass (evidence, no feature rework)
  - **IN-86 provider evidence (David's failed job `39336e51`, fetched read-only from pyannoteAI):** diarization collapsed the BB+DA meeting into one cluster — 638 turns, `SPEAKER_00` = 2337.7s (~the whole meeting), `SPEAKER_01` = 0.7s; per-frame diarization confidence 97–100 despite the collapse. The job's candidate voiceprints contained **only David's 3 prints** (Benjamin absent — manual-recording recorder-only first pass). David's best confidence against the blended cluster was 0.37, correctly suppressed below the 0.62 gate. Verdict: failure is diarization separation on pre-mixed Teams downlink audio, upstream of voiceprints; the matcher's refusal to name anyone was the *correct* per-acceptance behavior.
  - **IN-86 fix verification on real data (Test10, job `e9fdc4ca` replay):** re-ran current `_identity_ranges_from_result` + `_apply_identity_ranges` against the actual stored provider output. Pre-fix stored result: 7 participants with phantom splits (SPEAKER_02 → David + "Unknown 2" ×72; SPEAKER_00 → Benjamin + "Unknown 4" ×24). Current code: 5 participants — David gets all 358 SPEAKER_02 segments (286 matched at 0.9 + 72 `cluster_propagation`), Benjamin all 80, and the 3 genuinely unidentified tiny clusters (28s total) stay "Speaker N" with `no_identity_match`. Replay script: session scratchpad `replay_test10.py`; no provider reprocessing spent.
  - IN-86 stays open: live retest needed on a fresh separated-audio recording (wired mic per runbook) and/or with `MN_PYANNOTE_NUM_SPEAKERS` set to the known speaker count — the hint's effectiveness on pre-mixed audio is untested (source audio for job `39336e51` is not retained locally).
  - **CI credentials gap fixed (IN-79/IN-81):** `release.yml` wrote only the two API keys into the packaged `backend.env`, so CI-built installers silently shipped without `MN_VOICEPRINT_EXPANSION_EMPLOYEE_IDS` — disabling IN-79 expansion (manual recordings would only ever match the recorder, the exact candidate shape seen in job `39336e51`). Workflow now writes the expansion vars from repo variables and warns loudly when unset; `backend.env.template` documents the expansion vars and the `MN_PYANNOTE_NUM_SPEAKERS` knob. **Manual step pending:** set repo variables `MN_VOICEPRINT_EXPANSION_EMPLOYEE_IDS` (+`MN_VOICEPRINT_EXPANSION_CAP`) on Factor1-Accountants-Advisers/meeting-notetaker (`gh variable set …`).
  - **IN-94/IN-119 recipients:** `_email_recipients` (meetings.py) verified — attendees + organiser + recorder, case-insensitive dedup; ad-hoc/manual → recorder only. 3/3 tests in `test_email_recipients.py` pass. Live Graph retest pending (no delegated token in this session).
  - **IN-88 evidence (Jira "failed" is wording, not a bug):** nav is Home/People/Settings only (`lib/nav.ts`); meeting-detail/action-items screens exist as dead files but are not imported by `App.tsx`; no per-meeting calendar Record button anywhere; Settings retains the Audio capture section. Manual Start/Stop + tray controls are **required** by IN-64 AC #3/#6 ("per-meeting Record button absent; manual controls retained") — do not remove. Recommend Jira comment + retest, not code change.
  - **IN-117/IN-124 extension, code-verified end-to-end:** renderer button (gated on `scheduledEndUtc`, auto-recordings only) / tray "Extend 10 min" / toast `mn-extend` argv → `extendAutoStop()` = max(scheduled end, now) + 10 min, reschedules auto-stop + reminder timers → `recording:end-extended` → App updates `scheduledEndUtc` → RecordingScreen countdown re-derives. Windows toast-button activation delivery still needs live verification (tray item is the guaranteed fallback).
  - **IN-120 tray pause/resume/stop, code-verified:** tray → `recording:tray-control` → App ref-dispatched handlers; renderer mirrors pause state back via `recording:paused-changed` so the tray label stays synced; Stop works for auto and manual recordings.
  - **IN-123/IN-126 home cleanup verified:** "Meeting Title" header, "Start Recording" primary, "Upload recording" secondary, banner "Show" button; no Invite button, no meeting-link field in `HomeScreen.tsx`. People tab retained (rollout uses it for voiceprint verification/enrollment).
  - **IN-127 verified:** unidentified speakers labelled "Speaker N" in `speaker_matching.py` (initial naming, renumbering, unknown-only paths); remaining "Unknown" strings are schema/mock comments and the `X-MN-User` header default ("Unknown user"), not speaker labels.
  - Verification: `npm run typecheck`, `npm run build`, `npm run verify:graph`, backend unittest discover (51 tests OK), `compileall`, `git diff --check`, and YAML syntax check on `release.yml` — all passed.

## Crossed out / completed

- [x] `IN-65` — Spike: MS Graph meeting detection — subscription vs. polling
  - Evidence: `docs/spikes/ms-graph-meeting-detection.md`
  - Commit: `9486bd9 document Graph meeting detection spike`
  - Verification: documentation self-check passed; fresh `npm run typecheck`, `npm run build`, and `git diff --check` passed after the doc change.

- [x] `IN-67` — Host-only gate
  - Explicit organiser-only boundary in `src/main/graph/host-gate.ts`.
  - Integrated into runtime for diagnostics logging.
  - Fixture-verified: organiser passes, non-organiser blocked, excluded events blocked, email-less gate works.
  - Manual recording bypasses the gate entirely.
  - Commit: `e25c4e3`

- [x] `IN-66` — Wire auto-start and auto-stop recording to Graph meeting events
  - Recording state machine with idle/recording/processing lifecycle, idempotency by event key, manual-wins-over-auto conflict resolution.
  - Main→renderer IPC bridge: `webContents.send` for start/stop commands.
  - Renderer→main IPC: `recording:started` / `recording:stopped` / `recording:error`.
  - Auto-stop timer: schedules `setTimeout` for meeting end time.
  - Renderer integration: `App.tsx` listens for auto-start/stop, creates meeting, starts capture, stops and uploads on auto-stop.
  - Graph metadata now flows through detection → auto-start IPC → meeting create/audio upload → backend meeting record (`title`, attendees, Graph event id, online meeting id, join URL, organiser email).
  - Fixed auto-stop renderer callback to read the latest recording session via refs, so upload is not lost to a stale React closure.
  - Verification: `npm run verify:graph`, `npm run typecheck`, `npm run build`, `git diff --check`, backend `compileall`, and a real FastAPI smoke for create/upload with Graph metadata.
  - Commit: `1df29d8`, `0000990`, `9b74905`

- [x] `IN-71` — Configure app to run at Windows startup and persist in system tray
  - System tray with status tooltip and context menu (Show / Quit).
  - App persists in tray when all windows are closed.
  - Packaged Windows builds default auto-launch on via `app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args: ['--background'] })`.
  - Login launch uses `--background` so the renderer is available for auto-recording but the main window stays hidden until tray/open action.
  - Single-instance handling prevents a background login launch from creating a duplicate app; explicit user launches focus the existing window.
  - Settings includes an opt-out toggle; user choice is persisted and prevents the default from re-enabling automatically.
  - Tray menu updates live when recording state changes.
  - Verification: `npm run typecheck`, `npm run build`, `git diff --check`.
  - Commit: `a7db862`, `0630750`

- [x] `IN-77` — Recording status UI
  - `HomeScreen` shows auto-recording status banner (recording / processing).
  - `App.tsx` tracks `autoRecordingState` via auto-start/stop IPC events.
  - Tray tooltip reflects current recording state.
  - Commit: `132cb77`

- [x] `IN-69` — Wire pyannoteAI transcription and voiceprint identification into production pipeline
  - pyannoteAI client fully wired: `/v1/diarize` with `transcription: true`, `/v1/voiceprint`, `/v1/identify`.
  - Live verify smoke run 2026-07-02: transcription returned 9 speaker-attributed segments; voiceprint identify matched Joseph Miguel Guerrero from SPEAKER_01 with confidence 0.7.
  - Parser produces identity ranges with raw speaker, display name, confidence, and provider job ID per segment.
  - Verified in Phase 2a/2b; see commits `79ebd97`, `fd00aab`.

- [x] `IN-78` — Attendee-first voiceprint candidate selection
  - `_candidate_voiceprints_for_meeting()` orders Graph attendees first, organiser/recorder next, controlled expansion last.
  - No broad staff matching by default; candidates only from meeting metadata + explicit expansion set.
  - Verified in Phase 2a; commit `79ebd97`.

- [x] `IN-79` — Controlled voiceprint candidate expansion
  - Added second-pass controlled expansion: first identify pass uses attendees/organiser/recorder only; if speakers remain Unknown, pyannoteAI identify is retried with configured key-person expansion candidates.
  - Added config: `MN_VOICEPRINT_EXPANSION_EMPLOYEE_IDS`, `MN_VOICEPRINT_EXPANSION_CAP`, and `MN_VOICEPRINT_EXPANSION_MIN_CONFIDENCE`.
  - Expansion preserves configured priority order, enforces cap limits, and uses a stricter confidence threshold for key uninvited people.
  - Decision note: `docs/decisions/2026-07-02-in79-voiceprint-candidate-expansion.md`.
  - Verified in tests; commit `246ab39`.

- [x] `IN-80` — False-positive suppression for non-attendee detections
  - Segments stay Unknown when confidence < threshold, overlap < 800ms, no identity range matches, or identify fails.
  - Explicit unknown reasons recorded: `low_confidence`, `insufficient_overlap`, `no_identity_match`, `no_enrolled_voiceprints`, `identify_failed`.
  - Verified in Phase 2a/2b; commits `79ebd97`, `fd00aab`.

- [x] `IN-76` — Voiceprint enrollment/admin utility
  - Enrollment wizard records 3 clips with explicit consent, backend confirmation required.
  - pyannoteAI `/v1/voiceprint` called for each clip; opaque provider voiceprint payloads persisted locally.
  - Joseph Miguel Guerrero enrolled with 3 precision-2 voiceprints; live identify smoke confirmed they resolve correctly.
  - Verified in Phase 2b; commit `fd00aab`.

- [x] `IN-93` — Implement MS Outlook emailing of Transcript
  - `GraphEmailProvider` sends via delegated Microsoft Graph `POST /me/sendMail`.
  - Transcript attached as `.txt` file via `build_transcript_attachment()`.
  - Token injection: `api-proxy.ts` attaches `X-MN-Graph-Token` header on email endpoints.
  - Jira-aligned trigger: email is allowed once `pipeline_status == ready`; no finalise/review gate required.
  - Recipient rules: Graph attendee emails for calendar-linked recordings; recorder email fallback for manual/ad-hoc recordings.
  - Error handling: 502 with logged detail on Graph delivery failure; missing Graph token returns 401 instead of fake stub success; UI shows retryable email failure without losing recording.
  - Stub provider remains available for direct unit tests, but the API endpoint requires a Graph token for user-visible email delivery.
  - All email actions audit-logged with recipients.
  - Verification: `scripts/verify-email-jira-flow.py`; live no-token smoke now returns `401 Outlook sign-in is required` instead of fake success.
  - Commit: `7d1197c`

- [x] `IN-72` — UI cleanup: remove per-calendar-meeting Record button
  - Per-calendar Record button absent — whole meeting list/view removed per IN-73.

- [x] `IN-74` — UI cleanup: remove full meeting detail page
  - MeetingReviewScreen, MeetingsScreen removed from App. Navigation removed.
  - Transcript/summary/waveform/speaker review/export all removed.

- [x] `IN-75` — UI cleanup: remove action items view
  - ActionItemsScreen removed from App and navigation.
  - Dashboard action items card removed from HomeScreen.

- [x] (IN-73) Dashboard cleanup
  - UpcomingCard (calendar strip), RecordingsCard, ActionItemsCard removed from HomeScreen.
  - Navigation reduced to Home, People, Settings.
  - Manual recording controls, audio setup, capture/status UI preserved.
  - Commit: `e225a21`

- [x] `IN-81` — Packaging, signing, and installer update
  - Version bumped to 1.0.0 reflecting Slice 1 completion.
  - electron-builder.yml updated: Intune Win32 note per DV, backend/.env/scripts excluded from package.
  - `npm run package:dir` verified — builds cleanly, no secrets or local artefacts in asar.
  - Release workflow and signing left for CI (cert required).
  - AGENTS.md updated with Slice 1 delivered features and remaining blockers.
  - Commit: `336a47e`

- [x] `IN-68` — Implement MS Graph meeting detection
  - All code implemented and fixture-verified: Graph client, filter, normaliser, time/poller, runtime with polling + resume, MSAL public-client auth, interactive sign-in.
  - Live smoke validated 2026-06-29:
    - Interactive MSAL sign-in succeeded with old Entra app registration IDs mapped to v2 env vars (`MN_ENTRA_CLIENT_ID`, `MN_ENTRA_TENANT_ID`).
    - Delegated Graph `/me/calendarView` returned real Teams meeting events.
    - Detection identified `isOnlineMeeting: true`, `onlineMeetingProvider: 'teamsForBusiness'`, `isOrganizer: true`.
    - Host gate passed (organiser verified).
    - Auto-record triggered, renderer confirmed recording started.
    - Auto-stop timer scheduled to meeting end time.
    - Post-sign-in immediate sync verified (no 5-minute startup delay).
    - Start-window gating added (`START_WINDOW_MS = 180000` / 3 min) — events >3 min away receive `not_due_yet`; only eligible within the window.
    - Duplicate/spam protection: idempotency keys prevent re-recording the same event; completed keys tracked in state machine.
    - Delta query support documented for future optimisation; webhooks remain unnecessary for Slice 1.
    - `npm run verify:graph`, `npm run typecheck`, `npm run build`, `git diff --check` all pass.
  - Remaining items reserved for packaging verification with signed installer:
    - Verify auto-recording triggers from a cold Windows startup (tray + background).
    - Verify auto-stop timer fires correctly on meeting end.
    - Verify `.webm` saved, uploaded, and backend pipeline processes it.
  - Commits: `cf2a475`, `a59bd92`, `bb33e2c`

- [x] `IN-70` — Define internal vs client meeting_type classification rules
  - Initial Slice 1 classification rule accepted from Jira export/comments: client context is carried on the meeting record where available; otherwise internal/default context is used.
  - No blocking code work remains for Slice 1.

- [x] `IN-89` — Confirm Win32 app Intune requirements with DV
  - DV Intune Win32 packaging guidance captured in repo packaging notes.
  - `electron-builder.yml` excludes backend `.env` and local scripts from package output.
  - Remaining signed installer validation is tracked under `IN-81`, not this requirements-confirmation item.

- [x] `IN-91` — Define private SharePoint directory for transcript saving
  - Target SharePoint transcript folder configured for Slice 1: `Transcriptions` under the Innovations and Systems SharePoint drive.
  - Graph delegated upload path proven with configured drive/folder and user token.
  - App now saves the same transcript artifact used for email into SharePoint after processing.
  - Commits: `7a33084`, `85b4164`, `8896c8b`.

- [x] `IN-95` — Define MS Outlook emailing of transcript
  - Delegated Microsoft Graph `Mail.Send` approach selected and implemented via `GraphEmailProvider`.
  - User-visible email delivery requires a Graph token; no fake success path is used for real delivery.
  - Linked implementation/evidence lives under `IN-93` and `IN-94`.

- [x] `IN-98` — Check how often we can poll Graph reliably / MS restrictions
  - Polling constraints and tradeoffs documented in the Graph spike.
  - Runtime uses immediate sync on sign-in/start/resume plus normal 5-minute polling, with no tight near-start polling loop.
  - Webhooks/delta optimisations remain future improvements, not Slice 1 blockers.

## Test items to satisfy later

- [x] `IN-85` — Manual recording still works for in-room/ad-hoc use
  - Tested with actual 97 KB .webm recording file (ace1afd2...).
  - Full pipeline: create → upload → process → ready → review → finalise → email.
  - Transcript text is stub (PyannoteAI API not configured), but data flow works.
  - Verified: 2026-06-26 with curl against recording-backed meeting 855eec39.

- [x] `IN-87` — Unregistered speaker stored as anonymous in output
  - Unknown 1 stored with `speaker_known: false` in participants array.
  - Flagged in `unknown_speaker_count` and finalise guard (409).
  - Verified: review endpoint returns participant `{name: "Unknown 1", known: false}`.

- [x] `IN-88` — Per-meeting calendar Record button absent; manual controls and audio setup present
  - Navigation: Home, People, Settings only. No meeting detail/action items UI.
  - HomeScreen: CaptureCard (start/upload), recording status banner, no calendar/recordings cards.
  - Settings → Audio Setup preserved.
  - Verified: `npm run typecheck` + `npm run build` + `git diff --check` all pass.

- [x] `IN-94` — When a transcript is saved it is sent via email attachment to the correct persons
  - Backend accepts email once transcript is saved and pipeline is `ready`.
  - Calendar-linked recipient resolution uses Graph attendee emails, deduped case-insensitively.
  - Manual/ad-hoc recipient resolution falls back to the signed-in recorder email.
  - Renderer automatically emails after the ready poll succeeds and shows transcript emailed / retry states.
  - Verified: email endpoint returns `{recipients: [...], sent_at: ...}`; live smoke returned `joseph@example.com` for a manual recording.


- [x] `IN-81` addendum — installer built and verified (2026-07-07)
  - `Meeting Notetaker-2.0.0-setup.exe` built via `package:win` at `53d7438`; packaged output verified to contain `resources/backend/backend.env`, bundled ffmpeg (`_internal/ffmpeg/ffmpeg.exe`), and `seed-data/voiceprints.json`.
  - Build-chain fixes landed en route: spec `SPECPATH` off-by-one (`f12be83`), `find_ffmpeg` PyInstaller-6 `_MEIPASS` layout (`399e4a5`), smoke test vacuous assertion replaced with real silent-opus fixture asserting `recorder_audio_missing=True` (`53d7438`).
  - Bundle smoke passed on a machine with no PATH ffmpeg — genuine bundled-ffmpeg execution proof.
  - Signed installer + CI release validation remain open (cert pending, E2).

## Remaining open / not yet Jira-closable

- [ ] `IN-64` — Parent Slice 1 handoff
  - Keep open until signed/package rollout, production provider ownership, and stakeholder handoff/comms are complete.

- [ ] `IN-81` — Packaging, signing, and installer update
  - **Implementation complete** (pending Windows build + signed CI release).
  - **A1** (415c391): `MN_DATA_DIR` config + `paths.py` resolver. Dev behavior byte-identical when unset.
  - **A2** (6c95017): replaced all 4 repo-relative path constants with `paths.py` functions. 6 files, 0 import-order traps.
  - **A3** (0c798f5): test isolation via `conftest_env.py` — `MN_DATA_DIR` → temp dir before any `app.*` import. 35 tests pass, `store.json` mtime + checksum unchanged across consecutive runs.
  - **D1+D2** (a552198): SharePoint 401 guard (configured drive + no token → `sharepoint_status=failed` + 401) + `email_notes` ACL (`require(editor)`). 3 new tests.
  - **D3** (887beef): OAuth `state` parameter (16-byte base64url) in MSAL auth code flow. Mismatched state → 404 in callback.
  - **B1** (53b36d1): `run_backend.py` entry point, PyInstaller onedir `.spec`, `requirements-build.txt`.
  - **B2** (4a644cb): `find_ffmpeg()` helper (env → bundled → PATH), replaced both `shutil.which("ffmpeg")` call sites, `third_party/README.md`.
  - **B3** (7f35102): `smoke-backend-bundle.ps1` (start bundle → health poll → upload → pipeline check → ffmpeg check → cleanup), silent webm fixture, Windows build doc, CI `build-backend` job in `release.yml`.
  - **C1** (6f094e3): `extraResources` in `electron-builder.yml`, `package:win` gate script.
  - **C2** (d09e464): backend supervisor (spawn → health poll 20s → restart backoff 1s/5s/25s / max 3 in 5 min → tray alert + error dialog). `before-quit` SIGTERM + 3s force-kill. Dev (`app.isPackaged=false`) untouched.
  - **C4** (5d70e74): `backend.env.template` (placeholders only), `docs/rollout-runbook.md`, supervisor-side `%PROGRAMDATA%` env file parser.
  - **C5a** (c34772b): two-layer credential loading — bundled `backend.env` (base, shipped in installer per plan §3 amendment) then `%PROGRAMDATA%` on top (per-machine override, wins on conflict). Logs paths only. `email_notes` `require()` moved above `_delivery_artifacts()` so 403 returns before any 409 pipeline-state leak.
  - **C5b** (2140a74): `scripts/prepackage.js` copies `backend.env` into bundle staging dir; `MN_ALLOW_STUB_PACKAGE=1` bypass. `.gitignore` guards `backend.env` and `backend/backend.env` from ever being committed.
  - **C5c** (acb6c87): CI `build-backend` job writes `backend.env` from GitHub secrets (`MN_OPENAI_API_KEY`, `MN_PYANNOTE_API_KEY`). `AGENTS.md` exception documented. `rollout-runbook.md` updated: removed manual key step, added key-rotation section.
  - **Remaining for human**:
    - Workstream B build: Windows-side PyInstaller run (`docs/windows-backend-build.md`)
    - Workstream E (external): E1 Blob update-feed URL, E2 code-signing cert, E3 org keys, E4 `GET /audio` auth (deferred), E5 Intune wrap
    - Workstream F: manual verification checklist (see `docs/rollout-runbook.md` sanity checklist)

- [ ] `IN-82` — Confirm PyannoteAI API availability, credentials, and costs for production
  - Development key works. Still needs org-owned account, billing owner, production data/privacy confirmation, and approved secret storage.

- [ ] `IN-86` — Test: Known speaker identified by voiceprint with high confidence
  - Root cause fully established 2026-07-10 (see reconciliation entry above): David's failed job `39336e51` was a diarization collapse on pre-mixed Teams downlink audio (one cluster = whole meeting) with a recorder-only candidate list — the voiceprint matcher correctly refused to name anyone at 0.37 confidence. Cluster-propagation fix (`f501307` + `bb257a1` guard) verified against Test10's real provider output via replay.
  - Blocked on live retest: fresh recording with wired mic (P0 mic-silence mitigation) and/or `MN_PYANNOTE_NUM_SPEAKERS` set to the known count; expansion repo variables must be set for CI builds.

- [ ] `IN-92` — Create F1-wide comms
  - Non-code handoff/comms item; awaiting stakeholder decision on owner, audience, timing, and message.

- [ ] `IN-96` — Communicate with DV and Gabby on Scope/Handover/Comms
  - Non-code stakeholder alignment item; DV/Gabby decisions still needed.

- [ ] `IN-97` — Get org account for Pyannote
  - Development key exists, but production should use an organisation-owned PyannoteAI account and approved billing/secret management.
