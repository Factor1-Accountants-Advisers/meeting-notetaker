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
  - **IN-126 controlling Home scope (Joseph confirmed it supersedes IN-88 for this surface):** navigation is Home/Settings; global meeting search and People navigation are hidden. Required voiceprint enrollment remains an automatic sign-in gate. Home has a "Meeting Title" field, primary manual "Start Recording" action, and secondary existing-audio upload action; Meeting link and Invite team stay removed. Manual sessions register with the same state machine as Graph sessions, which blocks overlapping auto-starts and makes tray Pause/Resume/Stop available. Recording-screen controls remain absent; scheduled auto-stop and Extend 10 min remain auto-recording-only.
  - **IN-120 tray-control scope:** while any recording is active, the tray exposes Pause/Resume and Stop recording; scheduled automatic recordings additionally expose Extend 10 min. Commands cross a dedicated main-to-renderer IPC bridge; the renderer owns media capture and mirrors pause state to refresh the tray label.
  - **IN-117/IN-124 extension repair, code-verified:** renderer button (gated on `scheduledEndUtc`, auto-recordings only) / tray "Extend 10 min" / toast `mn-extend` argv → `extendAutoStop()` = max(scheduled end, now) + 10 min, reschedules auto-stop + reminder timers → `recording:end-extended` → App updates `scheduledEndUtc` → RecordingScreen countdown re-derives. After David's failed retest, an ending reminder now schedules for the five-minute boundary or sends immediately when recording begins inside that window, records structured scheduling/delivery/support logs, and is attempted once per scheduled end. A successful automatic stop returns to Home after handing audio to the processing flow rather than leaving the empty recording route. Windows toast display/button activation and the full installed-app expiry flow still need live retest.
  - **IN-127 verified:** unidentified speakers labelled "Speaker N" in `speaker_matching.py` (initial naming, renumbering, unknown-only paths); remaining "Unknown" strings are schema/mock comments and the `X-MN-User` header default ("Unknown user"), not speaker labels.
  - Verification: `npm run typecheck`, `npm run build`, `npm run verify:graph`, backend unittest discover (64 tests OK), `compileall`, `git diff --check`, and YAML syntax check on `release.yml` — all passed.

- [x] 2026-07-10 — IN-94 follow-up: ad-hoc transcript email double-send fixed
  - David's report: "Adhoc meetings will have email sent to the organizer twice at the same time."
  - Root cause (two defects, both required): (1) `POST /meetings/{id}/email` had **no idempotency guard** — `delivery_status` was written but never read, so any second call sent a second real Graph email; (2) the renderer's post-capture flow conflates email and SharePoint outcomes — when email **succeeded** but SharePoint failed (the steady state on machines whose Graph consent lacks `Files.ReadWrite.All`), the notice enters `email_failed` and its "Retry email" button re-runs `retryTranscriptEmail`, re-sending the already-delivered email. Recipient-list dedupe (IN-119) was never the problem for ad-hoc: recipients resolve to `[recorder]` both before and after that change.
  - Fix (backend, smallest change covering every duplicate trigger path): `email_notes` now replays the original `EmailResult` without sending when `delivery_status=emailed` (recipients + sent_at persisted on the meeting as `delivery_recipients`/`delivery_emailed_at`), 409s while a send is in flight (`emailing`), and only sends again after a genuine `failed` state. `kick_pipeline`'s existing reset to `not_started` clears the replay fields, so re-uploaded/reprocessed meetings email fresh. `reconcile_interrupted_pipelines` now also flips a stale `emailing` (backend died mid-send) to `failed` at startup so the guard can never lock a meeting out of email.
  - Renderer intentionally unchanged: its retry path still calls the endpoint, but the replay makes it side-effect-free; "Retry delivery" after a SharePoint-only failure now retries SharePoint and replays the email result truthfully.
  - Tests: `backend/tests/test_email_idempotency.py` (5 tests, written first, 4-of-5 failed pre-fix): exactly-once send on repeated calls with single audit entry, 409 while in flight, resend allowed after failed, replay fields cleared on delivery reset, stale-`emailing` startup reconcile re-opens retry.
  - Verification: backend unittest discover **56 tests OK**, `npm run typecheck`, `npm run build`, `compileall`, `git diff --check` — all passed. Live retest pending: David's machine, ad-hoc recording with SharePoint failing — expect exactly one email and a working "Retry delivery".

