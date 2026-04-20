import { contextBridge, ipcRenderer } from 'electron';

/**
 * IPC surface for the hidden capture window. Small and stable — no React, no
 * Next.js, just enough to drive a MediaRecorder.
 */
contextBridge.exposeInMainWorld('wasapiAPI', {
  // Renderer → main
  started: (): void => { ipcRenderer.send('wasapi:started'); },
  chunk: (bytes: Uint8Array): void => { ipcRenderer.send('wasapi:chunk', bytes); },
  done: (): void => { ipcRenderer.send('wasapi:done'); },
  error: (message: string): void => { ipcRenderer.send('wasapi:error', message); },

  // Main → renderer (event subscriptions)
  onStart: (cb: () => void): (() => void) => {
    const handler = (): void => cb();
    ipcRenderer.on('wasapi:start', handler);
    return () => ipcRenderer.removeListener('wasapi:start', handler);
  },
  onStop: (cb: () => void): (() => void) => {
    const handler = (): void => cb();
    ipcRenderer.on('wasapi:stop', handler);
    return () => ipcRenderer.removeListener('wasapi:stop', handler);
  },
});
