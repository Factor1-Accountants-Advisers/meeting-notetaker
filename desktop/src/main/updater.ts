import { app, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import { join } from 'path';
import { rm } from 'fs/promises';

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

export interface UpdaterOptions {
  isPackaged: boolean;
  isRecording: () => boolean;
  checkIntervalMs?: number;
  onStateChange?: (state: UpdaterState) => void;
  prepareForInstall?: () => void | Promise<void>;
}

const DEFAULT_CHECK_INTERVAL_MS = 4 * 3600000;

let initialized = false;
let state: UpdaterState = { status: 'idle', downloaded: false };
let promptShownForDownloadedUpdate = false;
let manualCheckActive = false;
let notifyStateChange: (state: UpdaterState) => void = () => {};
let recordingGuard: () => boolean = () => false;
let prepareForUpdateInstall: () => void | Promise<void> = () => {};

function cloneState(): UpdaterState {
  return { ...state };
}

function setState(next: Partial<UpdaterState>): void {
  state = { ...state, ...next };
  notifyStateChange(cloneState());
}

function getVersion(info: unknown): string | undefined {
  if (info && typeof info === 'object' && 'version' in info) {
    const version = (info as { version?: unknown }).version;
    return typeof version === 'string' ? version : undefined;
  }
  return undefined;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Remove stale cached installer files left by previous updates.
 *
 * electron-updater downloads to `%LOCALAPPDATA%/<appName>-updater/pending/`
 * and NSIS drops a copy at the cache root. Neither is cleaned automatically,
 * so every update leaves ~143 MB behind. Call this on startup (before any new
 * update check) so old installers don't accumulate indefinitely.
 */
async function cleanupUpdaterCache(): Promise<void> {
  try {
    const cacheDir = join(app.getPath('userData'), '..', 'meeting-notetaker-desktop-updater');
    const filesToRemove = ['installer.exe', 'current.blockmap'];

    for (const name of filesToRemove) {
      const fullPath = join(cacheDir, name);
      try {
        await rm(fullPath, { force: true, maxRetries: 2 });
      } catch {
        // File may not exist or be locked; that's fine.
      }
    }
  } catch {
    // Updater cache directory may not exist yet; that's fine.
  }
}

async function showManualDialog(type: 'info' | 'error', title: string, message: string): Promise<void> {
  await dialog.showMessageBox({
    type,
    title,
    message,
    buttons: ['OK'],
    defaultId: 0,
  });
}

async function promptForDownloadedUpdate(): Promise<void> {
  if (promptShownForDownloadedUpdate) return;
  promptShownForDownloadedUpdate = true;

  const versionText = state.version ? `Version ${state.version}` : 'A new version';
  const result = await dialog.showMessageBox({
    type: 'info',
    title: 'Update ready',
    message: `${versionText} has been downloaded. Restart Meeting Note-Taker to install it?`,
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });

  if (result.response === 0) {
    await installDownloadedUpdate();
  }
}

async function installDownloadedUpdate(): Promise<boolean> {
  if (!state.downloaded) {
    await showManualDialog('info', 'No update ready', 'No downloaded update is ready to install yet.');
    return false;
  }

  if (recordingGuard()) {
    await dialog.showMessageBox({
      type: 'warning',
      title: 'Finish recording first',
      message: 'Finish your recording first, then restart to update.',
      buttons: ['OK'],
      defaultId: 0,
    });
    return false;
  }

  console.log('[updater] Preparing app shutdown for downloaded update.');
  try {
    await prepareForUpdateInstall();
  } catch (err) {
    const message = describeError(err);
    console.warn('[updater] Update shutdown preparation failed:', message);
    await dialog.showMessageBox({
      type: 'error',
      title: 'Update restart failed',
      message: `Meeting Note-Taker could not safely restart for the update: ${message}`,
      buttons: ['OK'],
      defaultId: 0,
    });
    return false;
  }

  console.log('[updater] Installing downloaded update after user approval.');
  autoUpdater.quitAndInstall(true, false);
  return true;
}

function registerUpdaterHandlers(): void {
  autoUpdater.autoDownload = true;

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] Checking for updates...');
    setState({ status: 'checking', error: undefined });
  });

  autoUpdater.on('update-available', (info: unknown) => {
    const version = getVersion(info);
    console.log(`[updater] Update available${version ? `: ${version}` : ''}. Downloading...`);
    setState({ status: 'available', version, downloaded: false, percent: undefined, error: undefined });
  });

  autoUpdater.on('download-progress', (progress: unknown) => {
    const percent = progress && typeof progress === 'object' && 'percent' in progress
      ? Number((progress as { percent?: unknown }).percent)
      : undefined;
    const safePercent = Number.isFinite(percent) ? percent : undefined;
    if (safePercent !== undefined) {
      console.log(`[updater] Download progress: ${safePercent.toFixed(1)}%`);
    }
    setState({ status: 'downloading', percent: safePercent });
  });

  autoUpdater.on('update-downloaded', (info: unknown) => {
    const version = getVersion(info);
    console.log(`[updater] Update downloaded${version ? `: ${version}` : ''}. Waiting for user restart approval.`);
    setState({ status: 'downloaded', version: version ?? state.version, percent: 100, downloaded: true, error: undefined });
    void promptForDownloadedUpdate();
  });

  autoUpdater.on('update-not-available', (info: unknown) => {
    const version = getVersion(info);
    console.log(`[updater] Update not available${version ? `; latest is ${version}` : ''}.`);
    setState({ status: 'not-available', version, downloaded: false, percent: undefined, error: undefined });
    if (manualCheckActive) {
      void showManualDialog('info', 'No update available', 'Meeting Note-Taker is up to date.');
    }
  });

  autoUpdater.on('error', (err: Error) => {
    const message = describeError(err);
    console.warn('[updater] Auto-update failed (non-fatal):', message);
    setState({ status: 'error', error: message });
    if (manualCheckActive) {
      void showManualDialog('error', 'Update check failed', `The update check failed: ${message}`);
    }
  });
}

