const mockLoadURL = jest.fn();
const mockWebContentsOn = jest.fn();
const mockWindowOn = jest.fn();
const mockShow = jest.fn();
const mockFocus = jest.fn();
const mockIsDestroyed = jest.fn(() => false);

const mockBrowserWindow = jest.fn().mockImplementation(() => ({
  loadURL: mockLoadURL,
  webContents: {
    on: mockWebContentsOn,
    openDevTools: jest.fn(),
  },
  on: mockWindowOn,
  show: mockShow,
  focus: mockFocus,
  isDestroyed: mockIsDestroyed,
}));

jest.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: jest.fn(() => '/tmp/test'),
    requestSingleInstanceLock: jest.fn(() => true),
    whenReady: jest.fn(() => new Promise(() => undefined)),
    on: jest.fn(),
    quit: jest.fn(),
  },
  BrowserWindow: mockBrowserWindow,
  protocol: {
    registerSchemesAsPrivileged: jest.fn(),
  },
}));

jest.mock('electron-updater', () => ({
  autoUpdater: {
    on: jest.fn(),
    checkForUpdatesAndNotify: jest.fn(),
  },
}));

jest.mock('../src/main/tray', () => ({
  createTray: jest.fn(),
  destroyTray: jest.fn(),
  updateTrayDevices: jest.fn(),
}));

jest.mock('../src/main/ipc', () => ({
  registerIpcHandlers: jest.fn(),
  listAudioDevices: jest.fn().mockResolvedValue([]),
  pickDefaultDevices: jest.fn().mockResolvedValue({ micName: '', loopbackName: '' }),
}));

jest.mock('../src/main/protocol', () => ({ registerAppProtocol: jest.fn() }));
jest.mock('../src/main/scheduler', () => ({ startScheduler: jest.fn(), stopScheduler: jest.fn() }));
jest.mock('../src/main/runtime-paths', () => ({ getBackendUrl: jest.fn(() => 'http://localhost:8000'), loadEnv: jest.fn() }));
jest.mock('../src/main/backend-runtime', () => ({ startBackend: jest.fn(), stopBackend: jest.fn() }));
jest.mock('../src/main/wasapi-capture', () => ({ initializeWasapiCapture: jest.fn(), destroyCaptureWindow: jest.fn() }));

import { BrowserWindow } from 'electron';
import { createMainWindow, showMainWindow } from '../src/main/index';

describe('main window lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsDestroyed.mockReturnValue(false);
  });

  it('creates the main window hidden so background startup stays tray-first', () => {
    createMainWindow();

    expect(BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({ show: false }));
    expect(mockShow).not.toHaveBeenCalled();
    expect(mockFocus).not.toHaveBeenCalled();
  });

  it('shows and focuses the window only through explicit showMainWindow action', () => {
    showMainWindow();

    expect(BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({ show: false }));
    expect(mockShow).toHaveBeenCalled();
    expect(mockFocus).toHaveBeenCalled();
  });
});