- [x] 2026-07-10 — IN-106 gap closure: LLM prompts now carry all AI Summary Instructions rules
  - Line-by-line comparison of David's "AI Summary instructions" doc (IN-106 attachment) against the build found the minutes template fully implemented but four behavioral rules missing from the prompts: Australian spelling, verb-led action items, disagreement handling ("Unresolved: [A] and [B] had differing views on [X]. To be confirmed."), and Next Meeting extraction (was hardcoded `Date: TBC`).
  - Fix: chunk/reduce system prompts lifted to module constants (`_CHUNK_SYSTEM_PROMPT`/`_REDUCE_SYSTEM_PROMPT` in `llm.py`) now carrying all IN-106 rules; `next_meeting` added to both insight schemas and `SUMMARY_SECTIONS` (flows into plain summary, HTML email, and search); minutes builder renders the extracted `Date:` line and agenda items with template TBC/"None noted" fallbacks (`meetings.py`, `_extract_next_meeting_from_summary`).
  - Tests: `backend/tests/test_minutes_template.py` (7 tests) — next-meeting composition/extraction/rendering + fallbacks, and prompt-rule regression guards pinning the Jira-agreed wording.
  - Verification: backend unittest discover **63 tests OK**, `npm run typecheck`, `npm run build`, `compileall`, `git diff --check` — all passed. Live output check (real OpenAI call producing Australian-spelled, verb-led output) happens with the next build's test meeting.

- [x] 2026-07-15 — IN-131: recording controls restored; long two-track preparation hardened
  - Jira conflict: IN-88 was corrected on 10 July to say tray and ad-hoc recording should not contain manual Start/Stop, leading to removal in `ab06ba2`; IN-120 then restored tray controls only. IN-131 is newer and takes precedence, restoring Pause/Resume/Stop on the active recording screen for manual and scheduled recordings.
  - Screen controls, tray commands, and scheduled automatic stop now invoke one guarded controller. Duplicate Stop is ignored, and the screen switches immediately to an explicit saving/uploading state with no active controls.
  - The reported 77-minute mic and system files were saved locally in full, while synchronous ffmpeg work blocked unrelated backend reads. Audio preparation now runs off FastAPI's event loop and uses a duration-scaled timeout.
  - The merge records input/output byte and duration boundaries. A merged file materially shorter than the client-measured capture duration is rejected before transcription, while the original local and backend track files remain available for retry.
  - Regression coverage: `scripts/verify-recording-controls.tsx` covers active, paused, scheduled, and saving states; `backend/tests/test_long_audio_preparation.py` covers ffmpeg duration parsing, timeout scaling, short-merge rejection, and event-loop responsiveness.
  - Limitation: the exact 13 July source files are not present on this development machine, so provider-side truncation after a complete merge cannot be replayed from the Jira attachment metadata alone.
  - Verification: Graph fixtures, recording-control fixtures, TypeScript typechecks, Electron production build, **69 backend tests**, Python compileall, and `git diff --check` all passed.
  - Installer verification: rebuilt the Windows backend bundle, passed `smoke-backend-bundle.ps1` (health, upload, ready pipeline, bundled ffmpeg), and produced unsigned local test installer `Meeting Notetaker-2.0.5-setup.exe`. SHA-256: `A37C42DF96B66BB04C292AA3773C959FBA50098AFAE11FB6C37F100B2B383C5D`; packaged backend hash matched the smoke-tested bundle.

