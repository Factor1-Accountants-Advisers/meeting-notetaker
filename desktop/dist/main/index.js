"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMainWindow = createMainWindow;
exports.showMainWindow = showMainWindow;
exports.getMainWindow = getMainWindow;
exports.prepareForUpdateInstall = prepareForUpdateInstall;
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const electron_1 = require("electron");
const tray_1 = require("./tray");
const ipc_1 = require("./ipc");
const protocol_1 = require("./protocol");
const scheduler_1 = require("./scheduler");
const runtime_paths_1 = require("./runtime-paths");
const backend_runtime_1 = require("./backend-runtime");
const wasapi_capture_1 = require("./wasapi-capture");
const recorder_1 = require("./recorder");
const updater_1 = require("./updater");
// Load environment — must happen before anything reads process.env
(0, runtime_paths_1.loadEnv)();
// Mirror console output to a file in packaged mode. On Windows, console.log
// in a packaged Electron app goes nowhere visible, which makes diagnosing
// install-time failures (backend spawn, WASAPI renderer hangs) impossible.
// Log file lives at %APPDATA%\meeting-notetaker-desktop\logs\main.log.
if (electron_1.app.isPackaged) {
    try {
        const logDir = path.join(electron_1.app.getPath('userData'), 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        const stream = fs.createWriteStream(path.join(logDir, 'main.log'), { flags: 'a' });
        const fmt = (args) => args.map((a) => {
            if (a instanceof Error)
                return `${a.message}\n${a.stack ?? ''}`;
            return typeof a === 'string' ? a : JSON.stringify(a);
        }).join(' ');
        const origLog = console.log;
        const origWarn = console.warn;
        const origError = console.error;
        console.log = (...args) => {
            stream.write(`[${new Date().toISOString()}] ${fmt(args)}\n`);
            origLog(...args);
        };
        console.warn = (...args) => {
            stream.write(`[${new Date().toISOString()}] WARN ${fmt(args)}\n`);
            origWarn(...args);
        };
        console.error = (...args) => {
            stream.write(`[${new Date().toISOString()}] ERROR ${fmt(args)}\n`);
            origError(...args);
        };
        stream.write(`\n=== App started ${new Date().toISOString()} ===\n`);
    }
    catch {
        // Logging setup failed — not fatal. Carry on with default console behavior.
    }
}
// Must be called BEFORE app.whenReady(). Without this the app:// scheme is
// treated as opaque/non-secure, which breaks ES modules, fetch, and
// localStorage — causing Next.js to throw a client-side exception on mount.
electron_1.protocol.registerSchemesAsPrivileged([
    {
        scheme: 'app',
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            corsEnabled: true,
            stream: true,
        },
    },
]);
if (!electron_1.app.requestSingleInstanceLock())
    electron_1.app.quit();
