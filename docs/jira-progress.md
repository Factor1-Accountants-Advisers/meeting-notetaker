# Jira progress ledger

Date started: 2026-06-26
Owner: Joseph Guerrero

This ledger tracks Slice 1 Jira implementation items as we complete and verify them in this repo. It is intentionally evidence-focused so David/Benjamin can map commits back to the plan.

## Crossed out / completed

- [x] `IN-65` — Spike: MS Graph meeting detection — subscription vs. polling
  - Evidence: `docs/spikes/ms-graph-meeting-detection.md`
  - Commit: `9486bd9 document Graph meeting detection spike`
  - Verification: documentation self-check passed; fresh `npm run typecheck`, `npm run build`, and `git diff --check` passed after the doc change.

## In progress

- [ ] `IN-68` — Implement MS Graph meeting detection in Electron main process
  - Current slice: MSAL interactive sign-in wired through preload IPC into LoginScreen. The renderer calls `window.api.signIn()` which triggers PKCE-based auth code flow with a loopback redirect server and system browser. On success, MSAL token cache and account are populated; on missing config, the existing stub sign-in fallback is preserved.
  - Runtime startup currently skips cleanly until MSAL provides a cached Graph access token.
  - MSAL public-client config boundary exists via `MN_ENTRA_TENANT_ID` and `MN_ENTRA_CLIENT_ID`; missing config returns no token without attempting Graph calls.
  - Verified fixture coverage includes filtering, timezone parsing, `Retry-After`, no-token runtime skip, fake-client runtime sync, MSAL missing-config detection, and PKCE code generation.
  - Remaining before crossing out: live tenant config + interactive sign-in smoke, live/persisted calendar sync, startup/resume polling policy, and live redacted payload smoke if credentials are available.
  - Must not start recordings yet.
  - Must preserve manual recording.

## Not started

- [ ] `IN-67` — Implement host-only recording gate for auto-triggered meetings
- [ ] `IN-66` — Wire auto-start and auto-stop recording to Graph meeting events
- [ ] `IN-71` — Configure app to run at Windows startup and persist in system tray
- [ ] `IN-77` — UI updates: auto-recording status alongside manual recording
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
