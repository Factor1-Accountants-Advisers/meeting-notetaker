jest.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: jest.fn(),
  },
  ipcRenderer: {
    invoke: jest.fn(),
    sendSync: jest.fn(),
    on: jest.fn(),
    removeListener: jest.fn(),
  },
}));

import { contextBridge, ipcRenderer } from 'electron';

describe('preload-web', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('exposes all expected API methods', () => {
    jest.isolateModules(() => {
      require('../src/renderer/preload-web');
    });

    const exposedApi = (contextBridge.exposeInMainWorld as jest.Mock).mock.calls[0][1];

    // Existing APIs
    expect(exposedApi.isElectron).toBe(true);
    expect(typeof exposedApi.getToken).toBe('function');
    expect(typeof exposedApi.signOut).toBe('function');
    expect(typeof exposedApi.getBackendUrl).toBe('function');
    expect(typeof exposedApi.getAppVersion).toBe('function');

    // New APIs
    expect(typeof exposedApi.getCalendar).toBe('function');
    expect(typeof exposedApi.startRecording).toBe('function');
    expect(typeof exposedApi.stopRecording).toBe('function');
    expect(typeof exposedApi.isRecording).toBe('function');
    expect(typeof exposedApi.onRecordingStatus).toBe('function');
    expect(typeof exposedApi.uploadRecording).toBe('function');
    expect(typeof exposedApi.selectMeeting).toBe('function');
    expect(typeof exposedApi.getAudioDevices).toBe('function');
  });

  it('getCalendar invokes correct IPC channel', async () => {
    jest.isolateModules(() => {
      require('../src/renderer/preload-web');
    });
    const api = (contextBridge.exposeInMainWorld as jest.Mock).mock.calls[0][1];

    (ipcRenderer.invoke as jest.Mock).mockResolvedValue([]);
    await api.getCalendar();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('graph:get-calendar');
  });

  it('startRecording passes options to IPC', async () => {
    jest.isolateModules(() => {
      require('../src/renderer/preload-web');
    });
    const api = (contextBridge.exposeInMainWorld as jest.Mock).mock.calls[0][1];

    const opts = { micName: 'Mic', loopbackName: 'Speaker', outputPath: '/tmp/out.wav' };
    (ipcRenderer.invoke as jest.Mock).mockResolvedValue(undefined);
    await api.startRecording(opts);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('recorder:start', opts);
  });

  it('onRecordingStatus subscribes and returns unsubscribe fn', () => {
    jest.isolateModules(() => {
      require('../src/renderer/preload-web');
    });
    const api = (contextBridge.exposeInMainWorld as jest.Mock).mock.calls[0][1];

    const cb = jest.fn();
    const unsub = api.onRecordingStatus(cb);

    expect(ipcRenderer.on).toHaveBeenCalledWith('recorder:status-changed', expect.any(Function));
    expect(typeof unsub).toBe('function');

    unsub();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith('recorder:status-changed', expect.any(Function));
  });
});
