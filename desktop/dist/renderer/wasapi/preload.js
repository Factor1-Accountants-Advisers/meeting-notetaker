"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
/**
 * IPC surface for the hidden capture window. Small and stable — no React, no
 * Next.js, just enough to drive a MediaRecorder.
 */
electron_1.contextBridge.exposeInMainWorld('wasapiAPI', {
    // Renderer → main
    started: () => { electron_1.ipcRenderer.send('wasapi:started'); },
    chunk: (bytes) => { electron_1.ipcRenderer.send('wasapi:chunk', bytes); },
    done: () => { electron_1.ipcRenderer.send('wasapi:done'); },
    error: (message) => { electron_1.ipcRenderer.send('wasapi:error', message); },
    // Main → renderer (event subscriptions)
    onStart: (cb) => {
        const handler = () => cb();
        electron_1.ipcRenderer.on('wasapi:start', handler);
        return () => electron_1.ipcRenderer.removeListener('wasapi:start', handler);
    },
    onStop: (cb) => {
        const handler = () => cb();
        electron_1.ipcRenderer.on('wasapi:stop', handler);
        return () => electron_1.ipcRenderer.removeListener('wasapi:stop', handler);
    },
});
//# sourceMappingURL=preload.js.map