# IN-477 — 5-minute warning notification adjustments

Date: 2026-07-27 · Status: approved (Joseph, in-session) · Parent: IN-375

## Problem

David/Ben repeatedly miss the "recording ends in 5 minutes" toast during tests
(IN-477). Windows toasts auto-dismiss to the Action Center after ~5 seconds,
and Notetaker toasts play no distinctive sound. Ticket asks: (1) the warning
must stay open until acknowledged; (2) all Notetaker notifications get a short
unique alert sound (royalty-free WAV attached to the ticket).

## Scope (confirmed with Joseph)

- Sound: the two existing OS toasts only — "auto-recording started" and the
  ending-soon warning. No new notes-ready toast; the in-app bell stays silent.
- Sticky: the ending-soon warning only. Auto-started stays transient.

## Design

1. **Sticky warning (Windows).** The ending-soon toast XML gains
   `scenario="reminder"`, which pins the toast until the user acts, plus an
   explicit `Dismiss` action (`activationType="system" arguments="dismiss"` —
   reminder toasts need actionable buttons). "Extend 10 min" (`mn-extend`)
   unchanged. Extending re-arms a fresh warning for the new end via the
   existing `reminderNotifiedForEndMs` guard (keyed to end timestamp).
   Non-Windows branch unchanged.
2. **Chime.** David's WAV ships as a Vite renderer asset
   (`src/renderer/src/assets/notification.wav`, 1.5 s stereo 16-bit). Toasts
   are marked silent (`<audio silent="true"/>` / `silent: true`) so the system
   default doesn't double-ding; custom `file:` audio in toast XML is
   unsupported for unpackaged win32 apps, so the main process instead sends a
   one-way `notification:chime` IPC when it shows a toast, the preload bridge
   exposes `onNotificationChime`, and App.tsx plays the sound through a
   singleton `Audio`. The window hides to tray but is never destroyed, so
   playback works while "closed"; if the window were gone the toast still
   shows and only the chime is lost.
3. **Testability.** Toast XML construction moves from `recording-ipc.ts` into
   pure `src/main/toast-xml.ts`. New `npm run verify:toast-xml` (esbuild +
   node:assert, matching the other verify scripts) pins: `scenario="reminder"`,
   silent audio, Extend + Dismiss actions, and XML escaping of meeting titles.

## Out of scope

Notes-ready OS toast (flag to David as possible follow-up), in-app bell sound,
volume/mute preference, macOS-specific behaviour.
