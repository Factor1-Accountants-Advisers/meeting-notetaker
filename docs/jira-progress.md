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
  - `setAutoLaunch()` / `isAutoLaunchEnabled()` via `app.setLoginItemSettings`.
  - Tray menu updates live when recording state changes.
  - Commit: `(pending)`

- [x] `IN-77` — Recording status UI
  - `HomeScreen` shows auto-recording status banner (recording / processing).
  - `App.tsx` tracks `autoRecordingState` via auto-start/stop IPC events.
  - Tray tooltip reflects current recording state.
  - Commit: `(pending)`

## In progress

- [ ] `IN-68` — Implement MS Graph meeting detection in Electron main process
  - All code implemented and fixture-verified. Blocked on live tenant credentials for final smoke.
  - Graph client, filter, normaliser, time/poller, runtime with polling + resume, MSAL public-client auth, interactive sign-in.
  - Remaining: live tenant config, interactive sign-in smoke, live calendar sync, redacted payload smoke.

## Not started

- [ ] `IN-69` — Wire Pyannote transcription and voiceprint identification into production pipeline
- [ ] `IN-76` — Admin voiceprint upload and registration utility
- [ ] `IN-78` — Implement attendee-first voiceprint candidate selection
- [ ] `IN-79` — Implement voiceprint candidate expansion rules for key uninvited people
- [ ] `IN-80` — Check: false-positive suppression for non-attendee detections
- [ ] `IN-93` — Implement MS Outlook emailing of Transcript
- [ ] `IN-72` — UI cleanup: remove per-calendar-meeting Record button
- [ ] `IN-74` — UI cleanup: remove full meeting detail page
- [ ] `IN-75` — UI cleanup: remove action items view and aggregated action items page
- [ ] `IN-81` — Packaging, signing, and installer update

## Test items to satisfy later

- [ ] `IN-83` — Auto-recording starts for meeting organiser
- [ ] `IN-84` — Auto-recording is suppressed for non-organiser
- [ ] `IN-85` — Manual recording still works for in-room/ad-hoc use
- [ ] `IN-86` — Known speaker identified by voiceprint with high confidence
- [ ] `IN-87` — Unregistered speaker stored as anonymous in output
- [ ] `IN-88` — Per-meeting calendar Record button absent; manual controls and audio setup present
- [ ] `IN-94` — When a transcript is saved it is sent via email attachment to the correct persons
