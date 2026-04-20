import { Tray, Menu, app, nativeImage, BrowserWindow } from 'electron';
import * as path from 'path';
import { startRecording, stopRecording, isRecording, getRecordingStatus } from './recorder';
import { acquireIdToken } from './auth';
import { uploadRecording, AttendeeMetadata, MeetingMetadata } from './uploader';
import { getMainWindow } from './index';

const IDLE_ICON = path.join(__dirname, '../../assets/icon-idle.png');
const RECORDING_ICON = path.join(__dirname, '../../assets/icon-recording.png');

let tray: Tray | null = null;
let meetingSelectorWindow: BrowserWindow | null = null;

let _backendUrl = 'http://localhost:8000';
let _onOpenApp: () => void = () => {};
let _recordingOutputDir = '';
let _micName = '';
let _loopbackName = '';
let _pendingTitle = '';
let _pendingAttendees: AttendeeMetadata[] = [];
let _pendingScheduledTime: string | undefined;

export interface TrayConfig {
  backendUrl: string;
  recordingOutputDir: string;
  micName: string;
  loopbackName: string;
  onOpenApp: () => void;
}

export function destroyTray(): void {
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
  }
  tray = null;
}

export function updateTrayDevices(micName: string, loopbackName: string): void {
  _micName = micName;
  _loopbackName = loopbackName;
}

export function setPendingMeeting(title: string, attendees: AttendeeMetadata[], scheduledTime?: string): void {
  _pendingTitle = title;
  _pendingAttendees = attendees;
  _pendingScheduledTime = scheduledTime;
}

export function createTray(config: TrayConfig): Tray {
  _backendUrl = config.backendUrl;
  _onOpenApp = config.onOpenApp;
  _recordingOutputDir = config.recordingOutputDir;
  _micName = config.micName;
  _loopbackName = config.loopbackName;

  tray = new Tray(nativeImage.createFromPath(IDLE_ICON));
  tray.setToolTip('Meeting Note-Taker');
  tray.on('click', () => _onOpenApp());
  rebuildMenu();
  return tray;
}

function rebuildMenu(): void {
  if (!tray) return;
  const recording = isRecording();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Start Recording', enabled: !recording, click: handleStartRecording },
    { label: 'Stop Recording', enabled: recording, click: handleStopRecording },
    { type: 'separator' },
    { label: 'Open App', click: () => _onOpenApp() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

/**
 * Reconcile the tray icon, tooltip, and menu with the current recording state.
 * Call this from any code path that starts or stops a recording — including
 * UI-initiated ones via IPC — so the tray UI never drifts out of sync.
 */
export function syncTrayToRecordingState(): void {
  if (!tray) return;
  const recording = isRecording();
  tray.setImage(nativeImage.createFromPath(recording ? RECORDING_ICON : IDLE_ICON));
  tray.setToolTip(recording ? 'Meeting Note-Taker — Recording...' : 'Meeting Note-Taker');
  rebuildMenu();
}

function broadcastRecordingStatus(): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('recorder:status-changed', getRecordingStatus());
  }
}

export function handleStartRecording(): void {
  if (!_micName || !_loopbackName) {
    console.error('[tray] Cannot start recording — audio devices not configured. Open the app and go to Settings.');
    _onOpenApp();
    return;
  }
  const outputPath = path.join(_recordingOutputDir, `meeting-${Date.now()}.wav`);
  const metadata: MeetingMetadata = {
    meeting_title: _pendingTitle || `Recording ${new Date().toLocaleString()}`,
    attendees: _pendingAttendees,
    scheduled_time: _pendingScheduledTime,
  };
  try {
    startRecording({
      micName: _micName,
      loopbackName: _loopbackName,
      outputPath,
      meetingTitle: metadata.meeting_title,
      metadata,
    });
    tray?.setImage(nativeImage.createFromPath(RECORDING_ICON));
    tray?.setToolTip('Meeting Note-Taker — Recording...');
    rebuildMenu();
    broadcastRecordingStatus();
  } catch (err) {
    console.error('[tray] Failed to start recording:', err);
    tray?.setToolTip('Meeting Note-Taker — Recording failed');
    setTimeout(() => { tray?.setToolTip('Meeting Note-Taker'); }, 3000);
  }
}

async function handleStopRecording(): Promise<void> {
  tray?.setImage(nativeImage.createFromPath(IDLE_ICON));
  tray?.setToolTip('Meeting Note-Taker — Finalising...');
  rebuildMenu();
  broadcastRecordingStatus();

  const result = await stopRecording();
  tray?.setToolTip('Meeting Note-Taker — Uploading...');

  try {
    if (!result.outputPath) {
      throw new Error(result.error || 'Recording failed before the audio file could be saved.');
    }

    const token = await acquireIdToken();
    const metadata: MeetingMetadata = result.metadata ?? {
      meeting_title: _pendingTitle || `Recording ${new Date().toLocaleString()}`,
      attendees: _pendingAttendees,
      scheduled_time: _pendingScheduledTime,
    };
    await uploadRecording({ filePath: result.outputPath, accessToken: token, backendUrl: _backendUrl, metadata });
    tray?.setToolTip('Meeting Note-Taker — Upload complete');
  } catch (err) {
    console.error('[tray] upload failed:', err);
    tray?.setToolTip('Meeting Note-Taker — Upload failed');
  }

  _pendingTitle = '';
  _pendingAttendees = [];
  _pendingScheduledTime = undefined;
  setTimeout(() => { tray?.setToolTip('Meeting Note-Taker'); rebuildMenu(); }, 3000);
}

function openMeetingSelector(): void {
  if (meetingSelectorWindow && !meetingSelectorWindow.isDestroyed()) {
    meetingSelectorWindow.focus();
    return;
  }
  meetingSelectorWindow = new BrowserWindow({
    width: 480, height: 400, resizable: false, alwaysOnTop: true,
    title: 'Select Meeting',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../renderer/meeting-selector/preload.js'),
    },
  });
  meetingSelectorWindow.loadFile(
    path.join(__dirname, '../renderer/meeting-selector/index.html')
  );
  meetingSelectorWindow.on('closed', () => { meetingSelectorWindow = null; });
}
