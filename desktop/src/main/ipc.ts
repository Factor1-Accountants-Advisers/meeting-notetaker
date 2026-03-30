import { ipcMain, BrowserWindow, shell, app } from 'electron';
import * as path from 'path';
import { acquireToken, acquireIdToken, clearTokenCache } from './auth';
import { getUpcomingMeetings, CalendarEvent } from './graph';
import {
  startRecording,
  stopRecording,
  isRecording,
  getRecordingStatus,
  RecordingOptions,
} from './recorder';
import { uploadRecording, MeetingMetadata, UploadResult } from './uploader';
import { setPendingMeeting } from './tray';
import { getMainWindow } from './index';
import ffmpegPath from 'ffmpeg-static';
import { execFile, spawn } from 'child_process';

type AudioDeviceInfo = { name: string; id: string };
type WindowsDefaultDevices = { capture: string; render: string };

const FFMPEG_BINARY: string = (() => {
  if (!ffmpegPath) throw new Error('ffmpeg-static did not resolve a binary for this platform');
  return ffmpegPath;
})();

// In-app recording state (mirrors what tray.ts does for tray-initiated recordings)
let _ipcOutputPath = '';
let _ipcMetadata: MeetingMetadata | null = null;

function broadcastRecordingStatus(): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('recorder:status-changed', getRecordingStatus());
  }
}

export function parseAudioDevicesFromFfmpegOutput(output: string): AudioDeviceInfo[] {
  const devices: AudioDeviceInfo[] = [];
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
    if (!match || line.includes('Alternative name')) continue;

    const isExplicitAudioLine = /\(audio\)\s*$/i.test(line);
    if (inAudioSection || isExplicitAudioLine) {
      devices.push({ name: match[1], id: match[1] });
    }
  }

  return devices;
}

