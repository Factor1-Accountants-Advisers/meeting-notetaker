# Jira progress ledger

Date started: 2026-06-26
Owner: Joseph Guerrero

This ledger tracks Slice 1 Jira implementation items as we complete and verify them in this repo. It is intentionally evidence-focused so David/Benjamin can map commits back to the plan.

## Current implementation evidence

- [x] v2.0.24 — Dead-mic upload safety net + audio endpoint observer re-land (11 Aug 2026)
  - Spec: `docs/superpowers/specs/2026-08-11-audio-routing-staged-reland-design.md`; plan: `docs/superpowers/plans/2026-08-11-audio-routing-observe-reland.md`. Staged retry of the reverted 4 Aug audio-routing work: this release observes, nothing acts.
  - Backend: a mic track under 1KB with healthy system segments no longer 422s the upload — system audio is stored/merged alone, `recorder_audio_missing` stamped at upload, stale mic track unlinked (field incident: Gabby's 11 Aug recording stuck in a retry loop on `Audio is too short`). Five new tests in `backend/tests/test_system_segment_merge.py` including a real-ffmpeg mic-less merge. `api-proxy` now logs non-ok response bodies so report-problem emails carry error detail.
  - Observer foundation restored verbatim from tag `v2.0.17` (Rust helper, protocol validator, supervisor service) with two adaptations: win32-only start, and a missing helper binary degrades with one warning (fixture-covered). Wired behind `audio-endpoints:get`/`audio-endpoints:changed` IPC; the 10 Aug quit-teardown failsafe in `index.ts` is preserved.
  - New dry-run matcher (`src/renderer/src/lib/audioRoutingDryRun.ts`, fixture `verify:audio-routing-dryrun`): pseudo-device exclusion, blank-label detection, groupId corroboration. Logs one `audio-routing dry-run` JSON line at recording start and per endpoint change while recording — fleet telemetry that validates the v2.0.25 active-routing matcher before it ever controls a stream. Capture behavior untouched; prefs untouched.
  - Settings gains a read-only Windows endpoint section (communications mic/output, mismatch warning, Teams computer-audio guidance). Routing controls stay deferred to v2.0.25.
  - Packaging: helper staged into `native/audio-endpoint-monitor/dist/` (electron-builder no longer walks the cargo target tree — the 4 Aug 213MB installer), release asserts signatures on installer + app + backend + helper outputs (replaces v2.0.17's YAML-regex checker) and guards installer size ≤175MB. New `ci.yml` runs typechecks, fixtures, cargo tests, and the backend pytest suite (one pre-existing flaky concurrency test deselected) on every push/PR — the release job is no longer the first executor of anything.
  - Verified locally: all audio fixtures green, cargo 3/3, packaged helper emits a real four-endpoint snapshot from `dist/win-unpacked/resources/audio/`, backend suites green. Outstanding for release: CI green on push, live Bluetooth smoke on a signed build (spec acceptance §4), tag + FIC ritual + feed verification.

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
  - **IN-124 renderer follow-up (2026-07-29, locally verified):** tray/toast and in-app extensions now update the rendered session and callback ref atomically, and `RecordingScreen` rebases its clock as soon as `scheduledEndUtc` changes. Finishing now leaves the active recording screen immediately, gives processing precedence in the top bar, and disables new Home capture actions until finalization completes. Synthetic Electron QA moved the displayed end from 2:29 pm / 11 min remaining to 2:39 pm / 21 min remaining in one Extend action, then confirmed the Home processing state and disabled controls. The focused recording verifier, every repository `verify:*` script, TypeScript, production build, preview-isolation check, and `git diff --check` passed. Authenticated installed-app toast/tray activation remains pending.
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

- [x] 2026-07-27 — IN-478: duplicate transcript email hardening (delivery-state durability + unconfirmed outcomes)
  - Report (David, 27 Jul, 2.0.7): ad-hoc meeting recorded and stopped via UI; summary email received twice within one minute, both addressed to the recorder only. The IN-94 idempotency guard itself is sound (atomic check, single worker) — the duplicate requires the guard to be re-armed or bypassed between two real sends.
  - Root cause (class): the outcome of a send attempt did not survive the send window. (1) `emailing`/`emailed` were only persisted by the snapshot middleware *after* the response — any backend crash/exit during the send restarted (supervisor auto-restart, 2.0.7) into a fully re-armed `not_started` while the renderer reported "email was not sent"; the startup reconcile's `emailing` branch was unreachable because `emailing` never hit disk. (2) A transport error (timeout, connection drop, 5xx) after Graph may have accepted the message was recorded as definitive `failed` ("resend safe"), so the offered retry sent a second real email.
  - Fix: `email_notes` persists `emailing` to disk before the send and `emailed` immediately after; new `DeliveryStatus.unconfirmed` records ambiguous outcomes (Graph 4xx stays definitive `failed`; timeout/connection/5xx → `unconfirmed`, classified in `GraphEmailProvider._post_send_mail`); startup reconcile flips a stale `emailing` to `unconfirmed` (not `failed`) with a check-your-inbox message; the blocking Graph `urlopen` moved to `asyncio.to_thread` so a slow send no longer stalls `/health` and every other request for up to 30 s. Renderer surfaces the unconfirmed warning (`lib/deliveryNotice.ts`) in the post-capture watcher and retry-email flows instead of "email was not sent" — a resend remains possible but is an informed user choice.
  - Regression coverage: `backend/tests/test_email_idempotency.py` grew a durability class (emailing-on-disk mid-send, emailed-on-disk post-send, unconfirmed transport error, definitive failure, resend-from-unconfirmed, reconcile-to-unconfirmed); new `backend/tests/test_graph_email_classification.py` pins the 4xx/5xx/timeout/connection classification; new `npm run verify:email-notice` pins the renderer message selection.
  - Verification: backend unittest discover **173 tests OK**, `npm run verify:email-notice`, `npm run verify:graph`, `npm run verify:capture`, `npm run verify:recording-controls`, `npm run typecheck`, `npm run build`, `git diff --check`, and a live dev-backend boot + `/health` + `/api/v1/meetings` smoke — all passed.
  - Not addressed here (separate vectors, documented in the audit): `POST /audio` check-then-act across the ffmpeg merge (two concurrent uploads → two pipelines/watchers) and the stale `meeting.model_copy` lost-update in `upload_audio`; neither is reachable from the reported ad-hoc UI flow.
  - **Resolution (27 Jul, David's main.log + his own follow-up):** the log shows exactly one `POST /email` (200 OK, ~0.4 s) for the meeting — the app sent once. The "duplicate" was Outlook's conversation view grouping the Sent Items copy (`saveToSentItems: true`, ad-hoc mail is self-addressed) with the Inbox delivery; turning off conversation view showed a single email. No app defect in this incident. The hardening above stays: it fixes real, test-proven duplicate vectors (dead reconcile branch, false-definitive failures, event-loop stall) found during the investigation. Consider a user-guide note (IN-125 handover doc) that ad-hoc summaries appear twice in conversation view.

- [x] 2026-07-27 — IN-477: sticky 5-minute warning + notification chime
  - Report (David/Ben, repeated in tests): the "ends in 5 minutes" toast is easy to miss — Windows toasts auto-dismiss to the Action Center after ~5 s and Notetaker toasts played no distinctive sound.
  - Fix: the ending-soon toast now uses `scenario="reminder"` (stays on screen until acknowledged) with an explicit Dismiss action alongside Extend 10 min; toast XML construction extracted to pure `src/main/toast-xml.ts`. Both OS toasts (auto-record started, ending-soon) are shown silent and cue the renderer over `notification:chime` IPC to play David's royalty-free alert (`src/renderer/src/assets/notification.wav`, 1.5 s, from the IN-477 attachment) — custom audio in toast XML is not honoured for unpackaged win32 apps, and the window only hides to tray so the renderer playback path stays alive. Extending re-arms a fresh warning for the new end via the existing per-end-timestamp guard.
  - Scope (confirmed with Joseph): sound on the two existing OS toasts only; sticky for the ending-soon warning only. No notes-ready toast (possible follow-up for David), no in-app bell sound. Design: `docs/superpowers/specs/2026-07-27-in477-notification-adjustments-design.md`.
  - Regression coverage: new `npm run verify:toast-xml` pins reminder scenario, silent audio, Extend + Dismiss actions, and XML escaping of meeting titles.
  - Verification: `verify:toast-xml`, `verify:graph`, `verify:recording-controls`, `verify:capture`, `verify:email-notice`, `verify:backend-supervisor`, `npm run typecheck`, `npm run build` (wav bundled into renderer assets), `git diff --check` — all passed. Live check outstanding: hear the chime + see the sticky toast on a packaged build (toastXml behaviour needs the packaged AUMID, not `npm run dev`).

- [x] 2026-07-29 — IN-480: Pause/Stop remain responsive across audio-device changes
  - Report (David, twice on 29 Jul): after AirPods connected and/or the laptop docked, both screen and tray Pause/Stop stopped completing. The incident log recorded device-change loopback reacquisition followed by permanent system-audio silence; later `recording stop requested` entries had no matching `capture stop resolved`, and restart recovery uploaded the spill successfully.
  - Root cause: screen and tray commands correctly converge on the same renderer controller, but that controller treated browser media transitions as infallible. A device-swapped loopback `MediaRecorder` can still report `recording` after its track becomes unusable: `pause()` then throws before App advances the paused session state, while `stopRecorder()` waited forever for an `onstop` event that may never arrive. Concurrent loopback `getDisplayMedia()` reacquisition was also unbounded and not cancellable by Stop. The existing emitted chunks/spill remained valid, explaining why process-restart recovery succeeded.
  - Deterministic pre-fix reproduction: `verify-recording-controls` now starts fake mic + loopback recorders, ends the loopback track, fires a three-event `devicechange` burst, leaves replacement `getDisplayMedia()` unresolved, then requests Pause/Resume/Stop. Before the fix it failed with `Stop hung behind device-change reacquisition`; the stale recorder's Pause also throws in the fixture.
  - Fix: Stop now unregisters/debounces device changes and cancels the active reacquisition generation before snapshotting recorders; replacement acquisition has a 10-second ceiling and releases any stream that resolves after cancellation/timeout. Pause/Resume isolate recorder failures so one stale track cannot block the session transition. Recorder finalisation handles inactive recorders immediately, bounds a missing `onstop` from ended/wedged tracks to 1.5 seconds, and builds the result from all emitted chunks so the unchanged App save/upload path receives the salvageable mic/system audio.
  - Regression coverage: `scripts/verify-recording-controls.tsx` covers the full devicechange-during-recording → partial Pause/Resume → Stop handoff and asserts captured mic audio is returned within the control deadline.
  - Verification: `npm run typecheck`, `npm run verify:recording-controls`, `npm run verify:ad-hoc-attendees`, `npm run build`, and `git diff --check` passed. Live AirPods/dock switching remains a packaged-build retest; the browser failure modes are deterministic in the fixture.

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

- [ ] `IN-383` — SharePoint company context file integration
  - **Implemented 31 Jul** (`in383-context-file` merged `0211625`): provider
    seam `context_file.py` (stand-in `data_root()/context/company-context.md`;
    Graph mode behind `MN_CONTEXT_DRIVE_ID`+`MN_CONTEXT_FILE_PATH`, both empty
    by default), 8000-char cap, single fetch per pipeline run, injected into
    the consolidated reduce system prompt with sanitised delimiters (marker
    literals stripped from content — structural prompt-injection defense,
    review-caught). Enrichment never gates: any failure logs one warning
    (class name only, token-safe) and proceeds identically.
  - 12 focused tests; export schema untouched (1.0).
  - **Completed 31 Jul (pm):** delegated Graph token now threaded end-to-end —
    `api-proxy.ts` attaches `X-MN-Graph-Token` (SharePoint scopes) on the
    pipeline-kicking routes (`isPipelineKickRoute`: POST audio/retry only;
    finalize/blob-retry never re-generate), `upload_audio`/`retry_pipeline`
    forward it into `kick_pipeline`→`run_pipeline`→`get_company_context(token)`.
    Successful Graph reads cached 15 min (`CONTEXT_CACHE_TTL_S`, ticket
    requirement): back-to-back meetings reuse content, a fresh cache entry even
    survives an expired token on long meetings; failures are never cached.
    `backend.env.template` now documents `MN_CONTEXT_DRIVE_ID`/`MN_CONTEXT_FILE_PATH`.
    16 tests (cache hit/expiry/no-poison/token-survival added).
  - **Outstanding:** point `MN_CONTEXT_*` at a real context file and run
    acceptance test `IN-400` live (needs a signed-in app session for the
    delegated token).
- [ ] MSAL token-cache encryption (security triage 30 Jul — no Jira item)
  - **Implemented 31 Jul** (`msal-cache-safestorage` merged `1580637`):
    safeStorage/DPAPI-encrypted `auth/msal-cache.bin` with one-time migration
    from plaintext `msal-cache.json` (legacy deleted post-migration; rollback
    cannot resurrect it), corrupt-cache degradation to signed-out, transient
    DPAPI outage preserves the encrypted file, sign-out clears both forms.
    Pure store pinned by `verify:token-cache` (9 cases). First packaged run
    after upgrade performs the migration.
- [ ] Non-WebM upload blob-delivery gap (surfaced by the 31 Jul hardening drop
  review, needs its own scoped fix): `audio_path_for` stores non-WebM manual
  uploads as `<id>.bin` while blob delivery reads `<id>.webm` — such uploads
  process locally but their audio never reaches the central store.

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
  - **E2 code signing — repo side landed 30 Jul** per DV's Azure Artifact
    Signing brief (email attached to IN-81; account `as-factor1`, profile
    `cp-private-factor1`, endpoint `eus.codesigning.azure.net`, **Private
    Trust** — unmanaged machines are expected to warn until IT pushes the
    root via Intune): electron-builder upgraded 25.1.8 → 26.15.3 (first
    version with `azureSignOptions`; base-config `--dir` smoke green, signing
    correctly skipped locally), new `electron-builder.azure.yml` (extends
    base; signs inner binaries + NSIS installer, RFC3161 timestamp pinned to
    `timestamp.acs.microsoft.com` per DV — short-lived certs), `release.yml`
    signs via azure/login OIDC (`id-token: write`, no stored secret) and
    asserts signature + signer subject + timestamp on both the setup exe and
    the app exe (chain check deliberately skipped — Private Trust root absent
    on runners). Azure-config packaging smoke reached the Invoke-TrustedSigning
    call and failed only on missing local credentials — expected.
    **Remaining before a signed release:** Entra app registration + federated
    credential for this repo's Actions OIDC → send client ID to DV for the
    "Artifact Signing Certificate Profile Signer" role grant; repo secrets
    `AZURE_SIGNING_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID`;
    then tag a 2.0.x and hand the signed installer to DV/Gabby for Intune
    validation.
  - **Remaining for human**:
    - Workstream B build: Windows-side PyInstaller run (`docs/windows-backend-build.md`)
    - Workstream E (external): E1 Blob update-feed URL, ~~E2 code-signing cert~~ (repo side done 30 Jul, see above; role grant + secrets pending), E3 org keys, E4 `GET /audio` auth (deferred), E5 Intune wrap
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

- [ ] `IN-469` — Auto-update via HTTPS Blob feed
  - Implementation landed on `in469-auto-update` (30 Jul): pure idle-gate predicate (`update-gate.ts`) with verify:update-gate truth table (~30 assertions incl. the stale-past-start regression case); updater lifecycle — launch + 4h checkForUpdates, tray "Restart to update" item + toast prompt (mn-update-restart/defer argv), 5-min idle poll gated on recording state, pending/imminent auto-start (15-min lead, 2-min grace), backend pipeline busy probe (fail-safe to busy), 300s system idle, 4h snooze; 60s deferrable countdown then silent quitAndInstall(true,true) via a single reentrancy-guarded, exception-safe choke point; publisherName verification (lives under `publish`, not `win` — the installed electron-builder schema only accepts it there or nested under win.signtoolOptions/azureSignOptions); CI publish step (two az uploads, self-skips while publish.url is REPLACE_ME).
  - Gates: typecheck, verify:update-gate, verify:toast-xml, verify:recording-controls, build — all green.
  - **Provisioned 31 Jul (JG, per Jira recommendation):** `stf1nt` account flag `allowBlobPublicAccess=true` enabled; public-read `updates` container created (anonymous HTTPS read verified with a probe blob, then removed) — the only public container on the account, private containers untouched. `publish.url` → `https://stf1nt.blob.core.windows.net/updates/`; repo variable `UPDATES_STORAGE_ACCOUNT=stf1nt` set. Bicep source of truth updated in notetaker-storage-api `infra/main.bicep` (updates container + conditional `releasePublisherPrincipalId` role assignment).
  - **v2.0.8 RELEASED 31 Jul (run 30598210878): signed, published, feed verified live** — latest.yml v2.0.8 + 162,687,080-byte installer on the feed, byte-exact match; CI asserted signature subject factor1.com.au + RFC3161 timestamp. Both external grants landed 30-31 Jul (DV signer role; David's Storage Blob Data Contributor on stf1nt/updates, verified).
  - Release-day findings, fixed in the same cycle: (1) pinned-ffmpeg URL 404'd — moved to gyan.dev's immutable GitHub mirror (GyanD/codexffmpeg) with the hash of the verified archive (the first pinned hash was of a 404 page: curl without `-f` saves error pages — hash what you actually verified); (2) **federated credential wildcard trap:** a plain FIC `subject` of `...:ref:refs/tags/v*` matches LITERALLY, never as a wildcard (AADSTS700213), and this tenant rejects flexible claimsMatchingExpression credentials — so the subject is pinned per release. **TAGGING RITUAL: before pushing a new vX.Y.Z tag, PATCH the `github-release-v2-0-8` credential subject on app `5e1334af-…` to the new tag ref** (az rest PATCH …/federatedIdentityCredentials/github-release-v2-0-8 with `{"subject": "repo:Factor1-Accountants-Advisers/meeting-notetaker:ref:refs/tags/vX.Y.Z"}`), or ask IT to enable flexible FICs for a true v* wildcard.
  - Remaining for Done: fleet manual install of 2.0.8 (last-ever manual install), then live auto-update E2E on the next tag (detect → verify publisher → idle install). Jira transitions (IN-81, IN-469) = Joseph after E2E.

## Slice 2 implementation evidence (IN-375)

- [x] IN-384 — Define and implement structured JSON output schema
  - Canonical versioned export contract (`schema_version` "1.0") in `backend/app/services/meeting_export.py`: pure builder (meeting + segments + summary + action items in, `MeetingExport` out) plus store adapter and refresh hook, so IN-386 can upload without touching the scattered stores.
  - Exact 18-key contract: the 15 IN-384 fields plus `graph_event_id` / `graph_ical_uid` / `graph_online_meeting_id` (per storage brief §2). Slice 1's `online_meeting_id` actually carries the event iCalUId, so it backfills `graph_ical_uid`; `graph_online_meeting_id` stays null until the true Teams id is captured — never substituted.
  - `meeting_type` internal|client from invitee domains (case-insensitive, deterministic internal fallback); invitees kept regardless of RSVP with case-insensitive email dedupe; transcript `start`/`end` in seconds; all timestamps ISO 8601 UTC (validator normalises offsets, rejects naive); `owner_confidence` is the categorical high|medium|low|unknown scale from the long-meeting plan; `key_points`/`follow_ups`/IN-390-owned action fields present-as-null/empty until IN-390.
  - Graph metadata extended end-to-end (raw event → normalise → preload → renderer DTO → backend) with `organizerName`, `scheduledStartUtc`, `description` (bodyPreview), `icalUid`; all optional, old stored metadata still validates.
  - Artifact stored at pipeline-ready in `store.MEETING_EXPORTS` (snapshot key `meeting_exports`, older snapshots load; entries contract-validated on load, corrupt ones dropped), invalidated by `kick_pipeline` on re-upload/retry, refreshed by segment edit / speaker naming / action-item update. Reprocessing now replaces prior pipeline action items instead of accumulating.
  - Codex review rounds addressed: reprocessing invalidation + action-item replacement regression test, strict Literal contract enforcement, snapshot validation, SUMMARY_HTML test isolation, `owner_source` added, `owner_confidence` retyped categorical. `backend/.gitignore` now guards `.venv-win/` and `build/`.
  - Verification: `backend\.venv-win\Scripts\python.exe -m unittest discover -s backend/tests -t backend` (105 tests), `npm run verify:graph`, `npm run typecheck`, `npm run build`, `git diff --check` all pass on native Windows.

- [ ] IN-390 — Consolidate summarisation and action extraction into structured output
  - Implemented on `codex/in-390-output-consolidation` in `6f857a1`: the pipeline now invokes one provider `generate()` path and receives one strict Pydantic `StructuredMeetingOutput` containing the summary, discussion/decision/follow-up lists, and enriched action items. The OpenAI map and reduce stages both request strict JSON-schema responses; the final object requires `schema_version` and rejects missing, unknown, or unsupported contract fields.
  - The canonical IN-384 export remains `schema_version` `"1.0"` because no external field was added, removed, or renamed. IN-390 now populates the existing `key_points`, `follow_ups`, and action metadata fields (`owner_email`, `owner_confidence`, `owner_source`, `action_type`, `assigned_to`, `assigned_to_department`) instead of leaving them empty/null. Post-ready edits preserve the LLM-only lists while refreshing mutable transcript/action data.
  - Plain-text summary, HTML email, SharePoint minutes, editable action items, and Blob JSON are deterministic projections of the same validated output. The unconfigured-provider response remains the explicit `Summary unavailable — configure MN_OPENAI_API_KEY.` stub with no HTML or actions, and recipient-facing section headings/formatting are unchanged.
  - Verification: 45 focused structured-output/minutes/export tests passed; the full backend suite passed `282` tests with one ffmpeg-dependent skip; `python -m compileall app`, `npm run typecheck`, and `git diff --check` passed. Live OpenAI, Graph, Storage API, MSAL, Blob, and SharePoint verification remains out of scope for this branch and belongs on the work machine after review/merge.
  - **Completed 31 Jul (pm):** `meeting_type` now applied to generation, closing the last ticket clause — the Slice 1 internal/client classification is derived *before* the LLM call (`derive_meeting_type`, shared with the export builder so prompt and artifact can never disagree) and rides the reduce payload as a data field (never prompt-string concat; transcript content cannot impersonate it), with register guidance in `_REDUCE_SYSTEM_PROMPT`. Gating fix: the export's `if metadata else "internal"` shortcut is gone — a manual-attendee meeting with an external picker email now classifies `client` in both prompt and artifact.
  - **Live smoke 31 Jul (pm): PASSED** — real OpenAI strict-schema consolidated generation (`gpt-4o`, `json_schema` strict) with `meeting_type="client"` + company context block: valid `schema_version 1.0`, zero quality flags, correct decisions/unresolved/next-meeting/action extraction. (Model wrote a wrong due-date year on a synthetic transcript — an LLM quirk to watch, not a contract failure.)

- [x] IN-389 — Define transcript and speaker identity merge approach (31 Jul)
  - The merge itself has been implemented since Slice 1 (IN-69/79/80/86 markers) but nothing documented it and the repo had zero `IN-389` references; the concrete numbers lived only in code comments.
  - **Definition ratified:** `docs/decisions/2026-07-31-in389-transcript-speaker-identity-merge.md` — turn-level inputs, three merge gates (raw-cluster match; ≥800 ms overlap; ≥0.62 confidence with `None` passing ungated), largest-overlap winner, 0.85 expansion pass, 0.5-fraction cluster propagation, unknown-reason taxonomy, and the complete `speaker_source` taxonomy. Includes the word-level-vs-turn-level deviation note.
  - **Implementation gap closed:** manual naming (`POST /meetings/{id}/name-speaker`) now stamps `speaker_source="user_corrected"` (promised by the schema comment and the Slice 1 plan, never set), clears `speaker_confidence` and the stale `unknown_reason`; flows into the export. Test added.

- [x] IN-379 — Central voiceprint enrolment through the Storage API seam
  - Shipped: a Storage API client seam (`backend/app/services/storage_api.py`) with a file-backed stub (`var/central-voiceprints.json`) standing in for the real Azure Blob-backed API (IN-471) until it exists, and a `RestStorageApiClient` that speaks the same `CentralEnrolment` contract over HTTP; consent is now required before any enrolment (`consent_confirmed` on `EnrollRequest`, enforced before any provider call) and server-stamped (`consent_recorded_at` set from `datetime.now(timezone.utc)`, never trusted from the client); central registration on enroll with a 502 "retry enrolment" response and no false success when the central write fails (local voiceprint write is not rolled back — by design, matching the plan's rollback-window semantics — but no central record exists and the HTTP response never claims success); a fail-closed `GET /people/me/enrolment-status` endpoint that is the single gate source of truth (missing/whitespace `X-MN-User-Email` header, or any `StorageApiError` from the seam, resolves to not-enrolled rather than erroring) and counts only `status == "active"` central records (a `disabled`/offboarded record does not satisfy the gate); Electron main-process token/email headers (`X-MN-User-Email`, `X-MN-Storage-Token`) attached to enrolment routes in `api-proxy.ts`, with a cold-start ordering fix so the storage token is acquired before the account email is read; a renderer gate (`App.tsx`) that is strict post-cutover (central record required, local-only no longer satisfies it), falls back to local-only pre-cutover, and hardens the enrolment-status fetch with retry; and the enrolment wizard (`EnrollmentModal.tsx`) now uploads the 3 captured clips and shows central-storage consent copy alongside the existing local consent language; the gate now excludes people flagged for re-enrolment (`reenrollment_required`) from `enrolled_locally` so a flagged person can no longer pass the pre-cutover gate on stale local enrolment.
  - Key decisions: cutover between Slice 1 local-only enrolment and Slice 2 central enrolment is config-flagged via `MN_STORAGE_API_URL` (empty/unset ⇒ stub, dev-only, never migrates to the real store; set ⇒ `RestStorageApiClient` against the real Storage API) — no code branch, no separate deploy; the existing 3-clip capture flow is retained unchanged and its clips are what get uploaded, not a new capture path; consent is recorded server-side at the moment of successful enrolment, never accepted as a client-supplied timestamp; the stub file lives at `var/central-voiceprints.json` (`backend/app/paths.py:central_voiceprint_path`), upserted by `person_id`, so re-enrolment/retry replaces the prior record.
  - Known ops gap (packaged env wiring, recorded 21 Jul during Task 5 review, see `docs/superpowers/specs/2026-07-21-in379-enrolment-design.md`): in packaged installs, `backend-supervisor.ts` merges `backend.env` into the *backend subprocess* environment only, while the Electron main process reads `.env.production` via `loadPublicEnv()`. At real cutover, ops must place `MN_STORAGE_API_SCOPE` where the main process reads it and `MN_STORAGE_API_URL` where the backend reads it — `backend.env.template` does not yet mention either variable. This is an operational item for IN-376/IN-471, not a code defect in this slice.
  - Outstanding: an interactive wizard smoke (both the record path and the new upload path, in the real Electron app) still needs a human native run — TestClient/unittest coverage exercises the backend contract but not the renderer capture/upload UI end-to-end; the central-storage consent copy in `EnrollmentModal.tsx` is pending David's review, including pyannote-side retention — clips are uploaded to the provider's media store under voiceprint-samples/… during voiceprint creation; the copy's "deleted immediately" claim covers the app side only.
  - Item 1 (carry-over fix, TDD): `flag_reenrollment` was the only person-keyed endpoint in `backend/app/routers/people.py` still matching `employee_id` case-sensitively after Task 4's fix to `enroll` — a mixed-case path param 404'd against the lowercase-keyed local registry. Added `test_flag_reenrollment_normalizes_mixed_case_employee_id` to `backend/tests/test_central_enrolment.py` (RED: confirmed 404 against a seeded lowercase person), then added `employee_id = employee_id.strip().lower()` as the first line of the handler body, mirroring `enroll` (GREEN).
  - Verification: `PYTHONPATH=backend backend\.venv-win\Scripts\python.exe -m unittest discover -s backend/tests -t backend -v` (129 tests OK; 128 baseline + 1 new normalisation test), `npm run verify:graph`, `npm run typecheck`, `npm run build`, `git diff --check` all pass.
  - Live HTTP smoke (real `uvicorn`, isolated `MN_DATA_DIR` temp dir, port 8791, dev store never touched — confirmed `backend/var` was not created by this session): (1) `GET /api/v1/people/me/enrolment-status` with no headers → `{"enrolled_locally":false,"centrally_enrolled":false,"central_required":false}`, matching fail-closed + stub-mode expectations; (2) same request with `X-MN-User-Email: smoke@factor1.com.au` → identical payload (person unknown), proving the header route works end-to-end; (3) `POST /api/v1/people/me` then `POST /api/v1/people/smoke@factor1.com.au/enroll` with `consent_confirmed:false` → `422 {"detail":"Consent must be confirmed before voiceprint enrolment"}` (adjusted the request to 3 clips per `EnrollRequest`'s `min_length=3`/`max_length=3`; a literal 1-clip body fails Pydantic list-length validation before reaching the consent guard, which would have proven the wrong boundary); (4) `POST /api/v1/people/Smoke@Factor1.com.au/enroll` (mixed-case) with `consent_confirmed:false` → same 422 consent message, not 404, proving `enroll`'s Task 4 normalisation live; bonus check — `POST /api/v1/people/Smoke@Factor1.com.au/flag-reenrollment` (mixed-case) → `200` with `employee_id:"smoke@factor1.com.au"` and `reenrollment_required:true`, proving Item 1's fix live end-to-end. Smoke process killed and temp `MN_DATA_DIR` deleted afterward.
  - Commit range: `5d953b3~1..HEAD` (i.e. 5d953b3 through HEAD inclusive).

- [ ] IN-476 — Cut desktop enrolment over to the authenticated Storage API using Entra object IDs
  - Implemented on `codex/in-476-desktop-cutover`: Electron main now extracts the signed-in account's Entra `oid`, preserves the existing cold-cache email/display-name behavior, and attaches `X-MN-User-Email`, `X-MN-User-Oid`, and `X-MN-Storage-Token` only to the exact enrolment-status and enrolment routes. The renderer still receives no token or identity claim.
  - FastAPI keeps email as the local `PersonEnrollment.employee_id` key and uses OID for the central `/api/v1/voiceprints/{person_oid}` path and `CentralEnrolment.person_id`. Missing OID/token and a path/header email mismatch fail before Pyannote work; the live Storage API remains the final self-or-admin authorization boundary.
  - Packaged production defaults now carry the exact unique Function hostname and delegated scope through Electron main into the backend child. `MN_STORAGE_API_ENABLED=false` is the explicit rollback switch; environment overrides retain precedence and no secret, Blob credential, connection string, or SAS was added.
  - TDD evidence: `scripts/verify-storage-cutover.ts` first failed on missing policy/config exports, then passed after the pure request, OID, header, rollback, public-default, and custom-resource force-refresh policies were implemented. `backend/tests/test_central_enrolment.py` first failed on the missing OID route/config fields, then passed with 33 focused tests after the email-local/OID-central cutover and pre-provider guards.
  - Authenticated smoke exposed one missed IN-475 provisioning value before release: the Storage API app registration's `api.requestedAccessTokenVersion` was `null`, so Entra issued a v1 token while the server validates the v2 issuer. The app registration was corrected to `2` on 23 July 2026; the existing `access_as_user` scope and desktop pre-authorization were read back unchanged. Electron now force-refreshes this custom-resource token so a cached v1 token cannot survive the correction.
  - Authenticated production read smoke (exact desktop registration and persisted desktop MSAL account, no token/OID/voiceprint logged): refreshed token had v2 issuer, expected API audience and tenant, desktop authorized-client id, `oid`, and `access_as_user`; `GET /api/v1/voiceprints/{own_oid}` returned the expected `404` for no existing record rather than `401`, correlation `in476-desktop-cutover-smoke-v2-20260723`. A fresh native Electron restart then silently acquired the Storage API token, routed `GET /api/v1/people/me/enrolment-status` through the isolated backend (`200`), and displayed the signed-in user's required voiceprint wizard. No production PUT was run; write smoke remains separately approval-gated.
  - Automated verification: `npm run verify:storage-cutover`, `npm run verify:graph`, `npm run typecheck`, `npm run build`, the full isolated backend suite (`138 tests`), and `git diff --check` pass.

- [ ] IN-378 — Retrieve meeting-scoped voiceprints for speaker identification
  - Implemented on `codex/in-378-meeting-voiceprints`: Electron main now treats only meeting audio upload/retry as Storage API-token routes, preserving the renderer → preload → main → FastAPI boundary and leaving ordinary meeting reads local. FastAPI accepts `X-MN-Storage-Token` and normalized `X-MN-User-Email` only on those processing requests and forwards them exclusively in memory to the background task; neither value is persisted in the meeting snapshot or exposed to the renderer.
  - The Storage API seam now implements the additive batch contract (`POST /api/v1/voiceprints/meeting-candidates`) in both REST and file-backed stub clients. Candidate construction is bounded to 50 and ordered invitees → organizer → recorder → configured controlled expansion, with trim/case-fold normalization and first-source de-duplication.
  - A successful central response is authoritative, including an empty record list, so stale local data cannot revive a centrally missing/disabled/deleted enrolment. Central records are adapted in memory to the existing Pyannote matcher; no voiceprint/token/OID is logged or persisted. A central failure may use only relevant local candidates and records that degraded count without identities; when no safe local candidate exists, processing becomes retryable-failed and the saved audio remains intact.
  - Enrolment writes now include the normalized local employee email for faithful stub behavior; the live server independently stamps self emails from the validated token. The matcher accepts an injected candidate list while retaining legacy repository loading only when central cutover is disabled.
  - TDD evidence: route-policy assertions first failed until audio/retry were authorized for Storage API identity; client tests first failed on the absent batch models/method; resolver tests first failed on the absent service; matcher injection first failed on the absent argument; processing route/pipeline tests first failed on absent header/task propagation. Production-readiness review added strict error classification, exact capped fallback, malformed-index handling, and restored the approved source-preserving `{email, source}` shape for `missing`.
  - Local verification: full isolated backend suite `159 tests` passed; Storage API full suite `137 tests` plus Ruff passed; `npm run verify:storage-cutover`, `npm run verify:graph`, `npm run typecheck`, `npm run build`, contract-mirror SHA-256 comparison, and `git diff --check` all passed.
  - Release evidence: Storage API merge `a0e84a2` was pushed to `main`; GitHub CI run `30056253890` and OIDC production Deploy run `30056253903` both succeeded. Production `/health/live` and `/health/ready` returned 200. The exact desktop registration and delegated scope then called the IN-378 POST with a generated meeting UUID and the signed-in user as the sole recorder candidate; it returned 200 with `records=0`, `missing=1`, correlation `in378-meeting-candidates-smoke-20260724003059`. No token, OID, email, or voiceprint material was printed or recorded, and no production mutation ran.
  - Trust decision: Joseph accepted the bounded employee-trust model on 24 Jul 2026. The submitted meeting UUID/candidates remain authenticated caller assertions, consistent with manual/ad-hoc recordings whose participant lists are user-entered. Live Jira contains no requirement for server-verifiable meeting membership, so stronger object authorization is deferred unless a future Jira or security requirement introduces it.
  - Ad-hoc attendee follow-up implemented on `codex/ad-hoc-attendee-picker`: Home now has an optional "People attending" picker for both live manual capture and existing-audio upload. It suggests locally known enrolled staff and accepts an exact typed work email when the local directory is unavailable. Selection is capped at 49 so the recorder still fits within the Storage API's 50-candidate contract.
  - Manual attendees persist separately from Graph metadata as trusted speaker-identification hints. They are added before the recorder and controlled expansion in both central and legacy-local voiceprint resolution, using the existing contract source `invitee`. They do not grant meeting access and do not become email recipients; the ad-hoc recorder-only delivery rule remains covered by regression tests.
  - Canonical structured output includes selected manual attendees in `full_invitee_list` while retaining the deterministic `internal` fallback for non-Graph meetings. Scheduled Graph meetings continue to use their authoritative Graph attendee/organiser metadata unchanged.
  - TDD/verification evidence: attendee persistence/validation, candidate ordering/deduplication, legacy fallback, structured output, and delivery isolation tests were added; the renderer verification covers filtering, enrollment eligibility, normalization, duplicate suppression, typed-email fallback, the 49-person cap, selected chips, and disabled state. Fresh full verification passed: `164` backend tests, `npm run verify:ad-hoc-attendees`, `npm run verify:storage-cutover`, `npm run verify:graph`, `npm run verify:recording-controls`, `npm run typecheck`, `npm run build`, and `git diff --check`.
  - Commits: `9a7faf8` (persist manual attendees), `3945aa2` (voiceprint candidate wiring), `71de41d` (structured output/delivery isolation), `6bd689b` (desktop picker and propagation). A native authenticated UI smoke remains the final manual check after integration; no Jira transition or production write was performed from this branch.

- [ ] IN-381 — Voiceprint audit logging
  - Implemented in the Storage API worktree
    `codex/in-381-voiceprint-audit`. The existing IN-378
    meeting-candidate retrieval is now the genuine `voiceprint_used` point:
    one immutable event per returned active person OID, with only the meeting
    UUID and server UTC date. Ordinary enrolment-status/self GETs remain
    unaudited.
  - Existing central PUTs now classify exact `voiceprint_created`,
    `voiceprint_disabled`, `voiceprint_deleted`, and `voiceprint_updated`
    actions. The responsible actor comes only from validated Entra claims.
    IN-381 adds no disable/delete management workflow or offboarding
    automation; those remain IN-380/IN-382.
  - The authenticated admin view is the additive, read-only
    `GET /api/v1/voiceprints/audit-events` contract: exact
    `StorageApi.Admin`, 31-day maximum UTC range, 1–100 page size, opaque
    filter-bound cursor, 10,000-offset cap, and optional exact
    action/person/meeting filters. Daily JSONL is read backward in 64-KiB
    ranges with a 32-MiB per-request scan ceiling. A desktop admin screen
    remains IN-380, so no renderer/preload/Electron/FastAPI desktop runtime
    code changed.
  - Audit JSONL remains server-written and append-only. Recursive write/read
    guards reject token, authorization, SAS, email, embedding, raw-audio, and
    voiceprint detail keys; malformed or privacy-invalid historical lines fail
    closed. The field-by-field review found no raw voiceprints, tokens,
    employee email lists, embeddings, or audio in any event or response.
  - Independent review removed unnecessary prior-status details and replaced
    whole-day downloads with bounded ranged reads. The existing v1
    record/index write and audit append remain separate Blob operations; a
    durable cross-blob outbox would be an IN-377 storage-contract change.
  - Verification: Storage API full suite `181 passed` plus Ruff; desktop full
    backend suite `164 tests`; `npm run verify:storage-cutover`,
    `npm run verify:graph`, `npm run typecheck`, `npm run build`, contract
    byte comparison, and `git diff --check` in both repositories passed.
  - The source contract and this repository's mirror are byte-identical, and
    the stale §3 `require_admin` sentence is corrected. No Jira change,
    merge, push, deployment, production write, or production smoke was
    performed.

- [x] IN-385 — Deliver transcript and summary as separate SharePoint files
  - Commit `b81fa98` on `codex/in-385-two-file-delivery` splits the existing
    combined SharePoint artifact into deterministic
    `Title-YYYY-MM-DD.txt` (transcript only) and
    `Title-YYYY-MM-DD-summary.txt` (summary/minutes plus action items). The
    existing `sharepoint_web_url` contract continues to point to the transcript;
    the audit entry records both uploaded URLs.
  - **Naming reconciled to the ticket convention 31 Jul (pm):** the pair is now
    `YYYY-MM-DD Title - Transcript.md` / `YYYY-MM-DD Title - Summary.md`
    (date-first, `.md`, per the IN-385 ticket text and the IN-387 design spec —
    the interim `Title-date.txt` continuity choice was never recorded as a
    decision, so the documented convention wins). Shared `_filename_basis`
    keeps the pair drift-proof and retry-deterministic (UTC `created_at` date,
    IN-387 orphan-file rule preserved); upload Content-Type now
    `text/markdown`. The distinct summary URL is now first-class:
    `Meeting.sharepoint_summary_url` recorded on success beside
    `sharepoint_web_url` (transcript). Tests updated + convention pinned.
  - **Outstanding:** live two-file delivery smoke (IN-398 scenario needs a
    signed-in app session for the delegated Graph token; next test meeting
    covers it).
  - Both files receive the IN-387 owner-implicit plus Graph `grant_view`
    (`read`, `requireSignIn`) treatment in the same delivery attempt. Any
    first/second upload or grant failure, including an HTTP-200 partial grant
    on the summary file, is classified with the IN-391 taxonomy and leaves
    `sharepoint_status=failed`; retry re-runs the deterministic pair.
  - The unconfigured-drive local locked-folder provider now receives the same
    two artifacts. Coverage pins content separation, stable paired naming,
    both grants, second-upload failure, second-file partial-grant failure, and
    stand-in behavior in `test_delivery_reliability.py` and
    `test_sharepoint_provider.py`.
  - Verification (30 Jul 2026): focused SharePoint suite 32 tests, OK; backend
    `python -m unittest discover` from `backend/` 279 tests, OK (1 skipped);
    `python -m compileall app`, `npm run verify:graph`,
    `npm run typecheck`, `npm run build`, and `git diff --check` passed. The
    known stub-concurrency flake did not reproduce. Live two-person library
    and read-only access verification remains the work machine's IN-398
    execution and was not performed here.

- [x] IN-387 — Define SharePoint library structure and provisioning
  - **Implemented (see `docs/superpowers/specs/2026-07-28-in387-sharepoint-library-design.md`):**
    site/library identified as `futurebusinessgroup.sharepoint.com/sites/InnovationsandSystems`,
    library `Transcriptions` (per IN-91's 3 Jul comment thread, which settled on
    continuing with the existing directory rather than provisioning a new one),
    flat folder structure (library root, no subfolder), and an
    owner-implicit/invitee-view permission model: the recorder already has
    access as the uploading identity, and `GraphSharePointProvider.grant_view`
    (Graph `POST /items/{id}/invite`, `roles: ["read"]`, `requireSignIn: true`)
    grants read-only view access to everyone else. `grant_view` is wired
    directly into `save_transcript_to_sharepoint`'s existing upload/retry path
    (`backend/app/routers/meetings.py`) immediately after the upload succeeds,
    inside the same try/except — so a grant failure marks the whole delivery
    `failed` (not a partial "uploaded but ungranted" state) and a retry re-runs
    both the upload and the grant from scratch
    (`test_sharepoint_grant_failure_marks_whole_delivery_failed_and_retry_recovers`).
    Recipients come from a new `_sharepoint_recipients(meeting)` resolver:
    calendar-linked recordings use Graph attendee emails plus the organiser
    (mirroring the IN-94/IN-119 email-recipient gap fix, since Graph's
    `attendees` array excludes the organiser); manual/ad-hoc recordings use the
    recorder's ad-hoc attendee-picker selections instead. The
    `sharepoint_folder_path` default now resolves to the library root instead
    of a subfolder (`backend.env.template` updated to match, with the old
    `Notetaker Transcripts` example removed so it can't be silently
    reintroduced).
  - **Also shipped, not in the original written plan (added mid-implementation
    from a code review finding):** `GraphSharePointProvider.grant_view` now
    parses the Graph `invite` response body and raises if the returned
    `value` list contains fewer granted recipients than were requested — a
    partial-success `200` is treated as a failure, not silently accepted
    (`test_graph_provider_grant_view_raises_when_response_grants_fewer_than_requested`
    in `test_sharepoint_provider.py`). Without this, a partial Graph grant
    would report `saved` while some recipients silently had no access, which
    is what actually makes the atomic retry guarantee above sound end to end.
  - **Verification:** full backend suite —
    `PYTHONPATH=backend backend/.venv/Scripts/python.exe -m unittest discover
    -s backend/tests -t backend -v` — **242 tests, OK** (28 Jul 2026, this
    task). One test, `test_stub_serializes_concurrent_exports_for_one_meeting`
    (`test_storage_api_meetings.py`), is a known pre-existing,
    non-deterministic concurrency-timing flake unrelated to IN-387; it passed
    on this run but may or may not fail on any given run — a future failure of
    just that test is not evidence IN-387 broke something. IN-387-specific
    coverage: `test_sharepoint_provider.py` (Graph/local provider upload,
    library-root default, grant-view success/no-token/empty-recipients/
    partial-grant-rejection), `test_sharepoint_recipients.py`
    (`_sharepoint_recipients` calendar/organiser/manual-attendee resolution),
    and `test_delivery_reliability.py` (atomic save+grant success, grant
    failure marking the whole delivery failed, and retry recovery).
  - **Resolved 29 Jul 2026 (spec's Scope items 5-6, previously the open
    tail):** (5) the real `Transcriptions` library's Graph drive ID was
    discovered (`GET /sites/{hostname}:/sites/InnovationsandSystems:/drives`,
    matched by `name == "Transcriptions"`) and is now the committed
    `sharepoint_drive_id` default in `backend/app/config.py` — a non-secret
    identifier, same class as the committed Storage API URL;
    `backend.env.template` documents the override. (6) a live delegated-token
    delivery against the real library succeeded at 08:17 AEST on 29 Jul 2026:
    meeting `0d2d3086-2451-49d6-9362-20ed47a8babb` reached
    `sharepoint_status=saved` with `sharepoint_web_url=
    https://futurebusinessgroup.sharepoint.com/sites/InnovationsandSystems/
    Transcriptions/Test-2026-07-29.txt` and no delivery errors in `main.log`.
    Verification of the committed default: `test_sharepoint_provider.py` +
    `test_sharepoint_recipients.py` 19/19 OK; full backend suite 245 tests
    with only the documented pre-existing
    `test_stub_serializes_concurrent_exports_for_one_meeting` flake failing —
    confirmed failing identically with the change stashed, so it is not
    caused by the drive-ID default.
  - **Remaining live caveat:** the 29 Jul smoke was a solo test meeting, so
    `grant_view` to *other* recipients has unit coverage only. The IN-398
    acceptance test (second invitee opens the file read-only) is the
    outstanding live verification of the permission model — it needs a
    two-person meeting, not additional voiceprints.

- [x] IN-386 — Deliver processed meeting JSON and audio to private Blob storage
  - **Server contract reviewed, not changed here:** the Storage API branch
    `in386-meeting-blob-delivery` was reviewed at `4dc0736` and remains
    unmerged and undeployed. Its `docs/jira-progress.md` already records the
    server implementation evidence, so this task makes no Storage API
    repository edit. The desktop mirror
    `docs/storage-api/rest-contract-v1.md` was copied byte-for-byte from that
    branch; SHA-256 for both files is
    `0521A7848AE7413AD0D746DB89E8716953EDC274802E72D587B1C1377ECEBBD9`.
    This carries the ratified §7 meeting endpoints and the corrected stale §3
    `require_admin` sentence.
  - **Desktop branch and commit evidence:**
    `codex/in-386-meeting-blob-delivery` contains, in order,
    `becfdb7`, `a36eef6`, `670b62a`, `8e2ac6c`, `b999351`, `2664e55`,
    `965198e`, `6d958ab`, `071b990`, `6203c82`, `6d09f2b`, `51fae45`,
    `6189efb`, `2a57617`, `850e227`, `ed8a4e4`, `b90f3c8`, and `6c3d6e0`.
    These rebased commits cover the typed Storage API seam, safe streamed
    audio upload, non-blocking persisted delivery state, guarded delivery
    generations, pipeline/finalisation/retry wiring and audit truthfulness,
    exact Electron token routing, reachable Home notices, evidence, and
    failed-only duplicate-retry protection. The branch is based on local
    `main` at `4a3eede`, so the parallel IN-478/IN-477 work is included.
  - **Contract and lifecycle:** the consumer uses
    `PUT /api/v1/meetings/{meeting_id}/export` and
    `POST /api/v1/meetings/{meeting_id}/audio/upload-sas`. Pipeline-ready
    attempts audio then canonical export; state is only `pending`, `uploaded`,
    or `failed`, with a fixed safe error message. The authenticated retry
    endpoint and UI retry action re-attempt only a failed delivery. A prior
    successful delivery followed by finalisation uploads JSON only; it does
    not request another audio SAS or send audio again. Blob failure is
    non-blocking for local processing, finalisation, SharePoint, email, and
    local review.
  - **UI boundary:** Home is the reachable renderer flow and shows only safe
    delivery status/actionable retry notices. `MeetingReviewScreen` remains
    deliberately unrouted and contains no IN-386 UI because Slice 1 removed
    the meeting-detail screen; routing it would expand scope. The renderer
    receives only `blob_status` and a fixed safe `blob_error_message`.
  - **Privacy/security boundary:** Electron main acquires and owns the
    delegated Storage API token, forwarding it only for the allowlisted
    delivery/retry operations. The renderer never receives a token, SAS URL,
    Blob path, raw export, or audio bytes; no SAS is returned by the desktop
    backend. Audio is streamed by the backend directly to the scoped upload
    grant, while persisted state/audit output contains only safe status
    metadata.
  - **TDD and independent review:** focused client, delivery-state,
    trigger/retry/finalisation, token-route, and Home-notice coverage was
    written red-first. Review fixes include malformed-target redaction,
    delivery-generation guards, truthful retry audits, failed-only retry,
    concurrent notice handling, authenticated notice restoration, cancellable
    polling, and the reachable-Home boundary.
  - **Final verification (27 July 2026, after rebasing onto `4a3eede`):**
    Storage API `215 passed` with one pre-existing Starlette deprecation
    warning; Ruff and `git diff main...HEAD --check` passed. Desktop backend
    `228 tests` passed. `npm run verify:storage-cutover`,
    `npm run verify:graph`, `npm run verify:email-notice`,
    `npm run verify:toast-xml`, `npm run typecheck`, `npm run build`,
    contract SHA-256 comparison, and `git diff --check` passed. The Graph
    verifier emitted only the sandbox's expected inability to write its
    optional Electron log under AppData; assertions still passed.
  - **Isolated local smoke:** with a temporary `MN_DATA_DIR`, enabled stub
    delivery, and an empty Storage API URL, full audio+JSON delivery reached
    `uploaded`; an injected failure became retryable and the authenticated
    retry returned to `uploaded`; finalisation created one JSON history
    revision while the audio hash and modification time stayed unchanged.
    The temporary directory was removed on exit.
  - **Field-by-field privacy review:** the only new renderer fields are
    `blob_status` and fixed-safe `blob_error_message`. Electron main owns the
    delegated token; the backend-internal SAS grant is `repr=False`, is never
    returned to the renderer, and is not snapshotted or audited. Local audits
    contain actor, meeting title/ID, action, and status transitions only.
    Central events remain `meeting_json_written` (`meeting_id`,
    `schema_version`, `revision`) and `meeting_audio_sas_issued`
    (`meeting_id`). Searches found token/SAS literals only in transport code,
    contract placeholders, and redaction tests—not in renderer responses,
    logs, or persistence.
  - **Lifecycle review:** the `meetings-audio/` Cool-at-30/delete-at-365 rule
    is correctly prefix-scoped, but deploying the account-level
    `managementPolicies/default` resource replaces the entire existing
    lifecycle policy. The mandatory human-reviewed Azure `what-if` remains
    required before any apply.
  - **Release/operations state (updated 28 July 2026):** the Storage API
    branch `in386-meeting-blob-delivery` was merged to `main` (`4dc0736`) and
    deployed to production — GitHub Actions `Deploy` run `30335569135` and
    `CI` run `30335569138` both succeeded, `GET /health/live` and
    `GET /health/ready` returned 200, and an unauthenticated smoke against
    `PUT /api/v1/meetings/{id}/export` and
    `POST /api/v1/meetings/{id}/audio/upload-sas` returned 401 (route
    present, auth enforced) rather than 404. This closes the gap where the
    desktop client (merged to `main` since 27 Jul) was pointed at a real
    production Storage API URL that did not yet expose these routes. Still
    outstanding: an authenticated end-to-end production meeting smoke (a
    real desktop delivery through to `uploaded`) has not been run, and the
    Storage API Bicep lifecycle policy (`meetings-audio/` Cool-at-30/
    delete-at-365) has not been applied — that remains a separate,
    David-reviewed `what-if` step per `notetaker-storage-api/infra/README.md`.
  - **Parked hardening review (30 July 2026, `c8948ba`): DROP all hunks.**
    The parked commit was reviewed hunk-by-hunk against `origin/main` at
    `bd85b1a`; no production or test code was transplanted:
    - `blob_delivery.py` per-meeting task map (`_BLOB_DELIVERY_TASKS_BY_MEETING`,
      `_active_delivery_task`, `_retain_delivery_task`) — **drop**. Current
      `deliver_meeting_to_blob` already serialises provider work with
      `_DELIVERY_LOCKS` and rejects stale work using `processing_attempt` plus
      `BLOB_DELIVERY_STARTED_AT`. The additional meeting-only map is not just
      redundant: after `kick_pipeline` increments `processing_attempt`, a new
      ready run can receive the still-active task from the superseded attempt
      instead of launching its own delivery. The old task then correctly
      aborts as stale, leaving the newer export undelivered.
    - `pipeline.py` switch from awaited `deliver_meeting_to_blob` to detached
      `kick_blob_delivery` — **drop**. `run_pipeline` is already a retained
      background task, so awaiting delivery blocks no request. Keeping delivery
      inside that task keeps normal delivery completion within the retained
      pipeline-task lifecycle and avoids adding a second detached lifecycle.
      Cancellation, process restart, and unexpected exceptions still rely on
      the existing reconciliation and safe logging paths.
    - `blob_delivery.py` `kick_finalized_blob_delivery` plus
      `meetings.py` finalisation rewiring — **drop**. Current finalisation
      refreshes the canonical export before scheduling delivery. If it races
      the pipeline delivery, the existing per-meeting lock serialises the two
      runs; the later run snapshots the refreshed final export. Avoiding a
      possible duplicate audio upload is not worth introducing the unsafe task
      map, and failed-only Blob retry already prevents user-triggered duplicates
      while a delivery is pending or uploaded.
    - `schemas.py` WebM-only validators for `UploadAudioRequest` and
      `SystemAudioSegment` — **drop as written**. The renderer forwards the
      actual `File.type` for existing recordings, and the manual-upload picker
      intentionally accepts non-WebM audio. Rejecting every non-WebM MIME at
      the API boundary would break that contract. This DROP means the parked
      validator is unsuitable, not that the underlying delivery gap is
      resolved: `audio_path_for` stores an accepted non-WebM upload as
      `<meeting_id>.bin`, while Blob delivery currently reads
      `<meeting_id>.webm`. Normalising/transcoding the upload, or carrying its
      actual persisted path and type into Blob delivery, needs a separately
      scoped change with end-to-end non-WebM coverage. IN-480's segmented WebM
      shape remains unchanged.
    - `HomeScreen.tsx` `accept="audio/webm,video/webm"` and its
      `verify-ad-hoc-attendees.tsx` assertion — **drop**. The existing
      `accept="audio/*,video/webm"` is the intentional audio-first manual-upload
      contract; narrowing only the file picker would contradict the API/client
      path above without validating file contents.
    - Parked test helpers and cases in `test_blob_delivery.py` and
      `test_meeting_processing_auth.py` — **drop**. The JSON-body ASGI helper,
      MIME rejection tests, task-map cleanup, detached-pipeline assertions, and
      finalisation-coalescing tests only support rejected behavior. Current
      tests already cover per-meeting provider serialisation, stale-generation
      abort, pipeline re-arm invalidation, final-export refresh ordering,
      failed-only retry, and IN-391 safe failure taxonomy; retaining duplicate
      tests tied to the discarded API would make the suite describe the wrong
      product contract.

- [ ] IN-391 — Pipeline error handling and status reporting
  - **Implemented on `in391-error-reporting`** per the approved design
    (`docs/superpowers/specs/2026-07-29-in391-pipeline-error-handling-design.md`)
    and plan (`docs/superpowers/plans/2026-07-29-in391-pipeline-error-handling.md`,
    Tasks 0-9 done, including the Task 9 verification sweep). A new pure
    taxonomy module (`backend/app/services/failure_reasons.py`) maps
    exceptions and exception-less condition branches to 7 fixed categories
    (`network`, `azure_signin`, `service_unavailable`, `audio_problem`
    [reserved, currently unreachable by design], `processing_error`,
    `interrupted`, `stalled`), each with one fixed user sentence — raw
    exception text never reaches a user-facing field again. Classification
    unwraps `__cause__` chains (bounded depth 5) so wrapper exceptions (e.g.
    `MeetingVoiceprintsUnavailable`) classify by their root cause; excludes
    local file errors (`FileNotFoundError`/`PermissionError`/etc.) from the
    network bucket via an explicit type list before falling back to the
    `OSError`-without-`filename` heuristic; and gives `StorageApiUnavailable`
    (which has no `__cause__`) an explicit `service_unavailable` mapping so a
    real Azure outage isn't hidden as a generic processing error.
  - **Four hook sites wired**, all logging a structured `delivery_failure
    meeting=<uuid> stage=<pipeline|blob|sharepoint|email> category=<cat>
    code=<ExceptionClass|branch-name> detail=<...>` line: the pipeline
    catch-all plus its startup interrupted-marking and stall-watchdog sites
    (`services/pipeline.py`); every Blob delivery failure branch *including*
    the previously-uncovered startup reconcile site for orphaned
    pending/ready deliveries (`services/blob_delivery.py`
    `reconcile_interrupted_blob_deliveries` — added mid-implementation, not
    in the original 4-site list, because it shared the same
    ad-hoc-string problem); and SharePoint/email in
    `routers/meetings.py` (both explicit sign-in branches keep their
    existing distinct wording but now also set the category code).
  - **Schema:** three new nullable `blob_error_code` / `sharepoint_error_code`
    / `delivery_error_code` fields on `Meeting` (`backend/app/schemas.py`),
    backward-compatible (legacy `store.json` entries load with `None`).
    `processing_error_code` already existed and is reused.
  - **Renderer:** `processingErrorCode`/`blobErrorCode`/`sharePointErrorCode`/
    `deliveryErrorCode` mapped in `lib/api.ts`; new pure
    `lib/failureDisplay.ts` (`failedChipLabel`, `categoryLabel`,
    `showUnconfirmedChip`). Wired into the **live** surfaces — `HomeScreen`'s
    `postCaptureNotice`/`blobDeliveryNotices` cards now render `Failed:
    <category>` labels with tri-state `errorCode` semantics (string =
    labelled, `null` = generic fallback, `undefined` = not actually a
    failure, e.g. `unconfirmed` email — IN-478). Also wired into
    `MeetingsScreen.tsx`/`MeetingReviewScreen.tsx` (chips + per-concern
    failure rows with retry), **discovered mid-Task-7 to be dead code**
    (nothing routes to them since the IN-73/IN-74 UI removals, predating
    IN-391) — kept for potential revival; removal is a separate product
    decision, documented as Task 7b in the plan.
  - **Full reference doc:** `docs/pipeline-error-handling.md` — the four
    state machines, taxonomy + sentence table, classification rules as
    implemented, retry/partial-success matrix, audio-preservation guarantee
    (verified: no failure path deletes audio; retention is age-based via
    `retention.py`, not status-based), support log-line format incl. the
    `code=` branch-name convention, live-vs-dead UI surfacing, and two open
    notes (the startup-interrupted stage-message/error-message text
    intentionally differs; pyannoteAI 401 currently misclassifies as
    `azure_signin` — flagged for a future taxonomy revision).
  - **File-level evidence:** `backend/app/services/failure_reasons.py`
    (new); `backend/app/schemas.py` (+3 fields); `backend/app/services/pipeline.py`
    (catch-all, startup reconcile, watchdog); `backend/app/services/blob_delivery.py`
    (`_finish`, every failure branch, reconcile); `backend/app/routers/meetings.py`
    (email + SharePoint); `src/renderer/src/lib/api.ts`,
    `src/renderer/src/lib/failureDisplay.ts` (new),
    `src/renderer/src/App.tsx`, `src/renderer/src/screens/HomeScreen.tsx`,
    `src/renderer/src/screens/MeetingsScreen.tsx`,
    `src/renderer/src/screens/MeetingReviewScreen.tsx`; tests in
    `backend/tests/test_failure_reasons.py` (new),
    `backend/tests/test_pipeline_failures.py` (new), plus updates across
    `test_pipeline_stage_state.py`, `test_pipeline_watchdog.py`,
    `test_pipeline_voiceprints.py`, `test_blob_delivery.py`,
    `test_delivery_reliability.py`; `scripts/verify-failure-chips.tsx` (new).
    Commit range `fc0dea0..8942ac9` on `in391-error-reporting` (21 commits;
    20 are IN-391 work, `fc0dea0` through `8942ac9` inclusive — the range
    base is `fc0dea0`'s parent. `57041ba` "fix: set window icon for dev
    mode..." inside that range is the user's own unrelated commit, left
    untouched per instruction).
  - **Task 9 sweep closure (29 Jul 2026, commit `8942ac9`):** all three
    carried items from the prior verification pass are done: (1)
    `test_failure_reasons.py` now has table-driven cases classifying a real
    `urllib.error.HTTPError` (503 → `service_unavailable`, 401 →
    `azure_signin`, not just the `_FakeHttpError` test double) — confirms the
    classifier's attribute probe reads the shape real Graph errors actually
    have, including that `HTTPError.filename` (set to the request URL) does
    not trip the local-file-error exclusion; (2) `MeetingReviewScreen.tsx`
    `handleRetryBlob` now captures `blobPollGenRef.current` *before*
    `await retryBlobDelivery(meetingId)` and bails out immediately after the
    await if the generation moved, closing the wrong-meeting-poll window a
    meeting switch during that POST could open (the general poll-survives-
    meeting-switch mechanism was already fixed in `ea2fe2e`; this was the
    specific pre-await ordering gap carried forward, not fixed, in `6585c7b`);
    (3) `pipeline.py` `reconcile_interrupted_pipelines`'s `emailing →
    unconfirmed` transition now passes `error_code=None` explicitly, matching
    the equivalent router site (`meetings.py:614`) instead of relying on
    `set_delivery_state`'s default (behaviour-neutral — the default was
    already `None`). Also extended, as an optional-but-cheap addition: the
    three Task 5 `assertLogs` checks in `test_delivery_reliability.py` now
    also pin the `code=` fragment of each `delivery_failure` log line, not
    just `stage=`.
  - **Verification (final sweep, 29 Jul 2026, commit `8942ac9`):** full
    backend suite — `PYTHONPATH=backend backend/.venv/Scripts/python.exe -m
    unittest discover -s backend/tests -t backend` — **269 tests, 1
    failure**: the documented pre-existing
    `test_stub_serializes_concurrent_exports_for_one_meeting`
    concurrency-timing flake (`test_storage_api_meetings.py`), unrelated to
    this work (the 2-test increase over the prior pass's 267 is the two new
    real-`HTTPError` cases above). All renderer gates pass: `npm run
    typecheck` (clean, node + web), `npm run build` (electron-vite, all three
    bundles), `npm run verify:failure-chips`, `npm run verify:email-notice`,
    and — run on this branch for the first time in this task —
    `npm run verify:storage-cutover` (Storage API route-classification /
    identity-header / env-default checks; unaffected by the IN-391
    schema/API changes, since those touch meeting delivery fields, not the
    storage-cutover routing surface). `git diff --check` reports no
    whitespace errors; `git log --oneline main..HEAD` shows a coherent,
    task-ordered commit sequence.
  - **30 Jul follow-ups (commit `c109c8e`, branch
    `codex/in-391-followups`):** retention now deletes old canonical audio
    only for `ready` meetings. Failed, queued, processing, pending, and
    unmatched audio remains available for retry regardless of mtime. A retry
    that reaches `ready` keeps the original mtime clock. Because the schema
    has no terminal-failure state or timestamp, permanently failed audio is
    retained rather than guessed safe to delete; a future terminal-failure
    flow must add both before starting its proposed 30-day clock. Processing
    HTTP 401/403 failures now classify as the eighth category,
    `provider_credentials`, with administrator-facing remediation, while
    Graph delivery stages remain `azure_signin`. Inspection found the
    renderer labels are a typed shared map rather than unconstrained server
    text, so `Provider credentials` was added to that map and its fixture.
    The dead meetings/review screens cited above were removed from `main` by
    `9e8e454`; no routing or screen work was needed.
  - **30 Jul follow-up verification:** full backend discovery **283 tests
    passed, 1 skipped** (ffmpeg unavailable on PATH); focused IN-391 suite
    **27 passed**; `python -m compileall app`, `npm run
    verify:failure-chips`, `npm run verify:graph`, `npm run typecheck`,
    `npm run build`, and `git diff --check` all passed. Live provider
    verification remains out of scope for the personal PC handoff.
  - The 29 Jul task performed no Jira transition, merge, push, deployment,
    or production smoke. The 30 Jul follow-up is branch-only for review; it
    likewise performs no Jira transition, merge, deployment, or live
    provider smoke.

## IN-380 + IN-382 — Voiceprint administration and offboarding (29 Jul 2026)

- Added an administrator-only management surface for every central
  voiceprint status. The screen shows name, email, status, sample source,
  consent time, last-used time, artifact count, and the immutable central
  audit log. Active records can be disabled, disabled records can be
  re-enabled, and non-deleted records can be permanently deleted after an
  explicit confirmation.
- Client-side visibility is derived from the exact `StorageApi.Admin` role in
  the delegated Storage API token. This is presentation gating only: the
  renderer never receives the token, every request is relayed through the
  main process and local FastAPI proxy, and the central Storage API
  `require_admin` dependency remains the enforcement point. A remote 403 is
  preserved as 403 by the desktop proxy.
- Added `backend/app/routers/voiceprint_admin.py` and extended the typed
  Storage API client with admin-safe list/action/audit models. Lifecycle
  mutations also write the desktop's required local audit evidence while
  returning the central immutable audit event id. The desktop copy of
  `docs/storage-api/rest-contract-v1.md` was refreshed byte-for-byte from the
  IN-380/IN-382 API branch.
- Regression coverage: `scripts/verify-voiceprint-admin.tsx` verifies exact
  role gating, token-injected route classification, admin/non-admin Settings
  visibility, all lifecycle statuses and metadata, the SelectMenu filter,
  read-only audit rendering, and explicit disable/delete confirmation copy.
  `backend/tests/test_voiceprint_admin.py` covers REST paths, safe response
  models, bounded audit queries, remote 403 preservation, proxy forwarding,
  and local audit evidence.
- Verification: full backend suite **275 tests passed, 1 skipped** (`ffmpeg`
  unavailable); `npm run typecheck`, `npm run
  verify:voiceprint-admin`, `npm run verify:storage-cutover`, `npm run build`,
  and `git diff --check` passed. The initial build attempt exposed an
  incomplete local `node_modules` tree; `npm ci` restored the lockfile-defined
  dependencies without changing tracked files, after which the build passed.
- Branch: `codex/in-380-382-voiceprint-admin-ui`, based on required ancestor
  `1aff07e`. The storage API implementation is the prerequisite draft PR.
  Real Entra tenant role/claim and production Storage API checks are
  explicitly deferred to Joseph; no live evidence is claimed here. Jira was
  not changed.

## 5 Aug 2026 — IN-387 follow-up: per-user SharePoint folders + library migration

- [x] Per-user folder structure (David A's 29 Jul Teams decision, superseding
  the IN-387 flat-root design; spec amended in
  `docs/superpowers/specs/2026-07-28-in387-sharepoint-library-design.md`):
  - `sharepoint_folder_path` default changed `""` → `"Transcriptions"`
    (`backend/app/config.py`), so uploads target the library's nested
    `Transcriptions` folder; `backend.env.template` updated to match.
  - `SharePointProvider.save_transcript` gained `owner_folder`;
    `save_transcript_to_sharepoint` passes `safe_owner_folder(actor)` — the
    signed-in actor's display name, which matches the AAD display name
    SharePoint shows as file author. `GraphSharePointProvider` ensures the
    folder before the first upload of a delivery (`POST
    /drives/{id}/root:/Transcriptions:/children`, `conflictBehavior: fail`,
    409 treated as already-exists — look-or-create with no read-before-write
    race). Any other ensure failure fails the whole delivery for atomic
    retry, per the IN-387 error-handling design. `LocalSharePointProvider`
    mirrors the structure under `backend/var/sharepoint/<owner>/`.
  - Tests (written first, watched fail): `test_sharepoint_provider.py` —
    owner-folder sanitisation/fallback, ensure-then-upload ordering and URL
    shape, one ensure per delivery, 409-as-success, ensure-failure fails
    delivery, flat-path backward compatibility, local per-owner subfolder;
    `test_delivery_reliability.py` — endpoint passes the actor as owner
    folder; existing partial-grant and local stand-in tests updated for the
    new call sequence/paths.
  - Verification: full backend suite **333 tests, OK** (5 Aug 2026). The
    known `test_stub_serializes_concurrent_exports_for_one_meeting` flake
    reproduced on stashed pre-change code (2/3 runs) and passed 3/3 with the
    change — pre-existing, unrelated.
- [x] Live migration (5 Aug 2026, via Joseph's signed-in SharePoint session):
  created `Transcriptions/Transcriptions/<owner>/` folders and moved all 46
  loose files (13 root `.md` + 33 legacy nested `.txt`) into their
  uploader's folder, attributed by the library's own Created By field (list
  REST `Author`): Joseph Miguel Guerrero 17, David Ahlhaus 25, Jose Tabbada
  2, Daniel Vucetic 2. Post-migration verification: library root holds only
  the `Transcriptions` and `Voiceprint` folders; nested folder holds exactly
  the four owner folders; 46/46 files accounted for. Note: SharePoint moves
  preserve item ids and permissions but change `webUrl`, so
  `sharepoint_web_url` values stored on already-delivered meetings now point
  at the old paths. Jira was not changed.

## 5 Aug 2026 — Central people directory: empty attendee-dropdown fix

- [x] Root cause (diagnosed against the live install): the manual-recording
  attendee dropdown filters to `enrollment === 'enrolled'`
  (`AttendeePicker.tsx`), but `GET /people` derived enrolment from the LOCAL
  `voiceprints.json` registry only — post-Slice-2 every machine's people
  store held just the signed-in "me" with `enrolled=false`, so the dropdown
  was empty fleet-wide (live probe: `/people` returned exactly one record).
- [x] Storage API (branch `feature/voiceprint-directory`, commits ec361d3 +
  1a714e8 — **merge = deploy, Joseph's call**): new non-admin
  `GET /api/v1/voiceprints/directory` returning `{email, display_name}` of
  ACTIVE enrolments to any authenticated principal; registered ahead of the
  `/voiceprints/{person_oid}` catch-all (the red phase reproduced the 403
  shadowing); active-only, has-email-only, sorted, never oids/timestamps/
  voiceprint material; reads not audited (matches admin list). Contract doc
  §5 updated + mirrored here byte-for-byte. 238 tests + ruff green.
- [x] Desktop backend: `StorageApiClient.list_directory` seam (Rest:
  `allow_not_found` → `StorageApiUnavailable` so an old server degrades, 5s
  timeout so a hung central API can never drag `GET /people` past the
  proxy's 15s GET abort and take the LOCAL list down; stub enumerates its
  file-backed records). `list_people` merges the directory when consultable
  (stub mode always; Rest only with oid+token headers), authoritative for
  `centrally_enrolled` on success (set + clear), never removes people,
  fail-soft to the local list on any `StorageApiError`.
  `test_people_directory.py` (8 tests, written red-first);
  `test_seeded_enrollment_sync.py` gained a stub reset (its bare
  `list_people()` now exercises the merge).
- [x] Desktop main/renderer: `GET /api/v1/people` added to `isStorageRoute`
  (single switch for storage-token + email/oid injection, verified by
  `verify:storage-cutover`); `PersonEnrollmentDto.centrally_enrolled`;
  `enrollmentState` now `enrolled OR centrally_enrolled` (exported;
  `reenrollment_required` still wins). `verify:ad-hoc-attendees` extended
  red-first (central DTO maps to 'enrolled' and appears in suggestions).
- [x] Verification: desktop backend **341 tests** (sole failure = the known
  pre-existing `test_stub_serializes_concurrent_exports_for_one_meeting`
  flake, which also fails on unchanged code); `verify:ad-hoc-attendees`,
  `verify:storage-cutover`, `typecheck`, `build`, `git diff --check` all
  green. Storage-api: 238 + ruff green.
- [ ] Live smoke after the storage-api branch deploys: manual-recording
  dropdown lists centrally enrolled colleagues; against the old server the
  app behaves exactly as before (one warn line in the backend log).
  Plan: `docs/superpowers/plans/2026-08-05-central-people-directory.md`
  (reviewed, 2 rounds). Ships in desktop v2.0.20.

## 25 Aug 2026 — IN-486: speaker ID paginates past the 50-candidate bound

- [x] Root cause (from the 10 Aug Firmwide Catchup): `build_meeting_candidates`
  silently truncated the invite list at 50, so enrolled invitees past
  position 50 (David #70, Joseph #71, Daniel #87, Jose #100) were never
  looked up and stayed "Speaker N".
- [x] `meeting_voiceprints.py`: cap removed; the full deduplicated participant
  set is returned. Defensive `MAX_MEETING_CANDIDATES = 500` bound only drops
  invitees (organiser/recorder/expansion protected) and warns with
  total/kept/dropped counts — never silent.
- [x] `resolve_meeting_voiceprints` paginates the Storage API lookup in
  batches of ≤50 (`MEETING_CANDIDATE_BATCH_LIMIT`, shared with the request
  model so contract and paginator cannot drift); `request_count` reports real
  requests. Any batch failure discards partial central results and degrades
  to the local fallback for ALL candidates — authoritative-or-nothing, so
  never-guess semantics are unchanged. Server contract untouched.
- [x] Tests red-first in `test_meeting_voiceprints.py`: 101-attendee fixture
  resolves an enrolled speaker at invite position 71 across 3 batches;
  organiser+recorder always candidates; cap warning with counts;
  mid-pagination outage falls back for the full list. The old
  `test_fallback_is_limited_to_exact_capped_request_candidates` (which
  asserted the buggy cap) rewritten to the corrected contract.
- [x] Verification: module 15/15; voiceprint-adjacent suites 99/99. Full
  backend run has 11 pre-existing failures in the delivery/recipient
  families (assert the pre-organizer-only delivery defaults; also fail on
  unchanged code — verified by stash) — unrelated, needs its own cleanup.

## 25 Aug 2026 — IN-479: planned duration for ad-hoc meetings

- [x] DA's idea (29 Jul): an ad-hoc start is easy to forget to stop; give it
  a duration so the scheduled-end machinery covers it.
- [x] Home capture card gains "Planned duration" (number input, default 30,
  clamp 5–480 — the 480 ceiling matches the old fixed 8h placeholder).
  `clampAdhocDurationMinutes` exported; blank/garbage → 30, fractional
  rounds.
- [x] `App.startManualRecording` computes the real end from the duration:
  `endTimeUtc` replaces the 8h placeholder and `scheduledEndUtc` lands in
  session state, which alone lights up RecordingScreen's countdown + Extend.
- [x] Main: `registerManualRecording` now calls `scheduleAutoStop()` and
  stamps `startedAtUtc`, arming auto-stop + the 5-min ending-soon reminder
  toast (Extend/Dismiss) for manual recordings identically to calendar
  meetings. J4 false-start rule only discards join-triggered recordings, so
  a scheduled_end stop of an ad-hoc recording always delivers.
- [x] Verification red-first: `verify:graph` (timed manual start extendable,
  Extend pushes end out exactly 10 min, stop disarms) and
  `verify:ad-hoc-attendees` (clamp table + rendered default 30). Also green:
  `verify:recording-controls`, `verify:join-watch`, `verify:call-signals`,
  `typecheck`, `build`, `git diff --check`.
- [ ] Live smoke: start an ad-hoc recording with a ~6-min duration; expect
  the ending-soon toast at T-5 and auto-stop + upload at the end.
