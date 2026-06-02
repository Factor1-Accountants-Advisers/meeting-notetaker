import { BrowserWindow, ipcMain, session, desktopCapturer, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

/**
 * WASAPI loopback capture via Electron's built-in getDisplayMedia + getUserMedia.
 *
 * Architecture: a hidden BrowserWindow ("capture window") does the actual media
 * work in a renderer context, because navigator.mediaDevices is only available
 * to renderers. The main process drives it over IPC: send 'wasapi:start' /
 * 'wasapi:stop', receive 'wasapi:chunk' (webm data) / 'wasapi:done' / 'wasapi:error'.
 *
 * Chunks land in a .webm file on disk; on stop we transcode to 16 kHz mono PCM
 * WAV (AssemblyAI's preferred format) via the bundled ffmpeg.
 */

interface ActiveRecording {
  webmPath: string;
  wavPath: string;
  stream: fs.WriteStream;
  resolve: (wavPath: string) => void;
  reject: (err: Error) => void;
  onProgress?: (bytesWritten: number) => void;
  bytesWritten: number;
}

let captureWindow: BrowserWindow | null = null;
let captureWindowReady: Promise<void> | null = null;
let activeRecording: ActiveRecording | null = null;

/**
 * Resolve ffmpeg binary path, rewriting asar → asar.unpacked in packaged builds.
 * Native binaries cannot execute from inside an asar archive.
 */
function resolveFfmpegPath(): string {
  if (!ffmpegPath) throw new Error('ffmpeg-static did not resolve a binary');
  return ffmpegPath.replace('app.asar', 'app.asar.unpacked');
}

/**
 * Call once at startup, before creating the main window. Registers the display
 * media and permission handlers globally so no dialogs appear, and spawns the
 * hidden capture window.
 */
export function initializeWasapiCapture(): void {
  // Auto-approve getDisplayMedia: hand back the first screen source + loopback audio.
  // The renderer stops the video track immediately — we only want audio.
  //
  // Critical: the callback MUST be invoked exactly once, even on error. If
  // getSources rejects without us calling callback, getDisplayMedia in the
  // renderer hangs forever — resulting in the "renderer did not confirm start
  // within 10s" timeout with no actionable error.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => {
        if (sources.length === 0) {
          console.error('[wasapi] desktopCapturer returned no screen sources');
          callback({});
          return;
        }
        callback({ video: sources[0], audio: 'loopback' });
      })
      .catch((err: Error) => {
        console.error('[wasapi] desktopCapturer.getSources failed:', err);
        callback({});
      });
  });

  // Auto-grant microphone + display-capture permissions for our own app
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media' || permission === 'display-capture') {
      callback(true);
    } else {
      callback(false);
    }
  });

  captureWindow = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: {
      preload: path.join(__dirname, '../renderer/wasapi/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const htmlPath = path.join(__dirname, '../renderer/wasapi/index.html');
  console.log('[wasapi] loading capture window:', htmlPath);

  // Track load state so startWasapiCapture can wait for readiness before
  // sending 'wasapi:start'. Without this, early clicks on Record can fire
  // the IPC event into a not-yet-loaded window and the message is dropped.
  captureWindowReady = new Promise<void>((resolve, reject) => {
    const win = captureWindow!;
    win.webContents.once('did-finish-load', () => {
      console.log('[wasapi] capture window loaded');
      resolve();
    });
    win.webContents.once('did-fail-load', (_e, code, desc, url) => {
      const msg = `[wasapi] capture window failed to load (${code} ${desc}) ${url}`;
      console.error(msg);
      reject(new Error(msg));
    });
  });

  captureWindow.loadFile(htmlPath).catch((err) => {
    console.error('[wasapi] loadFile threw:', err);
  });

  captureWindow.webContents.on('console-message', (_e, _level, message, line, source) => {
    console.log(`[wasapi:renderer] ${source}:${line} ${message}`);
  });

  captureWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[wasapi] capture window render-process-gone:', details);
    // Recreate the capture window so recording can resume without an app restart.
    // Without this, any subsequent record attempt fails with "capture window is not available".
    // Only recreate when there is no active recording — if a recording was in progress,
    // the wasapi:error IPC will fire next and handle cleanup.
    const wasRecording = activeRecording !== null;
    captureWindow = null;
    captureWindowReady = null;
    if (!wasRecording) {
      initializeWasapiCapture();
    } else {
      console.log('[wasapi] recording was active during crash — deferring window recreate until after cleanup');
    }
  });

  // IPC from the capture renderer
  ipcMain.on('wasapi:chunk', (_e, bytes: Uint8Array) => {
    if (!activeRecording) return;
    activeRecording.stream.write(Buffer.from(bytes));
    activeRecording.bytesWritten += bytes.length;
  });

  ipcMain.on('wasapi:done', () => {
    finalize().catch((err) => console.error('[wasapi] finalize error:', err));
  });

  ipcMain.on('wasapi:error', (_e, message: string) => {
    console.error('[wasapi] renderer error:', message);
    if (activeRecording) {
      activeRecording.reject(new Error(message));
      cleanupRecording();
    }
    // The capture window's renderer may be in a bad state. Recreate it so the
    // next record attempt starts fresh instead of hitting "capture window is
    // not available".
    if (captureWindow && !captureWindow.isDestroyed()) {
      captureWindow.destroy();
    }
    captureWindow = null;
    captureWindowReady = null;
    initializeWasapiCapture();
  });

  if (!app.isPackaged && process.env.OPEN_WASAPI_DEVTOOLS === '1') {
    captureWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

/**
 * Begin a recording. The promise resolves once the renderer has started
 * capturing; it does NOT resolve when the recording finishes (use
 * stopWasapiCapture for that).
 */
export async function startWasapiCapture(wavOutputPath: string): Promise<void> {
  if (!captureWindow || captureWindow.isDestroyed()) {
    // Capture window was destroyed (likely renderer crash). Recreate it and try again.
    console.log('[wasapi] capture window not available — recreating');
    initializeWasapiCapture();
    // Wait for the new window to be ready before proceeding
    if (captureWindowReady) {
      await captureWindowReady;
    }
    if (!captureWindow) {
      throw new Error('[wasapi] capture window is not available');
    }
    if (captureWindow.isDestroyed()) {
      throw new Error('[wasapi] capture window is not available');
    }
  }
  if (activeRecording) {
    throw new Error('[wasapi] a recording is already active');
  }

  // Wait for the hidden window to finish loading. On a cold packaged launch,
  // loading HTML + preload from inside app.asar can take a beat; if we send
  // 'wasapi:start' before the renderer's IPC listener is wired up, the event
  // is dropped and the 30s timeout fires with no useful error.
  if (captureWindowReady) {
    try {
      await captureWindowReady;
    } catch (err) {
      throw new Error(`[wasapi] capture window failed to load: ${(err as Error).message}`);
    }
  }

  return new Promise((resolve, reject) => {
    // Intermediate webm file lives alongside the final wav
    const webmPath = wavOutputPath.replace(/\.wav$/i, '.webm');
    const writeStream = fs.createWriteStream(webmPath);

    writeStream.on('error', (err) => {
      console.error('[wasapi] write stream error:', err);
      if (activeRecording) {
        activeRecording.reject(err);
        cleanupRecording();
      }
    });

    activeRecording = {
      webmPath,
      wavPath: wavOutputPath,
      stream: writeStream,
      resolve: () => {},
      reject: () => {},
      bytesWritten: 0,
    };

    // Resolve/reject exactly once. Previously we used `activeRecording === null`
    // as the "already settled" guard in the timeout, but activeRecording is set
    // synchronously above and remains non-null for the entire recording — so at
    // 30s the timeout would fire, call cleanupRecording(), and kill a healthy
    // in-progress recording. A dedicated `startSettled` flag + clearTimeout
    // ensures the timeout only fires when the renderer genuinely never confirms.
    let startSettled = false;
    const startedHandler = (): void => {
      if (startSettled) return;
      startSettled = true;
      clearTimeout(startTimeout);
      ipcMain.removeListener('wasapi:error', errorHandler);
      resolve();
    };
    const errorHandler = (_e: unknown, msg: string): void => {
      if (startSettled) return;
      startSettled = true;
      clearTimeout(startTimeout);
      ipcMain.removeListener('wasapi:started', startedHandler);
      reject(new Error(msg));
    };

    ipcMain.once('wasapi:started', startedHandler);
    ipcMain.once('wasapi:error', errorHandler);

    console.log('[wasapi] sending wasapi:start to capture window');
    captureWindow!.webContents.send('wasapi:start');

    // Safety timeout — 30s covers cold-started Windows Graphics Capture init
    // on first run. Clears itself on success via startedHandler/errorHandler.
    const startTimeout = setTimeout(() => {
      if (startSettled) return;
      startSettled = true;
      ipcMain.removeListener('wasapi:started', startedHandler);
      ipcMain.removeListener('wasapi:error', errorHandler);
      reject(new Error('[wasapi] renderer did not confirm start within 30s'));
      cleanupRecording();
    }, 30_000);
  });
}

/**
 * Stop the active recording, finalize the webm file, transcode to wav, and
 * resolve with the wav path.
 */
export function stopWasapiCapture(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!captureWindow || !activeRecording) {
      reject(new Error('[wasapi] no active recording to stop'));
      return;
    }
    activeRecording.resolve = resolve;
    activeRecording.reject = reject;
    captureWindow.webContents.send('wasapi:stop');
  });
}

