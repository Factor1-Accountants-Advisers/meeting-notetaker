import * as path from 'path';
import * as fs from 'fs';
import { app, BrowserWindow, protocol } from 'electron';
import { autoUpdater } from 'electron-updater';
import { createTray, destroyTray, updateTrayDevices } from './tray';
import { registerIpcHandlers, listAudioDevices, pickDefaultDevices } from './ipc';
import { registerAppProtocol } from './protocol';
import { startScheduler, stopScheduler } from './scheduler';
import { getBackendUrl, loadEnv } from './runtime-paths';
import { startBackend, stopBackend } from './backend-runtime';
import { initializeWasapiCapture, destroyCaptureWindow } from './wasapi-capture';

// Load environment — must happen before anything reads process.env
loadEnv();

// Mirror console output to a file in packaged mode. On Windows, console.log
// in a packaged Electron app goes nowhere visible, which makes diagnosing
// install-time failures (backend spawn, WASAPI renderer hangs) impossible.
// Log file lives at %APPDATA%\meeting-notetaker-desktop\logs\main.log.
if (app.isPackaged) {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const stream = fs.createWriteStream(path.join(logDir, 'main.log'), { flags: 'a' });
    const fmt = (args: unknown[]): string => args.map((a) => {
      if (a instanceof Error) return `${a.message}\n${a.stack ?? ''}`;
      return typeof a === 'string' ? a : JSON.stringify(a);
    }).join(' ');
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = (...args: unknown[]): void => {
      stream.write(`[${new Date().toISOString()}] ${fmt(args)}\n`);
      origLog(...args);
    };
    console.warn = (...args: unknown[]): void => {
      stream.write(`[${new Date().toISOString()}] WARN ${fmt(args)}\n`);
      origWarn(...args);
    };
    console.error = (...args: unknown[]): void => {
      stream.write(`[${new Date().toISOString()}] ERROR ${fmt(args)}\n`);
      origError(...args);
    };
    stream.write(`\n=== App started ${new Date().toISOString()} ===\n`);
  } catch {
    // Logging setup failed — not fatal. Carry on with default console behavior.
  }
}

// Must be called BEFORE app.whenReady(). Without this the app:// scheme is
// treated as opaque/non-secure, which breaks ES modules, fetch, and
// localStorage — causing Next.js to throw a client-side exception on mount.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

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
    win.loadURL(process.env.WEB_DEV_URL);
  } else {
    win.loadURL('app://renderer/index.html');
  }

  // Surface renderer failures into the main-process log so the packaged app
  // isn't silent if something goes wrong during hydration.
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] render-process-gone:', details);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] did-fail-load ${code} ${desc} for ${url}`);
  });
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) {
      console.log(`[renderer:console] ${source}:${line} ${message}`);
    }
  });

  if (process.env.OPEN_DEVTOOLS === '1') {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
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

// Restore window when user launches the app again
app.on('second-instance', () => {
  showMainWindow();
});

app.on('window-all-closed', (e: Event) => {
  if (!isQuitting) e.preventDefault();
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.whenReady().then(async () => {
  registerIpcHandlers();

  // Initialize WASAPI capture (hidden renderer window + permission handlers).
  // Must run after app is ready so session.defaultSession is available.
  initializeWasapiCapture();

  // Start the bundled backend (packaged) or assume external (dev)
  const backendUrl = getBackendUrl();
  if (app.isPackaged) {
    try {
      console.log('[startup] Starting bundled backend...');
      await startBackend();
      console.log('[startup] Backend is ready.');
    } catch (err) {
      console.error('[startup] Backend failed to start:', err);
    }
  }

  // Register protocol once, before any window is created
  if (app.isPackaged || !process.env.WEB_DEV_URL) {
    const staticDir = path.join(__dirname, '../../web-out');
    registerAppProtocol(staticDir, backendUrl);
  }

  createTray({
    backendUrl,
    recordingOutputDir: app.getPath('temp'),
    micName: process.env.MIC_DEVICE_NAME ?? '',
    loopbackName: process.env.LOOPBACK_DEVICE_NAME ?? '',
    onOpenApp: showMainWindow,
  });

  // Auto-detect audio devices for tray recording (non-blocking)
  listAudioDevices().then((devices) =>
    pickDefaultDevices(devices).then((defaults) => {
      if (defaults.micName || defaults.loopbackName) {
        updateTrayDevices(defaults.micName, defaults.loopbackName);
        console.log(`[startup] Auto-detected audio: mic="${defaults.micName}", loopback="${defaults.loopbackName}"`);
      }
    })
  ).catch((err) => console.warn('[startup] Audio device detection failed:', err));

  mainWindow = createMainWindow();

  startScheduler();

  if (app.isPackaged) {
    autoUpdater.on('error', (err) => {
      console.warn('[updater] Auto-update check failed (non-fatal):', err.message);
    });
    void autoUpdater.checkForUpdatesAndNotify();
    setInterval(() => void autoUpdater.checkForUpdatesAndNotify(), 4 * 3600000);
  }
});

app.on('will-quit', () => {
  stopScheduler();
  destroyTray();
  destroyCaptureWindow();
  stopBackend();
});
