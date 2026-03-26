import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env.local before any other imports read process.env
dotenv.config({ path: path.join(process.cwd(), '.env.local') });

import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { createTray } from './tray';
import { registerIpcHandlers } from './ipc';

if (!app.requestSingleInstanceLock()) app.quit();

app.disableHardwareAcceleration();
app.on('window-all-closed', (e: Event) => e.preventDefault());

app.whenReady().then(() => {
  registerIpcHandlers();
  createTray({
    backendUrl: process.env.BACKEND_URL ?? 'http://localhost:8000',
    webAppUrl: process.env.WEB_APP_URL ?? 'http://localhost:3000',
    recordingOutputDir: app.getPath('temp'),
    micName: process.env.MIC_DEVICE_NAME ?? '',
    loopbackName: process.env.LOOPBACK_DEVICE_NAME ?? '',
  });
  if (app.isPackaged) {
    void autoUpdater.checkForUpdatesAndNotify();
    setInterval(() => void autoUpdater.checkForUpdatesAndNotify(), 4 * 3600000);
  }
});
