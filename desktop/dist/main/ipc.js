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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseAudioDevicesFromFfmpegOutput = parseAudioDevicesFromFfmpegOutput;
exports.listAudioDevices = listAudioDevices;
exports.selectDefaultAudioDevices = selectDefaultAudioDevices;
exports.pickDefaultDevices = pickDefaultDevices;
exports.registerIpcHandlers = registerIpcHandlers;
const electron_1 = require("electron");
const path = __importStar(require("path"));
const auth_1 = require("./auth");
const graph_1 = require("./graph");
const recorder_1 = require("./recorder");
const uploader_1 = require("./uploader");
const tray_1 = require("./tray");
const index_1 = require("./index");
const ffmpeg_static_1 = __importDefault(require("ffmpeg-static"));
const child_process_1 = require("child_process");
const FFMPEG_BINARY = (() => {
    if (!ffmpeg_static_1.default)
        throw new Error('ffmpeg-static did not resolve a binary for this platform');
    return ffmpeg_static_1.default;
})();
// In-app recording state (mirrors what tray.ts does for tray-initiated recordings)
let _ipcOutputPath = '';
let _ipcMetadata = null;
function broadcastRecordingStatus() {
    const win = (0, index_1.getMainWindow)();
    if (win && !win.isDestroyed()) {
        win.webContents.send('recorder:status-changed', (0, recorder_1.getRecordingStatus)());
    }
}
function parseAudioDevicesFromFfmpegOutput(output) {
    const devices = [];
    const lines = output.split(/\r?\n/);
    let inAudioSection = false;
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.includes('DirectShow audio devices')) {
            inAudioSection = true;
            continue;
        }
        if (line.includes('DirectShow video devices')) {
            inAudioSection = false;
            continue;
        }
        const match = line.match(/"([^"]+)"/);
        if (!match || line.includes('Alternative name'))
            continue;
        const isExplicitAudioLine = /\(audio\)\s*$/i.test(line);
        if (inAudioSection || isExplicitAudioLine) {
            devices.push({ name: match[1], id: match[1] });
        }
    }
    return devices;
}
async function listAudioDevices() {
    try {
        const stderr = await new Promise((resolve) => {
            (0, child_process_1.execFile)(FFMPEG_BINARY, ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { timeout: 5000 }, (error, _stdout, stderrOutput) => {
                if (error && stderrOutput === undefined) {
                    resolve('');
                    return;
                }
                resolve(typeof stderrOutput === 'string' ? stderrOutput : stderrOutput.toString());
            });
        });
        return parseAudioDevicesFromFfmpegOutput(stderr);
    }
    catch {
        return [];
    }
}
/**
 * Query Windows Core Audio API (IMMDeviceEnumerator) for the system default
 * capture and render device friendly names. Returns them as-is — the names
 * match ffmpeg's DirectShow device list exactly.
 */
const GET_DEFAULTS_PS = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int NotImpl_EnumAudioEndpoints();
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int NotImpl_Activate();
    int OpenPropertyStore(int stgmAccess, out IPropertyStore props);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
}

[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore {
    int GetCount(out int count);
    int GetAt(int index, out PropertyKey key);
    int GetValue(ref PropertyKey key, out PropVariant value);
}

[StructLayout(LayoutKind.Sequential)]
public struct PropertyKey {
    public Guid fmtid;
    public int pid;
}

[StructLayout(LayoutKind.Sequential)]
public struct PropVariant {
    public short vt;
    short wReserved1, wReserved2, wReserved3;
    public IntPtr data1;
    public IntPtr data2;
}

public class AudioHelper {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObj { }

    static readonly PropertyKey PKEY_DeviceFriendlyName = new PropertyKey {
        fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14
    };

    static string GetEndpointName(IMMDevice device) {
        IPropertyStore store;
        device.OpenPropertyStore(0, out store);
        var pk = PKEY_DeviceFriendlyName;
        PropVariant val;
        store.GetValue(ref pk, out val);
        return Marshal.PtrToStringUni(val.data1) ?? "";
    }

    public static string GetDefaultRender() {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObj());
        IMMDevice dev;
        enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
        return GetEndpointName(dev);
    }

    public static string GetDefaultCapture() {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObj());
        IMMDevice dev;
        enumerator.GetDefaultAudioEndpoint(1, 1, out dev);
        return GetEndpointName(dev);
    }
}
'@

