import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { createTray } from './tray';
import { registerIpcHandlers } from './ipc';
import { registerAppProtocol } from './protocol';

if (!app.requestSingleInstanceLock()) app.quit();

app.disableHardwareAcceleration();

let mainWindow: BrowserWindow | null = null;
const backendUrl = process.env.BACKEND_URL ?? 'http://localhost:8000';

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Meeting Note-Taker',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../renderer/preload-web.js'),
    },
  });

  if (!app.isPackaged && process.env.WEB_DEV_URL) {
    // Dev mode: load from Next.js dev server
    win.loadURL(process.env.WEB_DEV_URL);
  } else {
    // Production: load from static export via custom protocol
    win.loadURL('app://renderer/index.html');
  }

  win.on('close', (e) => {
    // Hide instead of quit — tray keeps running
    e.preventDefault();
    win.hide();
  });

  return win;
}

export function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

app.on('window-all-closed', (e: Event) => e.preventDefault());

app.whenReady().then(() => {
  registerIpcHandlers();

  // Register protocol once, before any window is created
  if (app.isPackaged || !process.env.WEB_DEV_URL) {
    const staticDir = path.join(__dirname, '../../web-out');
    registerAppProtocol(staticDir, backendUrl);
  }

  // Pass showMainWindow into tray to avoid circular dependency
  createTray({
    backendUrl,
    recordingOutputDir: app.getPath('temp'),
    micName: process.env.MIC_DEVICE_NAME ?? '',
    loopbackName: process.env.LOOPBACK_DEVICE_NAME ?? '',
    onOpenApp: showMainWindow,
  });

  // Show main window on startup
  mainWindow = createMainWindow();

  if (app.isPackaged) {
    void autoUpdater.checkForUpdatesAndNotify();
    setInterval(() => void autoUpdater.checkForUpdatesAndNotify(), 4 * 3600000);
  }
});
