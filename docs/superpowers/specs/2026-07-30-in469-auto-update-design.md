# IN-469 — Auto-update via HTTPS Blob feed (design)

**Date:** 2026-07-30
**Status:** Approved by Joseph (30 Jul) — publish auth and restart UX chosen
explicitly; cadence defaulted.
**Sources:** Jira IN-469 (scope + hosting recommendation), existing
`src/main/updater.ts` (Slice 1 scaffolding), IN-81 signing work (`c0de145`),
DV's Azure Artifact Signing brief (Private Trust).

## Problem

Every release requires a manual uninstall/reinstall from SharePoint, and
stale versions linger in the tray for days. electron-updater is already
wired (launch check, auto-download, install-on-quit, manual-check IPC) but
the feed URL is a `REPLACE_ME` placeholder, CI never publishes, and nothing
restarts a long-running tray app — the exact stale-version failure mode.

## Decisions (locked)

1. **Feed:** public-read `updates` Blob container serving `latest.yml` +
   versioned `Meeting Notetaker-x.y.z-setup.exe` over HTTPS. Exact account
   is David/DV's call (on `stf1nt` if policy permits an anonymous-read
   container, else a small dedicated account). The final URL replaces
   `REPLACE_ME` in `electron-builder.yml` `publish.url` — committed,
   non-secret. Private containers (voiceprints/meetings/audit) are untouched.
2. **Publish auth:** reuse the release identity `app-github-code-signing`
   (client `5e1334af-b687-4636-880f-79f97879b69e`) via the workflow's
   existing azure/login OIDC session; David/DV grant it **Storage Blob Data
   Contributor scoped to the updates container**. No new secrets, no new app
   registrations. (Chosen over a connection-string secret — long-lived
   credential against DV's stated preference — and over a dedicated
   publisher identity — extra moving parts for marginal separation.)
3. **Restart UX:** prompt + idle auto-install (chosen over prompt-only,
   which never fixes lingering tray versions, and over silent overnight
   restarts, which are invisible and unreliable on sleeping machines).
   Details below; an active or imminent recording is never interrupted.
4. **Check cadence:** launch + every 4 hours + existing manual IPC check.
5. **Update signature verification:** `win.publisherName: factor1.com.au`
   in the base electron-builder config so electron-updater refuses a
   downloaded installer whose Authenticode subject CN does not match. On the
   Intune-managed fleet the Private Trust root makes verification pass; on
   unmanaged machines it correctly fails closed. Distribution is
   Intune-only, so that is acceptable and intended.

## Components

### 1. Feed publishing (`.github/workflows/release.yml`)

One new step after the signature assertion (same job, reuses the OIDC
session):

- `az storage blob upload` with `--auth-mode login`, uploading `dist/*.exe`
  and `dist/latest.yml` to the `updates` container with overwrite so
  `latest.yml` advances while versioned exes accumulate as rollback history.
  Note: `upload-batch` honors only ONE `--pattern` (the old commented-out
  step passed two; the last silently won) — use two upload commands or a
  single glob.
- Gate: skipped with a loud log line while the container/feed URL is not yet
  provisioned (config placeholder detection), so IN-81's `v2.0.8` signing
  validation tag can ship before the feed exists.

### 2. Updater lifecycle (`src/main/updater.ts`, extended)

Existing behaviour retained: packaged-only, launch check, auto-download,
`autoInstallOnAppQuit` as backstop, manual-check IPC.

Added:

- **Periodic check:** 4-hour timer using `checkForUpdates`. The launch check
  also switches from `checkForUpdatesAndNotify` to `checkForUpdates` —
  otherwise electron-updater's built-in notification would appear alongside
  our own toast (notification becomes ours everywhere).
- **`update-downloaded` handling:** surface a persistent tray menu item
  ("Restart to update to x.y.z") and a Windows toast (existing
  `toast-xml.ts` patterns) with a "Restart now" action. Both routes call the
  same guarded restart path.
