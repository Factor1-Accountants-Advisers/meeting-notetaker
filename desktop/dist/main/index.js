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
exports.showMainWindow = showMainWindow;
exports.getMainWindow = getMainWindow;
const dotenv = __importStar(require("dotenv"));
const path = __importStar(require("path"));
dotenv.config({ path: path.join(process.cwd(), '.env.local') });
const electron_1 = require("electron");
const electron_updater_1 = require("electron-updater");
const tray_1 = require("./tray");
const ipc_1 = require("./ipc");
const protocol_1 = require("./protocol");
if (!electron_1.app.requestSingleInstanceLock())
    electron_1.app.quit();
electron_1.app.disableHardwareAcceleration();
let mainWindow = null;
const backendUrl = process.env.BACKEND_URL ?? 'http://localhost:8000';
function createMainWindow() {
    const win = new electron_1.BrowserWindow({
        width: 1200,
        height: 800,
        title: 'Meeting Note-Taker',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '../renderer/preload-web.js'),
        },
    });
    if (!electron_1.app.isPackaged && process.env.WEB_DEV_URL) {
        // Dev mode: load from Next.js dev server
        win.loadURL(process.env.WEB_DEV_URL);
    }
    else {
        // Production: load from static export via custom protocol
        win.loadURL('app://renderer/index.html');
    }
    win.on('close', (e) => {
        // Hide instead of quit — tray keeps running
        e.preventDefault();
        win.hide();
    });
    return win;
}
function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        mainWindow = createMainWindow();
    }
    else {
        mainWindow.show();
        mainWindow.focus();
    }
}
function getMainWindow() {
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}
electron_1.app.on('window-all-closed', (e) => e.preventDefault());
electron_1.app.whenReady().then(() => {
    (0, ipc_1.registerIpcHandlers)();
    // Register protocol once, before any window is created
    if (electron_1.app.isPackaged || !process.env.WEB_DEV_URL) {
        const staticDir = path.join(__dirname, '../../web-out');
        (0, protocol_1.registerAppProtocol)(staticDir, backendUrl);
    }
    // Pass showMainWindow into tray to avoid circular dependency
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
    // Show main window on startup
    mainWindow = createMainWindow();
    if (electron_1.app.isPackaged) {
        void electron_updater_1.autoUpdater.checkForUpdatesAndNotify();
        setInterval(() => void electron_updater_1.autoUpdater.checkForUpdatesAndNotify(), 4 * 3600000);
    }
});
//# sourceMappingURL=index.js.map