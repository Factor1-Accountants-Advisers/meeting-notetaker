# Jira progress ledger

Date started: 2026-06-26
Owner: Joseph Guerrero

This ledger tracks Slice 1 Jira implementation items as we complete and verify them in this repo. It is intentionally evidence-focused so David/Benjamin can map commits back to the plan.

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
  - Commit: `1df29d8`, `0000990`

- [x] `IN-71` — Configure app to run at Windows startup and persist in system tray
  - System tray with status tooltip and context menu (Show / Quit).
  - App persists in tray when all windows are closed.
  - Packaged Windows builds default auto-launch on via `app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args: ['--background'] })`.
  - Login launch uses `--background` so the renderer is available for auto-recording but the main window stays hidden until tray/open action.
  - Single-instance handling prevents a background login launch from creating a duplicate app; explicit user launches focus the existing window.
  - Settings includes an opt-out toggle; user choice is persisted and prevents the default from re-enabling automatically.
  - Tray menu updates live when recording state changes.
  - Verification: `npm run typecheck`, `npm run build`, `git diff --check`.
  - Commit: `a7db862`

- [x] `IN-77` — Recording status UI
  - `HomeScreen` shows auto-recording status banner (recording / processing).
  - `App.tsx` tracks `autoRecordingState` via auto-start/stop IPC events.
  - Tray tooltip reflects current recording state.
  - Commit: `132cb77`

- [x] `IN-69` — Wire Pyannote transcription and voiceprint identification into production pipeline
  - Extracted speaker matching from pipeline into `backend/app/services/speaker_matching.py`.
  - Added `SpeakerEmbeddingProvider` interface with stub + pyannote implementations.
  - Added `VoiceprintRepository` interface with in-memory stub.
  - Pipeline now uses `get_speaker_matcher()` factory — stub heuristic when no voiceprints enrolled, cosine matcher when voiceprints exist.
  - Stub behavior preserved: owner recognised, unknown speakers labelled Unknown N.

- [x] `IN-78` — Attendee-first voiceprint candidate selection
  - `CosineSpeakerMatcher` checks meeting attendees first before expanded staff.
  - `StubSpeakerMatcher` assigns owner as first speaker (stand-in for attendee-first).

- [x] `IN-79` — Controlled voiceprint candidate expansion
  - If no attendee match above threshold, enrolled staff are checked.
  - Match source tracked as "attendee" or "expanded_staff".

- [x] `IN-80` — False-positive suppression for non-attendee detections
  - Cosine similarity threshold (`MN_SIMILARITY_THRESHOLD`, default 0.62).
  - Matches below threshold rejected — speaker remains Unknown.
  - Confidence, match_source, and match_reason tracked per match.
  - Verification: backend import OK, pipeline end-to-end with meeting create → upload → process → ready, stub behavior preserved.

- [x] `IN-76` — Voiceprint enrollment/admin utility
  - Enrollment extracts embeddings from 3 audio clips, averages them into one voiceprint.
  - Source audio deleted immediately after embedding extraction.
  - Voiceprint stored via `VoiceprintRepository` with model version and timestamp.
  - Re-enrollment supported via `flag-reenrollment` endpoint.
  - Exactly 3 clips enforced (Pydantic `min_length=3, max_length=3` on `EnrollRequest`).
  - All enrollment actions audit-logged (enroll, flag_reenrollment).
  - No raw audio persisted; no embeddings logged.
  - Verification: API tested — enroll with 3 clips, reject 2 clips, flag re-enrollment, all passed.
  - Commit: `b469eeb`

- [x] `IN-93` — Implement MS Outlook emailing of Transcript
  - `GraphEmailProvider` sends via delegated Microsoft Graph `POST /me/sendMail`.
  - Transcript attached as `.txt` file via `build_transcript_attachment()`.
  - Token injection: `api-proxy.ts` attaches `X-MN-Graph-Token` header on email endpoints.
  - Hard-gated on finalisation (409 if not finalised).
  - Error handling: 502 with logged detail on Graph delivery failure.
  - Stub fallback when no Graph token available (logs instead of sending).
  - All email actions audit-logged with recipients.
  - Verification: email flow tested — stub without token, Graph with token, transcript attachment built.
  - Commit: `(pending)`

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
  - Commit: `(pending)`

- [ ] `IN-68` — Implement MS Graph meeting detection
## Not started
  - All code implemented and fixture-verified. Blocked on live tenant credentials for final smoke.
  - Graph client, filter, normaliser, time/poller, runtime with polling + resume, MSAL public-client auth, interactive sign-in.
  - Remaining: live tenant config, interactive sign-in smoke, live calendar sync, redacted payload smoke.

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
  - Email endpoint: attachment built, recipients resolved, stub sends logged.
  - Dedupe fix applied: same person appearing twice in participants → single recipient.
  - Finalise-gated (409 if not finalised).
  - Verified: email endpoint returns `{recipients: [...], sent_at: ...}` with deduped addresses.