let mainWindow = null;
let isQuitting = false;
function createMainWindow() {
    const win = new electron_1.BrowserWindow({
        width: 1200,
        height: 800,
        show: false,
        title: 'Meeting Note-Taker',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '../renderer/preload-web.js'),
        },
    });
    if (!electron_1.app.isPackaged && process.env.WEB_DEV_URL) {
        win.loadURL(process.env.WEB_DEV_URL);
    }
    else {
        win.loadURL('app://renderer/index.html');
    }
    // Surface renderer failures into the main-process log so the packaged app
    // isn't silent if something goes wrong during hydration.
    win.webContents.on('render-process-gone', (_e, details) => {
        console.error('[renderer] render-process-gone:', details);
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
        console.error(`[renderer] did-fail-load ${code} ${desc} for ${url}`);
    });
    win.webContents.on('console-message', (_e, level, message, line, source) => {
        if (level >= 2) {
            console.log(`[renderer:console] ${source}:${line} ${message}`);
        }
    });
    if (process.env.OPEN_DEVTOOLS === '1') {
        win.webContents.openDevTools({ mode: 'detach' });
    }
    win.on('close', (e) => {
        if (!isQuitting) {
            e.preventDefault();
            win.hide();
        }
    });
    return win;
}
function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        mainWindow = createMainWindow();
    }
    mainWindow.show();
    mainWindow.focus();
}
function getMainWindow() {
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}
// Restore window when user launches the app again
electron_1.app.on('second-instance', () => {
    showMainWindow();
});
electron_1.app.on('window-all-closed', (e) => {
    if (!isQuitting)
        e.preventDefault();
});
electron_1.app.on('before-quit', () => {
    isQuitting = true;
});
function prepareForUpdateInstall() {
    console.log('[shutdown] Preparing deterministic shutdown for updater install...');
    isQuitting = true;
    (0, scheduler_1.stopScheduler)();
    (0, tray_1.destroyTray)();
    (0, wasapi_capture_1.destroyCaptureWindow)();
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.destroy();
        mainWindow = null;
    }
    (0, backend_runtime_1.stopBackend)({ forceTree: true });
    console.log('[shutdown] Updater shutdown preparation complete.');
}
electron_1.app.whenReady().then(async () => {
    (0, ipc_1.registerIpcHandlers)();
    // Initialize WASAPI capture (hidden renderer window + permission handlers).
    // Must run after app is ready so session.defaultSession is available.
    (0, wasapi_capture_1.initializeWasapiCapture)();
    // Start the bundled backend (packaged) or assume external (dev)
    const backendUrl = (0, runtime_paths_1.getBackendUrl)();
    if (electron_1.app.isPackaged) {
        try {
            console.log('[startup] Starting bundled backend...');
            await (0, backend_runtime_1.startBackend)();
            console.log('[startup] Backend is ready.');
        }
        catch (err) {
            console.error('[startup] Backend failed to start:', err);
        }
    }
    // Register protocol once, before any window is created
    if (electron_1.app.isPackaged || !process.env.WEB_DEV_URL) {
        const staticDir = path.join(__dirname, '../../web-out');
        (0, protocol_1.registerAppProtocol)(staticDir, backendUrl);
    }
    (0, tray_1.createTray)({
        backendUrl,
        recordingOutputDir: electron_1.app.getPath('temp'),
        micName: process.env.MIC_DEVICE_NAME ?? '',
        loopbackName: process.env.LOOPBACK_DEVICE_NAME ?? '',
        onOpenApp: showMainWindow,
    });
    // Auto-detect audio devices for tray recording (non-blocking)
    (0, ipc_1.listAudioDevices)().then((devices) => (0, ipc_1.pickDefaultDevices)(devices).then((defaults) => {
        if (defaults.micName || defaults.loopbackName) {
            (0, tray_1.updateTrayDevices)(defaults.micName, defaults.loopbackName);
            console.log(`[startup] Auto-detected audio: mic="${defaults.micName}", loopback="${defaults.loopbackName}"`);
        }
    })).catch((err) => console.warn('[startup] Audio device detection failed:', err));
    mainWindow = createMainWindow();
    if (!electron_1.app.isPackaged && process.env.SHOW_WINDOW_ON_START === '1') {
        showMainWindow();
    }
    (0, scheduler_1.startScheduler)();
    const updater = (0, updater_1.initUpdater)({
        isPackaged: electron_1.app.isPackaged,
        isRecording: recorder_1.isRecording,
        prepareForInstall: prepareForUpdateInstall,
        onStateChange: () => (0, tray_1.syncTrayToRecordingState)(),
    });
    (0, tray_1.setTrayUpdater)(updater);
});
electron_1.app.on('will-quit', () => {
    (0, scheduler_1.stopScheduler)();
    (0, tray_1.destroyTray)();
    (0, wasapi_capture_1.destroyCaptureWindow)();
    (0, backend_runtime_1.stopBackend)();
});
//# sourceMappingURL=index.js.map