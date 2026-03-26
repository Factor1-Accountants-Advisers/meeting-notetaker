export const app = {
  getPath: jest.fn(() => '/tmp/test'),
  isPackaged: false,
  requestSingleInstanceLock: jest.fn(() => true),
  disableHardwareAcceleration: jest.fn(),
  whenReady: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(),
  quit: jest.fn(),
};

export const safeStorage = {
  encryptString: jest.fn((s: string) => Buffer.from(`enc:${s}`)),
  decryptString: jest.fn((buf: Buffer) => buf.toString().replace('enc:', '')),
  isEncryptionAvailable: jest.fn(() => true),
};

export const ipcMain = { handle: jest.fn(), on: jest.fn() };

const BrowserWindowMock: any = jest.fn().mockImplementation(() => ({
  loadFile: jest.fn(),
  on: jest.fn(),
  close: jest.fn(),
  focus: jest.fn(),
  isDestroyed: jest.fn(() => false),
  webContents: {},
}));
BrowserWindowMock.fromWebContents = jest.fn();
export const BrowserWindow = BrowserWindowMock;

export const Tray = jest.fn().mockImplementation(() => ({
  setToolTip: jest.fn(),
  setContextMenu: jest.fn(),
  setImage: jest.fn(),
  on: jest.fn(),
}));

export const Menu = { buildFromTemplate: jest.fn() };
export const nativeImage = { createFromPath: jest.fn() };
export const shell = { openExternal: jest.fn() };

export default { app, safeStorage, ipcMain, BrowserWindow, Tray, Menu, nativeImage, shell };