export function resetUpdaterStateForTests(): void {
  initialized = false;
  state = { status: 'idle', downloaded: false };
  promptShownForDownloadedUpdate = false;
  manualCheckActive = false;
  notifyStateChange = () => {};
  recordingGuard = () => false;
  prepareForUpdateInstall = () => {};
}

export function initUpdater(options: UpdaterOptions): UpdaterController {
  recordingGuard = options.isRecording;
  prepareForUpdateInstall = options.prepareForInstall ?? (() => {});
  notifyStateChange = options.onStateChange ?? (() => {});

  if (!initialized) {
    registerUpdaterHandlers();
    initialized = true;
  }

  const controller: UpdaterController = {
    async checkForUpdates(manual = false): Promise<void> {
      if (!options.isPackaged) {
        console.log('[updater] Skipping update check in development.');
        if (manual) {
          await showManualDialog('info', 'Updates unavailable in development', 'Update checks only run in the installed app.');
        }
        return;
      }

      manualCheckActive = manual;
      try {
        console.log(`[updater] ${manual ? 'Manual' : 'Automatic'} update check requested.`);
        await autoUpdater.checkForUpdates();
      } catch (err) {
        const message = describeError(err);
        console.warn('[updater] Update check failed (non-fatal):', message);
        setState({ status: 'error', error: message });
        if (manual) {
          await showManualDialog('error', 'Update check failed', `The update check failed: ${message}`);
        }
      } finally {
        manualCheckActive = false;
      }
    },

    installDownloadedUpdate,

    getState(): UpdaterState {
      return cloneState();
    },
  };

  if (options.isPackaged && options.checkIntervalMs !== 0) {
    void cleanupUpdaterCache().then(() => controller.checkForUpdates(false));
    setInterval(() => void controller.checkForUpdates(false), options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS);
  }

  return controller;
}
