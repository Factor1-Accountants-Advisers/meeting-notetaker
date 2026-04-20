import { ChildProcess, spawn } from 'child_process';
import { getPythonPath, getBackendDir, getBackendPort, getBackendUrl, getBackendDataDir } from './runtime-paths';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

let backendProcess: ChildProcess | null = null;

/**
 * Start the bundled FastAPI backend and wait until it responds to /health.
 * Rejects if the backend fails to start within the timeout.
 */
export async function startBackend(timeoutMs = 30_000): Promise<void> {
  if (backendProcess) return; // Already running

  const pythonPath = getPythonPath();
  const backendDir = getBackendDir();
  const port = getBackendPort();

  // Ensure the writable data directory exists (for SQLite DB + audio files)
  const dataDir = getBackendDataDir();
  fs.mkdirSync(dataDir, { recursive: true });

  // Build environment for the backend process.
  // In packaged mode, pass env vars that override defaults in config.py
  // so the backend writes to a writable location, not Program Files.
  const backendEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    DATABASE_URL: `sqlite+aiosqlite:///${path.join(dataDir, 'meetings.db').replace(/\\/g, '/')}`,
    LOCAL_STORAGE_DIR: path.join(dataDir, 'audio'),
    STORAGE_BACKEND: 'local',
    BACKEND_HOST: '127.0.0.1',
    BACKEND_PORT: String(port),
  };

  console.log(`[backend] Spawning: ${pythonPath} -m uvicorn app.main:app --host 127.0.0.1 --port ${port}`);
  console.log(`[backend] Working directory: ${backendDir}`);
  console.log(`[backend] Data directory: ${dataDir}`);

  backendProcess = spawn(
    pythonPath,
    ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: backendDir,
      env: backendEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  backendProcess.stdout?.on('data', (chunk: Buffer) => {
    console.log(`[backend:stdout] ${chunk.toString().trimEnd()}`);
  });

  backendProcess.stderr?.on('data', (chunk: Buffer) => {
    console.log(`[backend:stderr] ${chunk.toString().trimEnd()}`);
  });

  backendProcess.on('exit', (code, signal) => {
    console.warn(`[backend] Process exited (code=${code}, signal=${signal})`);
    backendProcess = null;
  });

  // Wait for /health to respond
  await waitForHealth(getBackendUrl(), timeoutMs);
}

/** Stop the backend process. Safe to call multiple times. */
export function stopBackend(): void {
  if (!backendProcess) return;
  console.log('[backend] Stopping backend process...');
  try {
    // On Windows, child_process.kill() sends taskkill by default.
    // tree-kill would be better, but for a single uvicorn process this works.
    backendProcess.kill();
  } catch (err) {
    console.warn('[backend] Error killing backend process:', err);
  }
  backendProcess = null;
}

function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const healthUrl = `${baseUrl}/health`;
  const pollInterval = 500;

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    function poll() {
      if (Date.now() > deadline) {
        reject(new Error(`[backend] Health check timed out after ${timeoutMs}ms`));
        return;
      }

      // If the process died before becoming healthy, fail fast
      if (!backendProcess) {
        reject(new Error('[backend] Process exited before becoming healthy'));
        return;
      }

      http.get(healthUrl, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          setTimeout(poll, pollInterval);
        }
        res.resume(); // Drain the response
      }).on('error', () => {
        setTimeout(poll, pollInterval);
      });
    }

    poll();
  });
}
