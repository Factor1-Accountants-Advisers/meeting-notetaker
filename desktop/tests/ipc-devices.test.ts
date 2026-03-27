jest.mock('electron', () => ({
  ipcMain: {
    handle: jest.fn(),
    on: jest.fn(),
  },
  BrowserWindow: { fromWebContents: jest.fn() },
  shell: { openExternal: jest.fn() },
  app: { getVersion: jest.fn(() => '1.0.0') },
}));
jest.mock('../src/main/auth', () => ({
  acquireToken: jest.fn(),
  acquireIdToken: jest.fn(),
  clearTokenCache: jest.fn(),
}));
jest.mock('../src/main/graph', () => ({ getUpcomingMeetings: jest.fn() }));
jest.mock('../src/main/recorder', () => ({
  startRecording: jest.fn(),
  stopRecording: jest.fn(),
  isRecording: jest.fn(),
}));
jest.mock('../src/main/uploader', () => ({ uploadRecording: jest.fn() }));
jest.mock('../src/main/tray', () => ({ setPendingMeeting: jest.fn() }));

import { ipcMain } from 'electron';

describe('audio:get-devices IPC handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('registers audio:get-devices handler', () => {
    require('../src/main/ipc').registerIpcHandlers();
    const handleCalls = (ipcMain.handle as jest.Mock).mock.calls;
    const channels = handleCalls.map((c: [string, Function]) => c[0]);
    expect(channels).toContain('audio:get-devices');
  });
});