Write-Output "capture=$([AudioHelper]::GetDefaultCapture())"
Write-Output "render=$([AudioHelper]::GetDefaultRender())"
`;
/** Loopback keyword fallback when PowerShell query fails. */
const LOOPBACK_KEYWORDS = [
    'stereo mix', 'what u hear', 'wave out', 'loopback',
    'cable output', 'vb-audio', 'virtual cable', 'voicemeeter',
];
async function queryWindowsDefaultDevices() {
    try {
        const child = (0, child_process_1.spawn)('powershell', ['-NoProfile', '-NonInteractive', '-File', '-'], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 8000 });
        child.stdin.write(GET_DEFAULTS_PS);
        child.stdin.end();
        const stdout = await new Promise((resolve, reject) => {
            let out = '';
            child.stdout.on('data', (chunk) => { out += chunk.toString(); });
            child.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(`exit ${code}`)));
            child.on('error', reject);
        });
        const capture = stdout.match(/^capture=(.+)$/m)?.[1]?.trim() ?? '';
        const render = stdout.match(/^render=(.+)$/m)?.[1]?.trim() ?? '';
        if (capture || render)
            return { capture, render };
        return null;
    }
    catch (err) {
        console.warn('[ipc] queryWindowsDefaultDevices failed:', err);
        return null;
    }
}
function selectDefaultAudioDevices(devices, winDefaults) {
    const lower = (s) => s.toLowerCase();
    const isLoopback = (name) => LOOPBACK_KEYWORDS.some((kw) => lower(name).includes(kw));
    const mic = (winDefaults?.capture
        ? devices.find((d) => d.name === winDefaults.capture)
        : undefined) ??
        devices.find((d) => !isLoopback(d.name));
    const loopback = (winDefaults?.render
        ? devices.find((d) => d.name === winDefaults.render && d.name !== mic?.name)
        : undefined) ??
        devices.find((d) => d.name !== mic?.name && isLoopback(d.name));
    return {
        micName: mic?.name ?? '',
        loopbackName: loopback?.name ?? '',
    };
}
async function pickDefaultDevices(devices) {
    const winDefaults = await queryWindowsDefaultDevices();
    return selectDefaultAudioDevices(devices, winDefaults);
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
        (0, recorder_1.startRecording)({
            micName: opts.micName,
            loopbackName: opts.loopbackName,
            outputPath,
            meetingTitle: _ipcMetadata?.meeting_title,
        });
        broadcastRecordingStatus();
        console.log(`[ipc] recorder:start — recording to ${outputPath}`);
    });
    electron_1.ipcMain.handle('recorder:stop', () => {
        (0, recorder_1.stopRecording)();
        broadcastRecordingStatus();
        const outputPath = _ipcOutputPath;
        console.log(`[ipc] recorder:stop — file at ${outputPath}`);
        return outputPath;
    });
    electron_1.ipcMain.handle('recorder:is-recording', () => (0, recorder_1.isRecording)());
    electron_1.ipcMain.handle('recorder:get-status', () => (0, recorder_1.getRecordingStatus)());
    electron_1.ipcMain.handle('uploader:upload', async (_e, args) => {
        const token = await (0, auth_1.acquireIdToken)();
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
        return listAudioDevices();
    });
    electron_1.ipcMain.handle('audio:get-default-devices', async () => {
        const devices = await listAudioDevices();
        return await pickDefaultDevices(devices);
    });
}
//# sourceMappingURL=ipc.js.map