function cleanupRecording(): void {
  if (!activeRecording) return;
  try {
    activeRecording.stream.end();
  } catch {
    // already ended
  }
  activeRecording = null;
}

async function finalize(): Promise<void> {
  if (!activeRecording) return;
  const recording = activeRecording;

  // Wait for the write stream to fully flush before transcoding
  await new Promise<void>((resolve) => {
    recording.stream.end(() => resolve());
  });

  console.log(`[wasapi] captured ${recording.bytesWritten} bytes to ${recording.webmPath}`);

  try {
    await transcodeWebmToWav(recording.webmPath, recording.wavPath);
    try {
      fs.unlinkSync(recording.webmPath);
    } catch (err) {
      console.warn('[wasapi] failed to delete intermediate webm:', err);
    }
    recording.resolve(recording.wavPath);
  } catch (err) {
    recording.reject(err as Error);
  } finally {
    activeRecording = null;
  }
}

function transcodeWebmToWav(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = resolveFfmpegPath();
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', inputPath,
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      outputPath,
    ];

    console.log(`[wasapi] transcoding: ${ffmpeg} ${args.join(' ')}`);
    const proc = spawn(ffmpeg, args, { windowsHide: true });

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`[wasapi] ffmpeg exited with code ${code}: ${stderr}`));
      }
    });

    proc.on('error', (err) => reject(err));
  });
}

export function isWasapiRecording(): boolean {
  return activeRecording !== null;
}

/** Testing hook: destroy the capture window. */
export function destroyCaptureWindow(): void {
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.destroy();
  }
  captureWindow = null;
  captureWindowReady = null;
}
