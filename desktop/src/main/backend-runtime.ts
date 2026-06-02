import { ChildProcess, spawn, spawnSync, SpawnSyncReturns } from 'child_process';
import { getPythonPath, getBackendDir, getBackendPort, getBackendUrl, getBackendDataDir, ensurePackagedPythonRuntime } from './runtime-paths';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

let backendProcess: ChildProcess | null = null;

const RUNTIME_ENV_FILE = '.env.production.local';
const RUNTIME_ENV_KEYS = ['ASSEMBLYAI_API_KEY', 'OPENAI_API_KEY'] as const;

type RuntimeEnvKey = typeof RUNTIME_ENV_KEYS[number];
type RuntimeOverrideEnv = Partial<Record<RuntimeEnvKey, string>>;

export function loadRuntimeOverrideEnv(userDataDir: string): RuntimeOverrideEnv {
  const envPath = path.join(userDataDir, RUNTIME_ENV_FILE);
  if (!fs.existsSync(envPath)) {
    return {};
  }

  const parsed = dotenv.parse(fs.readFileSync(envPath));
  const overrides: RuntimeOverrideEnv = {};
  for (const key of RUNTIME_ENV_KEYS) {
    const value = parsed[key]?.trim();
    if (value) {
      overrides[key] = value;
    }
  }
  return overrides;
}

export function buildBackendEnv(dataDir: string, userDataDir = path.dirname(dataDir)): Record<string, string> {
  const runtimeOverrides = loadRuntimeOverrideEnv(userDataDir);
  const backendEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...runtimeOverrides,
    DATABASE_URL: `sqlite+aiosqlite:///${path.join(dataDir, 'meetings.db').replace(/\\/g, '/')}`,
    LOCAL_STORAGE_DIR: path.join(dataDir, 'audio'),
    STORAGE_BACKEND: 'local',
    BACKEND_HOST: '127.0.0.1',
    BACKEND_PORT: String(getBackendPort()),
  };

  const presentKeys = RUNTIME_ENV_KEYS.filter((key) => Boolean(backendEnv[key]));
  console.log(`[backend] Runtime AI config present: ${presentKeys.length ? presentKeys.join(', ') : 'none'}`);

  return backendEnv;
}

/**
 * Start the bundled FastAPI backend and wait until it responds to /health.
 * Rejects if the backend fails to start within the timeout.
 */
export async function startBackend(timeoutMs = 30_000): Promise<void> {
  if (backendProcess) return; // Already running

  ensurePackagedPythonRuntime();
  const pythonPath = getPythonPath();
  const backendDir = getBackendDir();
  const port = getBackendPort();

  // Ensure the writable data directory exists (for SQLite DB + audio files)
  const dataDir = getBackendDataDir();
  fs.mkdirSync(dataDir, { recursive: true });

  const backendEnv = buildBackendEnv(dataDir);

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

type ProcessTreeRunner = typeof spawnSync;

export function stopProcessTreeForWindows(
  pid: number,
  run: ProcessTreeRunner = spawnSync,
): SpawnSyncReturns<string> {
  const result = run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    encoding: 'utf8',
  });

  if (result.status !== 0 && result.error) {
    throw result.error;
  }

  return result;
}

/** Stop the backend process. Safe to call multiple times. */
export function stopBackend(options: { forceTree?: boolean } = {}): void {
  if (!backendProcess) return;
  const pid = backendProcess.pid;
  console.log(`[backend] Stopping backend process${options.forceTree ? ' tree' : ''}...`);
  try {
    if (options.forceTree && process.platform === 'win32' && pid) {
      stopProcessTreeForWindows(pid);
    } else {
      backendProcess.kill();
    }
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
