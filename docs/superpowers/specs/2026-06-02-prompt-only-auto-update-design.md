# Prompt-only internet auto-update design

Date: 2026-06-02
Repo: meeting-notetaker
Status: approved

## Goal

Meeting Note-Taker should update itself over the internet after the user has installed the NSIS version once. Users should not need to manually download and run each new installer.

The app must never restart itself mid-recording. Updates may download automatically, but installation must wait for explicit user approval.

## Current state

The desktop app already uses the right release channel for Electron auto-update on Windows:

- NSIS installer target.
- Per-user install: `perMachine: false`.
- Public GitHub Releases publish config.
- Release assets include `latest.yml`, `Meeting-Note-Taker-Setup-X.Y.Z.exe`, and `.blockmap`.
- The app calls `autoUpdater.checkForUpdatesAndNotify()` on startup and every four hours.

The gap is product behavior and proof. The current implementation does not expose enough updater state, does not provide a manual check/restart path, and has not been proven by updating an installed old version to a newer version without manually running the new installer.

## Scope

In scope:

- Prompt-only updater flow using `electron-updater`.
- Structured updater logging for all key events.
- Manual tray action: `Check for updates`.
- Pending-update tray action: `Restart to update`.
- Native prompt when an update has downloaded.
- Guard that blocks install/restart while recording.
- Unit tests for updater behavior with mocked Electron/updater APIs.
- End-to-end proof with two releases: install v1.1.5, publish v1.1.6, update through the app prompt.

Out of scope:

- Silent auto-restart.
- Forced enterprise updates.
- Private update server/proxy.
- SharePoint-hosted update feed.
- Replacing GitHub Releases.

## User experience

On app startup, the app checks for updates quietly.

If no update exists:

- The app does not interrupt the user.
- Logs record `update-not-available`.

If an update exists:

- The app downloads it in the background.
- Logs record availability and progress.
- When downloaded, the app shows a native prompt:
  - Title: `Update ready`
  - Message: `Version X.Y.Z has been downloaded. Restart Meeting Note-Taker to install it?`
  - Buttons: `Restart now`, `Later`

If the user chooses `Restart now`:

- If not recording, call `autoUpdater.quitAndInstall(false, true)`.
- If recording, do not restart. Show a warning: `Finish your recording first, then restart to update.`

If the user chooses `Later`:

- Do not nag repeatedly in the same app session.
- Keep a pending state.
- Tray menu exposes `Restart to update`.

Manual check:

- Tray menu exposes `Check for updates`.
- Manual checks show useful feedback for checking, no update, update ready, and errors.

## Architecture

Add `desktop/src/main/updater.ts` as the main-process updater boundary.

Responsibilities:

- Configure updater event handlers once.
- Start scheduled checks in packaged builds.
- Run manual checks.
- Track updater state.
- Prompt once when an update is downloaded.
- Install only after explicit user confirmation.
- Refuse installation while recording.

Suggested public API:

```ts
export type UpdaterStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error';

export interface UpdaterState {
  status: UpdaterStatus;
  version?: string;
  percent?: number;
  error?: string;
  downloaded: boolean;
}

export interface UpdaterController {
  checkForUpdates(manual?: boolean): Promise<void>;
  installDownloadedUpdate(): Promise<boolean>;
  getState(): UpdaterState;
}

export function initUpdater(options: {
  isPackaged: boolean;
  isRecording: () => boolean;
  checkIntervalMs?: number;
}): UpdaterController;
```

The existing startup file should call `initUpdater()` instead of directly calling `autoUpdater.checkForUpdatesAndNotify()`.

Tray integration should use the controller:

- `Check for updates` calls `checkForUpdates(true)`.
- `Restart to update` is enabled only when `getState().downloaded` is true.
- `Restart to update` calls `installDownloadedUpdate()`.

Recording guard:

- Reuse current main-process recording state rather than inferring from renderer UI.
- The updater must consult `isRecording()` immediately before install.

## Error handling

Updater errors are non-fatal. They should never prevent recording or app startup.

For startup checks:

- Log errors only.

For manual checks:

- Show a native dialog explaining that the update check failed and asking the user to try again later.

For downloaded update installation while recording:

- Do not call `quitAndInstall()`.
- Show a warning telling the user to finish the recording first.

## Tests

Use mocked `electron` and `electron-updater` modules.

Required tests:

1. Startup/manual checks call `checkForUpdates()` and do not auto-install.
2. `update-downloaded` sets pending state and prompts once.
3. Accepting the prompt calls `quitAndInstall(false, true)` only when not recording.
4. Accepting while recording blocks install and shows a warning.
5. Choosing `Later` preserves pending state and does not install.
6. Manual `Check for updates` reports `not available` and errors with dialogs.

Existing packaging tests continue to assert NSIS, public GitHub publish config, no MSI target, and no private updater token.

## End-to-end verification

To prove success:

1. Build and release v1.1.5 with this updater UX.
2. Install v1.1.5 manually once.
3. Build and release v1.1.6.
4. Open installed v1.1.5.
5. Use tray `Check for updates` or wait for startup check.
6. Confirm logs show checking, available, download progress, downloaded.
7. Click `Restart now` in the app prompt.
8. Confirm installed app reports v1.1.6.
9. Confirm no manual v1.1.6 installer was run.

The work is not complete until the v1.1.5 to v1.1.6 installed-app update is proven.
