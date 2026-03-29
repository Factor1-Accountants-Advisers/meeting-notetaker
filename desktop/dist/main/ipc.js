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
exports.registerIpcHandlers = registerIpcHandlers;
const electron_1 = require("electron");
const path = __importStar(require("path"));
const auth_1 = require("./auth");
const graph_1 = require("./graph");
const recorder_1 = require("./recorder");
const uploader_1 = require("./uploader");
const tray_1 = require("./tray");
const index_1 = require("./index");
const child_process_1 = require("child_process");
const util_1 = require("util");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
// In-app recording state (mirrors what tray.ts does for tray-initiated recordings)
let _ipcOutputPath = '';
let _ipcMetadata = null;
function broadcastRecordingStatus(recording, meetingTitle) {
    const win = (0, index_1.getMainWindow)();
    if (win && !win.isDestroyed()) {
        win.webContents.send('recorder:status-changed', {
            recording,
            meetingTitle: meetingTitle || undefined,
            startedAt: recording ? Date.now() : undefined,
        });
    }
}
function registerIpcHandlers() {
    electron_1.ipcMain.handle('auth:get-token', () => (0, auth_1.acquireToken)());
    electron_1.ipcMain.handle('auth:sign-out', () => (0, auth_1.clearTokenCache)());
    electron_1.ipcMain.handle('graph:get-calendar', async () => {
        console.log('[ipc] graph:get-calendar — acquiring token...');
        const token = await (0, auth_1.acquireToken)();
        console.log('[ipc] graph:get-calendar — token acquired, fetching calendar...');
        const events = await (0, graph_1.getUpcomingMeetings)(token);
        console.log(`[ipc] graph:get-calendar — got ${events.length} events`);
        return events;
    });
    electron_1.ipcMain.handle('recorder:start', (_e, opts) => {
        // Generate output path (same approach as tray.ts)
        const outputPath = opts.outputPath || path.join(electron_1.app.getPath('temp'), `meeting-${Date.now()}.wav`);
        _ipcOutputPath = outputPath;
        _ipcMetadata = opts.metadata || null;
        (0, recorder_1.startRecording)({ micName: opts.micName, loopbackName: opts.loopbackName, outputPath });
        broadcastRecordingStatus(true, _ipcMetadata?.meeting_title);
        console.log(`[ipc] recorder:start — recording to ${outputPath}`);
    });
    electron_1.ipcMain.handle('recorder:stop', () => {
        (0, recorder_1.stopRecording)();
        broadcastRecordingStatus(false);
        const outputPath = _ipcOutputPath;
        console.log(`[ipc] recorder:stop — file at ${outputPath}`);
        return outputPath;
    });
    electron_1.ipcMain.handle('recorder:is-recording', () => (0, recorder_1.isRecording)());
    electron_1.ipcMain.handle('uploader:upload', async (_e, args) => {
        const token = await (0, auth_1.acquireToken)();
        const backendUrl = process.env.BACKEND_URL ?? 'http://localhost:8000';
        return (0, uploader_1.uploadRecording)({ filePath: args.filePath, accessToken: token, backendUrl, metadata: args.metadata });
    });
    electron_1.ipcMain.handle('shell:open-web-app', (_e, url) => electron_1.shell.openExternal(url));
    electron_1.ipcMain.handle('meeting-selector:select', (_e, event) => {
        (0, tray_1.setPendingMeeting)(event.subject, event.attendees, event.start);
        electron_1.BrowserWindow.fromWebContents(_e.sender)?.close();
    });
    electron_1.ipcMain.on('meeting-selector:close', (e) => {
        electron_1.BrowserWindow.fromWebContents(e.sender)?.close();
    });
    electron_1.ipcMain.handle('auth:get-id-token', () => (0, auth_1.acquireIdToken)());
    electron_1.ipcMain.handle('app:get-backend-url', () => process.env.BACKEND_URL ?? 'http://localhost:8000');
    electron_1.ipcMain.on('app:get-version', (e) => { e.returnValue = electron_1.app.getVersion(); });
    electron_1.ipcMain.handle('audio:get-devices', async () => {
        try {
            const { stderr } = await execAsync('ffmpeg -list_devices true -f dshow -i dummy 2>&1', {
                timeout: 5000,
            }).catch((e) => ({ stderr: e.stderr || '', stdout: '' }));
            const devices = [];
            const lines = stderr.split('\n');
            let isAudio = false;
            for (const line of lines) {
                if (line.includes('DirectShow audio devices')) {
                    isAudio = true;
                    continue;
                }
                if (line.includes('DirectShow video devices')) {
                    isAudio = false;
                    continue;
                }
                if (isAudio) {
                    const match = line.match(/"([^"]+)"/);
                    if (match && !line.includes('Alternative name')) {
                        devices.push({ name: match[1], id: match[1] });
                    }
                }
            }
            return devices;
        }
        catch {
            return [];
        }
    });
}
//# sourceMappingURL=ipc.js.map