export async function listAudioDevices(): Promise<AudioDeviceInfo[]> {
  try {
    const stderr = await new Promise<string>((resolve) => {
      execFile(
        FFMPEG_BINARY,
        ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
        { timeout: 5000 },
        (
          error: Error | null,
          _stdout: string | Buffer,
          stderrOutput: string | Buffer,
        ) => {
          if (error && stderrOutput === undefined) {
            resolve('');
            return;
          }
          resolve(typeof stderrOutput === 'string' ? stderrOutput : stderrOutput.toString());
        },
      );
    });

    return parseAudioDevicesFromFfmpegOutput(stderr);
  } catch {
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

async function queryWindowsDefaultDevices(): Promise<WindowsDefaultDevices | null> {
  try {
    const child = spawn(
      'powershell', ['-NoProfile', '-NonInteractive', '-File', '-'],
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 8000 },
    );

    child.stdin.write(GET_DEFAULTS_PS);
    child.stdin.end();

    const stdout = await new Promise<string>((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
      child.on('close', (code: number) => code === 0 ? resolve(out) : reject(new Error(`exit ${code}`)));
      child.on('error', reject);
    });

    const capture = stdout.match(/^capture=(.+)$/m)?.[1]?.trim() ?? '';
    const render = stdout.match(/^render=(.+)$/m)?.[1]?.trim() ?? '';
    if (capture || render) return { capture, render };
    return null;
  } catch (err) {
    console.warn('[ipc] queryWindowsDefaultDevices failed:', err);
    return null;
  }
}

export function selectDefaultAudioDevices(
  devices: AudioDeviceInfo[],
  winDefaults: WindowsDefaultDevices | null,
): { micName: string; loopbackName: string } {
  const lower = (s: string) => s.toLowerCase();
  const isLoopback = (name: string) =>
    LOOPBACK_KEYWORDS.some((kw) => lower(name).includes(kw));

  const mic =
    (winDefaults?.capture
      ? devices.find((d) => d.name === winDefaults.capture)
      : undefined) ??
    devices.find((d) => !isLoopback(d.name));

  const loopback =
    (winDefaults?.render
      ? devices.find((d) => d.name === winDefaults.render && d.name !== mic?.name)
      : undefined) ??
    devices.find((d) => d.name !== mic?.name && isLoopback(d.name));

  return {
    micName: mic?.name ?? '',
    loopbackName: loopback?.name ?? '',
  };
}

export async function pickDefaultDevices(
  devices: AudioDeviceInfo[],
): Promise<{ micName: string; loopbackName: string }> {
  const winDefaults = await queryWindowsDefaultDevices();
  return selectDefaultAudioDevices(devices, winDefaults);
}

export function registerIpcHandlers(): void {
  ipcMain.handle('auth:get-token', (): Promise<string> => acquireToken());
  ipcMain.handle('auth:sign-out', (): Promise<void> => clearTokenCache());

  ipcMain.handle('graph:get-calendar', async (): Promise<CalendarEvent[]> => {
    console.log('[ipc] graph:get-calendar — acquiring token...');
    const token = await acquireToken();
    console.log('[ipc] graph:get-calendar — token acquired, fetching calendar...');
    const events = await getUpcomingMeetings(token);
    console.log(`[ipc] graph:get-calendar — got ${events.length} events`);
    return events;
  });

  ipcMain.handle('recorder:start', (_e, opts: RecordingOptions & { metadata?: MeetingMetadata }): void => {
    // Generate output path (same approach as tray.ts)
    const outputPath = opts.outputPath || path.join(app.getPath('temp'), `meeting-${Date.now()}.wav`);
    _ipcOutputPath = outputPath;
    _ipcMetadata = opts.metadata || null;

    startRecording({
      micName: opts.micName,
      loopbackName: opts.loopbackName,
      outputPath,
      meetingTitle: _ipcMetadata?.meeting_title,
    });
    broadcastRecordingStatus();
    console.log(`[ipc] recorder:start — recording to ${outputPath}`);
  });

  ipcMain.handle('recorder:stop', (): string => {
    stopRecording();
    broadcastRecordingStatus();
    const outputPath = _ipcOutputPath;
    console.log(`[ipc] recorder:stop — file at ${outputPath}`);
    return outputPath;
  });

  ipcMain.handle('recorder:is-recording', (): boolean => isRecording());
  ipcMain.handle('recorder:get-status', () => getRecordingStatus());

  ipcMain.handle(
    'uploader:upload',
    async (_e, args: { filePath: string; metadata: MeetingMetadata }): Promise<UploadResult> => {
      const token = await acquireIdToken();
      const backendUrl = process.env.BACKEND_URL ?? 'http://localhost:8000';
      return uploadRecording({ filePath: args.filePath, accessToken: token, backendUrl, metadata: args.metadata });
    }
  );

  ipcMain.handle('shell:open-web-app', (_e, url: string): Promise<void> => shell.openExternal(url));

  ipcMain.handle('meeting-selector:select', (_e, event: CalendarEvent): void => {
    setPendingMeeting(event.subject, event.attendees, event.start);
    BrowserWindow.fromWebContents(_e.sender)?.close();
  });

  ipcMain.on('meeting-selector:close', (e): void => {
    BrowserWindow.fromWebContents(e.sender)?.close();
  });

  ipcMain.handle('auth:get-id-token', (): Promise<string> => acquireIdToken());
  ipcMain.handle('app:get-backend-url', (): string => process.env.BACKEND_URL ?? 'http://localhost:8000');
  ipcMain.on('app:get-version', (e): void => { e.returnValue = app.getVersion(); });

  ipcMain.handle('audio:get-devices', async (): Promise<{ name: string; id: string }[]> => {
    return listAudioDevices();
  });

  ipcMain.handle('audio:get-default-devices', async (): Promise<{ micName: string; loopbackName: string }> => {
    const devices = await listAudioDevices();
    return await pickDefaultDevices(devices);
  });
}
