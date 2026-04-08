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
exports.updateTrayDevices = updateTrayDevices;
exports.setPendingMeeting = setPendingMeeting;
exports.createTray = createTray;
exports.handleStartRecording = handleStartRecording;
const electron_1 = require("electron");
const path = __importStar(require("path"));
const recorder_1 = require("./recorder");
const auth_1 = require("./auth");
const uploader_1 = require("./uploader");
const index_1 = require("./index");
const IDLE_ICON = path.join(__dirname, '../../assets/icon-idle.png');
const RECORDING_ICON = path.join(__dirname, '../../assets/icon-recording.png');
let tray = null;
let meetingSelectorWindow = null;
let _backendUrl = 'http://localhost:8000';
let _onOpenApp = () => { };
let _recordingOutputDir = '';
let _micName = '';
let _loopbackName = '';
let _pendingTitle = '';
let _pendingAttendees = [];
let _pendingScheduledTime;
function updateTrayDevices(micName, loopbackName) {
    _micName = micName;
    _loopbackName = loopbackName;
}
function setPendingMeeting(title, attendees, scheduledTime) {
    _pendingTitle = title;
    _pendingAttendees = attendees;
    _pendingScheduledTime = scheduledTime;
}
function createTray(config) {
    _backendUrl = config.backendUrl;
    _onOpenApp = config.onOpenApp;
    _recordingOutputDir = config.recordingOutputDir;
    _micName = config.micName;
    _loopbackName = config.loopbackName;
    tray = new electron_1.Tray(electron_1.nativeImage.createFromPath(IDLE_ICON));
    tray.setToolTip('Meeting Note-Taker');
    tray.on('click', () => _onOpenApp());
    rebuildMenu();
    return tray;
}
function rebuildMenu() {
    if (!tray)
        return;
    const recording = (0, recorder_1.isRecording)();
    tray.setContextMenu(electron_1.Menu.buildFromTemplate([
        { label: 'Start Recording', enabled: !recording, click: handleStartRecording },
        { label: 'Stop Recording', enabled: recording, click: handleStopRecording },
        { type: 'separator' },
        { label: 'Open App', click: () => _onOpenApp() },
        { type: 'separator' },
        { label: 'Quit', click: () => electron_1.app.quit() },
    ]));
}
function broadcastRecordingStatus() {
    const win = (0, index_1.getMainWindow)();
    if (win && !win.isDestroyed()) {
        win.webContents.send('recorder:status-changed', (0, recorder_1.getRecordingStatus)());
    }
}
function handleStartRecording() {
    if (!_micName || !_loopbackName) {
        console.error('[tray] Cannot start recording — audio devices not configured. Open the app and go to Settings.');
        _onOpenApp();
        return;
    }
    const outputPath = path.join(_recordingOutputDir, `meeting-${Date.now()}.wav`);
    const metadata = {
        meeting_title: _pendingTitle || `Recording ${new Date().toLocaleString()}`,
        attendees: _pendingAttendees,
        scheduled_time: _pendingScheduledTime,
    };
    try {
        (0, recorder_1.startRecording)({
            micName: _micName,
            loopbackName: _loopbackName,
            outputPath,
            meetingTitle: metadata.meeting_title,
            metadata,
        });
        tray?.setImage(electron_1.nativeImage.createFromPath(RECORDING_ICON));
        tray?.setToolTip('Meeting Note-Taker — Recording...');
        rebuildMenu();
        broadcastRecordingStatus();
    }
    catch (err) {
        console.error('[tray] Failed to start recording:', err);
        tray?.setToolTip('Meeting Note-Taker — Recording failed');
        setTimeout(() => { tray?.setToolTip('Meeting Note-Taker'); }, 3000);
    }
}
async function handleStopRecording() {
    const result = (0, recorder_1.stopRecording)();
    tray?.setImage(electron_1.nativeImage.createFromPath(IDLE_ICON));
    tray?.setToolTip('Meeting Note-Taker — Uploading...');
    rebuildMenu();
    broadcastRecordingStatus();
    try {
        if (!result.outputPath) {
            throw new Error(result.error || 'Recording failed before the audio file could be saved.');
        }
        const token = await (0, auth_1.acquireIdToken)();
        const metadata = result.metadata ?? {
            meeting_title: _pendingTitle || `Recording ${new Date().toLocaleString()}`,
            attendees: _pendingAttendees,
            scheduled_time: _pendingScheduledTime,
        };
        await (0, uploader_1.uploadRecording)({ filePath: result.outputPath, accessToken: token, backendUrl: _backendUrl, metadata });
        tray?.setToolTip('Meeting Note-Taker — Upload complete');
    }
    catch (err) {
        console.error('[tray] upload failed:', err);
        tray?.setToolTip('Meeting Note-Taker — Upload failed');
    }
    _pendingTitle = '';
    _pendingAttendees = [];
    _pendingScheduledTime = undefined;
    setTimeout(() => { tray?.setToolTip('Meeting Note-Taker'); rebuildMenu(); }, 3000);
}
function openMeetingSelector() {
    if (meetingSelectorWindow && !meetingSelectorWindow.isDestroyed()) {
        meetingSelectorWindow.focus();
        return;
    }
    meetingSelectorWindow = new electron_1.BrowserWindow({
        width: 480, height: 400, resizable: false, alwaysOnTop: true,
        title: 'Select Meeting',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '../renderer/meeting-selector/preload.js'),
        },
    });
    meetingSelectorWindow.loadFile(path.join(__dirname, '../renderer/meeting-selector/index.html'));
    meetingSelectorWindow.on('closed', () => { meetingSelectorWindow = null; });
}
//# sourceMappingURL=tray.js.map