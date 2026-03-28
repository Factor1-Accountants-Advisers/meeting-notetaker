"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('meetingSelector', {
    getCalendar: () => electron_1.ipcRenderer.invoke('graph:get-calendar'),
    selectMeeting: (event) => electron_1.ipcRenderer.invoke('meeting-selector:select', event),
    closeWindow: () => electron_1.ipcRenderer.send('meeting-selector:close'),
});
//# sourceMappingURL=preload.js.map