"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetUpdaterStateForTests = resetUpdaterStateForTests;
exports.initUpdater = initUpdater;
const electron_1 = require("electron");
const electron_updater_1 = require("electron-updater");
const DEFAULT_CHECK_INTERVAL_MS = 4 * 3600000;
let initialized = false;
let state = { status: 'idle', downloaded: false };
let promptShownForDownloadedUpdate = false;
let manualCheckActive = false;
let notifyStateChange = () => { };
let recordingGuard = () => false;
function cloneState() {
    return { ...state };
}
function setState(next) {
    state = { ...state, ...next };
    notifyStateChange(cloneState());
}
function getVersion(info) {
    if (info && typeof info === 'object' && 'version' in info) {
        const version = info.version;
        return typeof version === 'string' ? version : undefined;
    }
    return undefined;
}
function describeError(err) {
    if (err instanceof Error)
        return err.message;
    return String(err);
}
async function showManualDialog(type, title, message) {
    await electron_1.dialog.showMessageBox({
        type,
        title,
        message,
        buttons: ['OK'],
        defaultId: 0,
    });
}
async function promptForDownloadedUpdate() {
    if (promptShownForDownloadedUpdate)
        return;
    promptShownForDownloadedUpdate = true;
    const versionText = state.version ? `Version ${state.version}` : 'A new version';
    const result = await electron_1.dialog.showMessageBox({
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
async function installDownloadedUpdate() {
    if (!state.downloaded) {
        await showManualDialog('info', 'No update ready', 'No downloaded update is ready to install yet.');
        return false;
    }
    if (recordingGuard()) {
        await electron_1.dialog.showMessageBox({
            type: 'warning',
            title: 'Finish recording first',
            message: 'Finish your recording first, then restart to update.',
            buttons: ['OK'],
            defaultId: 0,
        });
        return false;
    }
    console.log('[updater] Installing downloaded update after user approval.');
    electron_updater_1.autoUpdater.quitAndInstall(true, true);
    return true;
}
function registerUpdaterHandlers() {
    electron_updater_1.autoUpdater.autoDownload = true;
    electron_updater_1.autoUpdater.on('checking-for-update', () => {
        console.log('[updater] Checking for updates...');
        setState({ status: 'checking', error: undefined });
    });
    electron_updater_1.autoUpdater.on('update-available', (info) => {
        const version = getVersion(info);
        console.log(`[updater] Update available${version ? `: ${version}` : ''}. Downloading...`);
        setState({ status: 'available', version, downloaded: false, percent: undefined, error: undefined });
    });
    electron_updater_1.autoUpdater.on('download-progress', (progress) => {
        const percent = progress && typeof progress === 'object' && 'percent' in progress
            ? Number(progress.percent)
            : undefined;
        const safePercent = Number.isFinite(percent) ? percent : undefined;
        if (safePercent !== undefined) {
            console.log(`[updater] Download progress: ${safePercent.toFixed(1)}%`);
        }
        setState({ status: 'downloading', percent: safePercent });
    });
    electron_updater_1.autoUpdater.on('update-downloaded', (info) => {
        const version = getVersion(info);
        console.log(`[updater] Update downloaded${version ? `: ${version}` : ''}. Waiting for user restart approval.`);
        setState({ status: 'downloaded', version: version ?? state.version, percent: 100, downloaded: true, error: undefined });
        void promptForDownloadedUpdate();
    });
    electron_updater_1.autoUpdater.on('update-not-available', (info) => {
        const version = getVersion(info);
        console.log(`[updater] Update not available${version ? `; latest is ${version}` : ''}.`);
        setState({ status: 'not-available', version, downloaded: false, percent: undefined, error: undefined });
        if (manualCheckActive) {
            void showManualDialog('info', 'No update available', 'Meeting Note-Taker is up to date.');
        }
    });
    electron_updater_1.autoUpdater.on('error', (err) => {
        const message = describeError(err);
        console.warn('[updater] Auto-update failed (non-fatal):', message);
        setState({ status: 'error', error: message });
        if (manualCheckActive) {
            void showManualDialog('error', 'Update check failed', `The update check failed: ${message}`);
        }
    });
}
function resetUpdaterStateForTests() {
    initialized = false;
    state = { status: 'idle', downloaded: false };
    promptShownForDownloadedUpdate = false;
    manualCheckActive = false;
    notifyStateChange = () => { };
    recordingGuard = () => false;
}
function initUpdater(options) {
    recordingGuard = options.isRecording;
    notifyStateChange = options.onStateChange ?? (() => { });
    if (!initialized) {
        registerUpdaterHandlers();
        initialized = true;
    }
    const controller = {
        async checkForUpdates(manual = false) {
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
                await electron_updater_1.autoUpdater.checkForUpdates();
            }
            catch (err) {
                const message = describeError(err);
                console.warn('[updater] Update check failed (non-fatal):', message);
                setState({ status: 'error', error: message });
                if (manual) {
                    await showManualDialog('error', 'Update check failed', `The update check failed: ${message}`);
                }
            }
            finally {
                manualCheckActive = false;
            }
        },
        installDownloadedUpdate,
        getState() {
            return cloneState();
        },
    };
    if (options.isPackaged && options.checkIntervalMs !== 0) {
        void controller.checkForUpdates(false);
        setInterval(() => void controller.checkForUpdates(false), options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS);
    }
    return controller;
}
//# sourceMappingURL=updater.js.map