- [x] 2026-07-16 — IN-468: mid-recording audio device switch no longer silences system capture (`afd105d`)
  - Root cause (live incident, 30-Minute AI Lunch & Learn 16 Jul): WASAPI loopback stays attached to the output device that was default at capture start; AirPods connecting ~2 min in moved Teams audio to the headset and the capture recorded 34 minutes of digital silence with no track `ended`/`muted` event. Pipeline completed "ready" — pyannote correctly transcribed the only ~80 s of real audio.
  - Fix: `capture.ts` re-acquires `getDisplayMedia` on debounced `devicechange` (main-process handler grants loopback without a picker) and records system audio as offset-stamped segments (`SegmentTimeline`, pause-aware); a failed re-acquire keeps the existing capture. Backend accepts `system_segments [{audio_b64, offset_ms}]` and stitches with per-segment `adelay` + `amix` (`_build_segment_merge_filter`). Segment manifest sidecar keeps retry-from-local full-fidelity.
  - Watchdog: RMS silence monitor on a CLONE of the loopback track (recorded track never touches Web Audio per capture.ts header rule); loopback status `silent` + recording-screen warning after 60 s.
  - Regression coverage: `backend/tests/test_system_segment_merge.py` (9 tests incl. real-ffmpeg offset merge: segment at 8 s offset → 10 s output) and `scripts/verify-capture-segments.tsx` (`npm run verify:capture`: pause-aware offset math, silent-loopback warning render).
  - Verification: backend unittest discover **78 tests OK**, `npm run verify:capture`, `npm run verify:recording-controls`, `npm run typecheck`, `npm run build`, `git diff --check` — all passed.
  - Live retest needed with the 2.0.6 build: (1) connect a Bluetooth headset mid-recording → expect `loopback re-acquired after device change` in the log and a full-length transcript; (2) confirm the cloned-track watchdog does not disturb the live capture.
  - Installer verification: rebuilt the Windows backend bundle, passed `smoke-backend-bundle.ps1` (health, upload, ready pipeline, bundled ffmpeg), and produced unsigned local test installer `Meeting Notetaker-2.0.6-setup.exe`. SHA-256: `92C903892DB8B67B569AAC39730F34007347C6378CA8AEA3E72A0F232947BAF3`; packaged backend hash matched the smoke-tested bundle. Delivered exe + zip to the SharePoint Installer-Test folder.

- [x] 2026-07-20 — Packaged backend startup and crash recovery (`2.0.7`)
  - Live failure: Microsoft sign-in succeeded and Joseph's persisted staff record remained enrolled, but the UI displayed the voiceprint gate because no backend owned port 8787. The 2.0.5 main log stopped at `[supervisor] starting` and never reached backend spawn; its initial `fetch` health probe remained pending despite an AbortController timeout.
  - Fix: replaced the Electron main-process `fetch` probe with a Node HTTP request that is forcibly destroyed at a wall-clock deadline. Added explicit recovery when a previously healthy supervised backend exits unexpectedly; intentional app shutdown and startup failures retain their separate paths.
  - Regression verification: `npm run verify:backend-supervisor` proves a healthy 200 response, a server that accepts but never responds is released by the hard deadline, unexpected healthy exits request restart, and intentional shutdown does not.
  - Full verification: Electron typecheck/build, Graph fixtures, recording controls, capture segments, backend supervisor fixtures, and 78 backend tests passed. The bundled backend smoke passed health, upload, ready-pipeline, ffmpeg execution, and cleanup.
  - Installed-app verification: installed 2.0.7 over 2.0.5 with existing AppData preserved. The supervisor spawned the backend, the app's own `/api/v1/people/me` request returned 200, and Joseph's record returned `enrolled: true`. After forcibly terminating the supervised backend process tree, the app logged the unexpected exit, restarted it, reached healthy, and resumed successful meeting API calls.
  - Installer: `Meeting Notetaker-2.0.7-setup.exe`; SHA-256: `39B1FF412568E4512C90A3BCEA59948E89C6769752552D6F4B0BDF8E4DD79C81`.

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

## Slice 2 implementation evidence (IN-375)

