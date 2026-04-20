"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('electronAPI', {
    // Auth (existing)
    getToken: () => electron_1.ipcRenderer.invoke('auth:get-id-token'),
    signIn: () => electron_1.ipcRenderer.invoke('auth:sign-in'),
    signOut: () => electron_1.ipcRenderer.invoke('auth:sign-out'),
    getBackendUrl: () => electron_1.ipcRenderer.invoke('app:get-backend-url'),
    getAppVersion: () => electron_1.ipcRenderer.sendSync('app:get-version'),
    isElectron: true,
    // Calendar
    getCalendar: () => electron_1.ipcRenderer.invoke('graph:get-calendar'),
    // Recording
    startRecording: (opts) => electron_1.ipcRenderer.invoke('recorder:start', opts),
    stopRecording: () => electron_1.ipcRenderer.invoke('recorder:stop'),
    isRecording: () => electron_1.ipcRenderer.invoke('recorder:is-recording'),
    getRecordingStatus: () => electron_1.ipcRenderer.invoke('recorder:get-status'),
    onRecordingStatus: (cb) => {
        const handler = (_e, status) => cb(status);
        electron_1.ipcRenderer.on('recorder:status-changed', handler);
        return () => { electron_1.ipcRenderer.removeListener('recorder:status-changed', handler); };
    },
    // Upload via main process
    uploadRecording: (args) => electron_1.ipcRenderer.invoke('uploader:upload', args),
    // Meeting metadata
    selectMeeting: (event) => electron_1.ipcRenderer.invoke('meeting-selector:select', event),
    // Audio devices
    getAudioDevices: () => electron_1.ipcRenderer.invoke('audio:get-devices'),
    getDefaultAudioDevices: () => electron_1.ipcRenderer.invoke('audio:get-default-devices'),
});
//# sourceMappingURL=preload-web.js.map