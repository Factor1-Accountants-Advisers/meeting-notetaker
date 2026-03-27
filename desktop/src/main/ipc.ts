import { ipcMain, BrowserWindow, shell, app } from 'electron';
import { acquireToken, acquireIdToken, clearTokenCache } from './auth';
import { getUpcomingMeetings, CalendarEvent } from './graph';
import { startRecording, stopRecording, isRecording, RecordingOptions } from './recorder';
import { uploadRecording, MeetingMetadata, UploadResult } from './uploader';
import { setPendingMeeting } from './tray';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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

  ipcMain.handle('recorder:start', (_e, opts: RecordingOptions): void => startRecording(opts));
  ipcMain.handle('recorder:stop', (): void => stopRecording());
  ipcMain.handle('recorder:is-recording', (): boolean => isRecording());

  ipcMain.handle(
    'uploader:upload',
    async (_e, args: { recordingOptions: RecordingOptions; metadata: MeetingMetadata; backendUrl: string }): Promise<UploadResult> => {
      const token = await acquireToken();
      return uploadRecording({ filePath: args.recordingOptions.outputPath, accessToken: token, backendUrl: args.backendUrl, metadata: args.metadata });
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
    try {
      const { stderr } = await execAsync('ffmpeg -list_devices true -f dshow -i dummy 2>&1', {
        timeout: 5000,
      }).catch((e) => ({ stderr: e.stderr || '', stdout: '' }));

      const devices: { name: string; id: string }[] = [];
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
    } catch {
      return [];
    }
  });
}