- [x] IN-384 — Define and implement structured JSON output schema
  - Canonical versioned export contract (`schema_version` "1.0") in `backend/app/services/meeting_export.py`: pure builder (meeting + segments + summary + action items in, `MeetingExport` out) plus store adapter and refresh hook, so IN-386 can upload without touching the scattered stores.
  - Exact 18-key contract: the 15 IN-384 fields plus `graph_event_id` / `graph_ical_uid` / `graph_online_meeting_id` (per storage brief §2). Slice 1's `online_meeting_id` actually carries the event iCalUId, so it backfills `graph_ical_uid`; `graph_online_meeting_id` stays null until the true Teams id is captured — never substituted.
  - `meeting_type` internal|client from invitee domains (case-insensitive, deterministic internal fallback); invitees kept regardless of RSVP with case-insensitive email dedupe; transcript `start`/`end` in seconds; all timestamps ISO 8601 UTC (validator normalises offsets, rejects naive); `owner_confidence` is the categorical high|medium|low|unknown scale from the long-meeting plan; `key_points`/`follow_ups`/IN-390-owned action fields present-as-null/empty until IN-390.
  - Graph metadata extended end-to-end (raw event → normalise → preload → renderer DTO → backend) with `organizerName`, `scheduledStartUtc`, `description` (bodyPreview), `icalUid`; all optional, old stored metadata still validates.
  - Artifact stored at pipeline-ready in `store.MEETING_EXPORTS` (snapshot key `meeting_exports`, older snapshots load; entries contract-validated on load, corrupt ones dropped), invalidated by `kick_pipeline` on re-upload/retry, refreshed by segment edit / speaker naming / action-item update. Reprocessing now replaces prior pipeline action items instead of accumulating.
  - Codex review rounds addressed: reprocessing invalidation + action-item replacement regression test, strict Literal contract enforcement, snapshot validation, SUMMARY_HTML test isolation, `owner_source` added, `owner_confidence` retyped categorical. `backend/.gitignore` now guards `.venv-win/` and `build/`.
  - Verification: `backend\.venv-win\Scripts\python.exe -m unittest discover -s backend/tests -t backend` (105 tests), `npm run verify:graph`, `npm run typecheck`, `npm run build`, `git diff --check` all pass on native Windows.

