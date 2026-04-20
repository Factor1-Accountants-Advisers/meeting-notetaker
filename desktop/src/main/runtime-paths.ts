import { app } from 'electron';
import * as path from 'path';
import * as dotenv from 'dotenv';

/**
 * Resolve paths and environment for both dev and packaged modes.
 *
 * Packaged layout (inside resources/):
 *   app.asar/           — Electron JS + web-out
 *   app.asar.unpacked/  — native binaries (ffmpeg, etc.)
 *   backend/            — Python backend (extraResources)
 *   python/             — Embedded Python runtime (extraResources)
 *   .env.production     — Packaged env config (extraResources)
 */

const PACKAGED_BACKEND_PORT = 38742;

/** Load env vars appropriate to the current mode. */
export function loadEnv(): void {
  if (app.isPackaged) {
    // In packaged mode, read from a bundled config next to app.asar
    const envFile = path.join(process.resourcesPath, '.env.production');
    dotenv.config({ path: envFile });
  } else {
    // Dev mode: read from the desktop project root
    const envFile = path.join(__dirname, '../../.env.local');
    dotenv.config({ path: envFile });
  }
}

/** Backend URL — fixed loopback port in packaged, env-configurable in dev. */
export function getBackendUrl(): string {
  if (app.isPackaged) {
    return process.env.BACKEND_URL ?? `http://127.0.0.1:${PACKAGED_BACKEND_PORT}`;
  }
  return process.env.BACKEND_URL ?? 'http://localhost:8000';
}

/** Port the backend should listen on when spawned by Electron. */
export function getBackendPort(): number {
  return PACKAGED_BACKEND_PORT;
}

/** Path to the bundled Python interpreter (extraResources/python/). */
export function getPythonPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'python', 'python.exe');
  }
  return process.env.PYTHON_PATH ?? 'python';
}

/** Path to the backend source directory (extraResources/backend/). */
export function getBackendDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'backend');
  }
  return path.join(__dirname, '../../../backend');
}

/**
 * Writable data directory for the packaged backend (database + audio files).
 * Program Files is read-only, so we use %LOCALAPPDATA%/meeting-notetaker-desktop/backend-data/.
 */
export function getBackendDataDir(): string {
  return path.join(app.getPath('userData'), 'backend-data');
}
