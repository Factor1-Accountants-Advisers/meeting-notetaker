import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getToken: (): Promise<string> => ipcRenderer.invoke('auth:get-id-token'),
  signOut: (): Promise<void> => ipcRenderer.invoke('auth:sign-out'),
  getBackendUrl: (): Promise<string> => ipcRenderer.invoke('app:get-backend-url'),
  getAppVersion: (): string => ipcRenderer.sendSync('app:get-version'),
  isElectron: true,
});
