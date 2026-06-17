import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Auth (existing)
  getToken: (): Promise<string> => ipcRenderer.invoke('auth:get-id-token'),
  signIn: (): Promise<string> => ipcRenderer.invoke('auth:sign-in'),
  signOut: (): Promise<void> => ipcRenderer.invoke('auth:sign-out'),
  getBackendUrl: (): Promise<string> => ipcRenderer.invoke('app:get-backend-url'),
  getAppVersion: (): string => ipcRenderer.sendSync('app:get-version'),
  isElectron: true as const,

  // Calendar
  getCalendar: () => ipcRenderer.invoke('graph:get-calendar'),

  // Recording
  startRecording: (opts: {
    micName: string;
    loopbackName: string;
    outputPath: string;
    meetingTitle?: string;
    metadata?: { meeting_title: string; attendees: { name: string; email?: string }[]; scheduled_time?: string };
  }) => ipcRenderer.invoke('recorder:start', opts),
  stopRecording: (): Promise<{
    outputPath: string;
    metadata?: { meeting_title: string; attendees: { name: string; email?: string }[]; scheduled_time?: string };
    error?: string;
  }> => ipcRenderer.invoke('recorder:stop'),
  isRecording: () => ipcRenderer.invoke('recorder:is-recording'),
  getRecordingStatus: () => ipcRenderer.invoke('recorder:get-status'),
  onRecordingStatus: (cb: (status: { recording: boolean; meetingTitle?: string; startedAt?: number; error?: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, status: { recording: boolean; meetingTitle?: string; startedAt?: number; error?: string }) => cb(status);
    ipcRenderer.on('recorder:status-changed', handler);
    return () => { ipcRenderer.removeListener('recorder:status-changed', handler); };
  },

  // Upload via main process
  uploadRecording: (args: {
    filePath: string;
    metadata: { meeting_title: string; attendees: { name: string; email?: string }[]; scheduled_time?: string };
  }): Promise<{ meeting_id: number; status: string }> => ipcRenderer.invoke('uploader:upload', args),

  // Meeting metadata
  selectMeeting: (event: { id: string; subject: string; start: string; end: string; attendees: { name: string; email: string }[] }) =>
    ipcRenderer.invoke('meeting-selector:select', event),

  // Audio devices
  getAudioDevices: () => ipcRenderer.invoke('audio:get-devices'),
  getDefaultAudioDevices: () => ipcRenderer.invoke('audio:get-default-devices'),

  // Runtime API key management
  getRuntimeEnvStatus: (): Promise<Record<string, boolean>> => ipcRenderer.invoke('runtime:get-env-status'),
  setRuntimeEnvKeys: (keys: Record<string, string>): Promise<void> => ipcRenderer.invoke('runtime:set-env-keys', keys),

  // Logging
  getLogInfo: (): Promise<{ logDir: string; mainLog: string; backendLog: string; rendererLog: string }> =>
    ipcRenderer.invoke('app:get-log-info'),
});