- [x] IN-379 — Central voiceprint enrolment through the Storage API seam
  - Shipped: a Storage API client seam (`backend/app/services/storage_api.py`) with a file-backed stub (`var/central-voiceprints.json`) standing in for the real Azure Blob-backed API (IN-471) until it exists, and a `RestStorageApiClient` that speaks the same `CentralEnrolment` contract over HTTP; consent is now required before any enrolment (`consent_confirmed` on `EnrollRequest`, enforced before any provider call) and server-stamped (`consent_recorded_at` set from `datetime.now(timezone.utc)`, never trusted from the client); central registration on enroll with a 502 "retry enrolment" response and no false success when the central write fails (local voiceprint write is not rolled back — by design, matching the plan's rollback-window semantics — but no central record exists and the HTTP response never claims success); a fail-closed `GET /people/me/enrolment-status` endpoint that is the single gate source of truth (missing/whitespace `X-MN-User-Email` header, or any `StorageApiError` from the seam, resolves to not-enrolled rather than erroring) and counts only `status == "active"` central records (a `disabled`/offboarded record does not satisfy the gate); Electron main-process token/email headers (`X-MN-User-Email`, `X-MN-Storage-Token`) attached to enrolment routes in `api-proxy.ts`, with a cold-start ordering fix so the storage token is acquired before the account email is read; a renderer gate (`App.tsx`) that is strict post-cutover (central record required, local-only no longer satisfies it), falls back to local-only pre-cutover, and hardens the enrolment-status fetch with retry; and the enrolment wizard (`EnrollmentModal.tsx`) now uploads the 3 captured clips and shows central-storage consent copy alongside the existing local consent language.
  - Key decisions: cutover between Slice 1 local-only enrolment and Slice 2 central enrolment is config-flagged via `MN_STORAGE_API_URL` (empty/unset ⇒ stub, dev-only, never migrates to the real store; set ⇒ `RestStorageApiClient` against the real Storage API) — no code branch, no separate deploy; the existing 3-clip capture flow is retained unchanged and its clips are what get uploaded, not a new capture path; consent is recorded server-side at the moment of successful enrolment, never accepted as a client-supplied timestamp; the stub file lives at `var/central-voiceprints.json` (`backend/app/paths.py:central_voiceprint_path`), upserted by `person_id`, so re-enrolment/retry replaces the prior record.
  - Known ops gap (packaged env wiring, recorded 21 Jul during Task 5 review, see `docs/superpowers/specs/2026-07-21-in379-enrolment-design.md`): in packaged installs, `backend-supervisor.ts` merges `backend.env` into the *backend subprocess* environment only, while the Electron main process reads `.env.production` via `loadPublicEnv()`. At real cutover, ops must place `MN_STORAGE_API_SCOPE` where the main process reads it and `MN_STORAGE_API_URL` where the backend reads it — `backend.env.template` does not yet mention either variable. This is an operational item for IN-376/IN-471, not a code defect in this slice.
  - Outstanding: an interactive wizard smoke (both the record path and the new upload path, in the real Electron app) still needs a human native run — TestClient/unittest coverage exercises the backend contract but not the renderer capture/upload UI end-to-end; the central-storage consent copy in `EnrollmentModal.tsx` is pending David's review.
  - Item 1 (carry-over fix, TDD): `flag_reenrollment` was the only person-keyed endpoint in `backend/app/routers/people.py` still matching `employee_id` case-sensitively after Task 4's fix to `enroll` — a mixed-case path param 404'd against the lowercase-keyed local registry. Added `test_flag_reenrollment_normalizes_mixed_case_employee_id` to `backend/tests/test_central_enrolment.py` (RED: confirmed 404 against a seeded lowercase person), then added `employee_id = employee_id.strip().lower()` as the first line of the handler body, mirroring `enroll` (GREEN).
  - Verification: `PYTHONPATH=backend backend\.venv-win\Scripts\python.exe -m unittest discover -s backend/tests -t backend -v` (129 tests OK; 128 baseline + 1 new normalisation test), `npm run verify:graph`, `npm run typecheck`, `npm run build`, `git diff --check` all pass.
  - Live HTTP smoke (real `uvicorn`, isolated `MN_DATA_DIR` temp dir, port 8791, dev store never touched — confirmed `backend/var` was not created by this session): (1) `GET /api/v1/people/me/enrolment-status` with no headers → `{"enrolled_locally":false,"centrally_enrolled":false,"central_required":false}`, matching fail-closed + stub-mode expectations; (2) same request with `X-MN-User-Email: smoke@factor1.com.au` → identical payload (person unknown), proving the header route works end-to-end; (3) `POST /api/v1/people/me` then `POST /api/v1/people/smoke@factor1.com.au/enroll` with `consent_confirmed:false` → `422 {"detail":"Consent must be confirmed before voiceprint enrolment"}` (adjusted the request to 3 clips per `EnrollRequest`'s `min_length=3`/`max_length=3`; a literal 1-clip body fails Pydantic list-length validation before reaching the consent guard, which would have proven the wrong boundary); (4) `POST /api/v1/people/Smoke@Factor1.com.au/enroll` (mixed-case) with `consent_confirmed:false` → same 422 consent message, not 404, proving `enroll`'s Task 4 normalisation live; bonus check — `POST /api/v1/people/Smoke@Factor1.com.au/flag-reenrollment` (mixed-case) → `200` with `employee_id:"smoke@factor1.com.au"` and `reenrollment_required:true`, proving Item 1's fix live end-to-end. Smoke process killed and temp `MN_DATA_DIR` deleted afterward.
  - Commit range: `5d953b3..HEAD`.