- **Idle gate:** a 5-minute poll that triggers auto-install only when ALL
  hold:
  1. an update is downloaded;
  2. the recording state machine (`recording-state.ts` `getState()`) reports
     no active/paused/starting recording;
  3. no pending or imminent auto-start: nothing in `recording-ipc.ts`'s
     pending auto-start slot and no scheduled auto-record within the next
     15 minutes (scheduler seam: the Graph runtime's lookahead machinery in
     `src/main/graph/`; exact accessor pinned during planning);
  4. no meeting in active post-processing: the recording state machine
     returns `idle` the moment a recording stops, while backend
     transcription/delivery may still be in flight — the gate must also
     require no meeting in a non-terminal processing state (seam pinned
     during planning: a lightweight local-backend query, or failing that a
     fixed 30-minute cooldown after the last recording stop);
  5. `powerMonitor.getSystemIdleTime() >= 300` seconds.
- **Countdown:** when the gate passes, show a 60-second countdown toast with
  a defer action; defer snoozes the idle gate for 4 hours. On expiry,
  `quitAndInstall(isSilent=true, isForceRunAfter=true)` — silent install (no
  NSIS UI on an unattended machine; the toasts are the visible signal), app
  relaunches on the new version and returns to the tray. The explicit
  "Restart now" path uses the same silent install for consistency.
- **Guarded restart path:** "Restart now" from tray/toast uses the same
  recording checks (2)–(3); if a recording is active it explains via toast
  instead of restarting. There is no code path to `quitAndInstall` that
  bypasses the recording guard.
- All transitions log structured `[updater]` lines (existing logger),
  feeding the IN-473 report bundle.

The idle-gate predicate lives in a pure, exported function (inputs: download
state, recording state, pending/next auto-start time, system idle seconds,
snooze-until) so the verify script can pin its truth table without Electron.

### 3. Config (`electron-builder.yml`)

- `publish.url`: real feed URL when provisioned (single committed change).
- `win.publisherName: factor1.com.au` (base config — harmless for unsigned
  local builds; consumed by electron-updater at update time).

## Failure semantics

- Feed unreachable / container missing: log a warning per check; never a
  user-facing error. The app is fully functional without the feed.
- Download or signature verification failure: electron-updater discards the
  artifact; next cycle retries; nothing is installed.
- A restart is never forced while recording, and `autoInstallOnAppQuit`
  remains the backstop if the user quits before any prompt/idle install.

## Testing

- `verify:updater` (esbuild pattern like `verify:backend-supervisor`):
  truth-table over the idle-gate predicate (recording active / pending
  auto-start / imminent meeting / idle below threshold / snoozed / all-clear)
  plus countdown-defer arithmetic and placeholder-URL publish gating.
- Existing gates: typecheck, build. Main-process changes need a full dev
  restart to exercise manually (renderer HMR is insufficient).
- **Live E2E (work machine, after provisioning):** publish a signed 2.0.x,
  install manually, bump to 2.0.y, tag, confirm the installed app detects,
  downloads, verifies, prompts, idle-installs, and relaunches on 2.0.y.

## Rollout

Per Jira: one final manual install of the first feed-aware signed build;
every later release arrives automatically. Sequencing: IN-81's `v2.0.8`
validation tag may ship first (publish step self-skips); IN-469 headlines
the next tag once the container + role grant land.

## External dependencies (request to David/DV)

1. `updates` container with anonymous public blob read, on `stf1nt` if
   policy allows, else a small dedicated storage account (their call).
2. Role grant: Storage Blob Data Contributor on that container (scoped) for
   `app-github-code-signing` (`5e1334af-b687-4636-880f-79f97879b69e`).
3. Resulting HTTPS feed URL back to Joseph for the config change.

## Out of scope

Delta updates, release channels/staged rollout, downgrade protection beyond
electron-updater defaults, macOS/Linux, and any change to the private
storage containers or Storage API.
