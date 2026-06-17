"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveRuntimeOverrideEnv = saveRuntimeOverrideEnv;
exports.getRuntimeEnvStatus = getRuntimeEnvStatus;
exports.loadRuntimeOverrideEnv = loadRuntimeOverrideEnv;
exports.buildBackendEnv = buildBackendEnv;
exports.startBackend = startBackend;
exports.stopProcessTreeForWindows = stopProcessTreeForWindows;
exports.stopBackend = stopBackend;
const child_process_1 = require("child_process");
const runtime_paths_1 = require("./runtime-paths");
const http = __importStar(require("http"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const dotenv = __importStar(require("dotenv"));
let backendProcess = null;
const RUNTIME_ENV_FILE = '.env.production.local';
const RUNTIME_ENV_KEYS = ['ASSEMBLYAI_API_KEY', 'OPENAI_API_KEY', 'PYANNOTE_API_KEY'];
function saveRuntimeOverrideEnv(userDataDir, keys) {
    const envPath = path.join(userDataDir, RUNTIME_ENV_FILE);
    // Read existing lines, merge with new values
    let existingLines = [];
    if (fs.existsSync(envPath)) {
        existingLines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
    }
    // Build a map of existing keys, removing any that match RUNTIME_ENV_KEYS
    const keptLines = existingLines.filter((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#'))
            return true;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1)
            return true;
        const key = trimmed.slice(0, eqIdx).trim();
        return !RUNTIME_ENV_KEYS.includes(key);
    });
    // Append new values (only non-empty)
    for (const key of RUNTIME_ENV_KEYS) {
        const value = keys[key]?.trim();
        if (value) {
            keptLines.push(`${key}=${value}`);
        }
    }
    fs.writeFileSync(envPath, keptLines.join('\n') + '\n', 'utf-8');
    console.log(`[runtime] Saved runtime env overrides to ${envPath}`);
}
function getRuntimeEnvStatus(userDataDir) {
    const overrides = loadRuntimeOverrideEnv(userDataDir);
    const status = {};
    for (const key of RUNTIME_ENV_KEYS) {
        status[key] = Boolean(overrides[key]?.trim());
    }
    return status;
}
function loadRuntimeOverrideEnv(userDataDir) {
    const envPath = path.join(userDataDir, RUNTIME_ENV_FILE);
    if (!fs.existsSync(envPath)) {
        return {};
    }
    const parsed = dotenv.parse(fs.readFileSync(envPath));
    const overrides = {};
    for (const key of RUNTIME_ENV_KEYS) {
        const value = parsed[key]?.trim();
        if (value) {
            overrides[key] = value;
        }
    }
    return overrides;
}
function buildBackendEnv(dataDir, userDataDir = path.dirname(dataDir)) {
    const runtimeOverrides = loadRuntimeOverrideEnv(userDataDir);
    const backendEnv = {
        ...process.env,
        ...runtimeOverrides,
        DATABASE_URL: `sqlite+aiosqlite:///${path.join(dataDir, 'meetings.db').replace(/\\/g, '/')}`,
        LOCAL_STORAGE_DIR: path.join(dataDir, 'audio'),
        STORAGE_BACKEND: 'local',
        BACKEND_HOST: '127.0.0.1',
        BACKEND_PORT: String((0, runtime_paths_1.getBackendPort)()),
    };
    const presentKeys = RUNTIME_ENV_KEYS.filter((key) => Boolean(backendEnv[key]));
    console.log(`[backend] Runtime AI config present: ${presentKeys.length ? presentKeys.join(', ') : 'none'}`);
    return backendEnv;
}
/**
 * Start the bundled FastAPI backend and wait until it responds to /health.
 * Rejects if the backend fails to start within the timeout.
 */
async function startBackend(timeoutMs = 30000) {
    if (backendProcess)
        return; // Already running
    (0, runtime_paths_1.ensurePackagedPythonRuntime)();
    const pythonPath = (0, runtime_paths_1.getPythonPath)();
    const backendDir = (0, runtime_paths_1.getBackendDir)();
    const port = (0, runtime_paths_1.getBackendPort)();
    // Ensure the writable data directory exists (for SQLite DB + audio files)
    const dataDir = (0, runtime_paths_1.getBackendDataDir)();
    fs.mkdirSync(dataDir, { recursive: true });
    const backendEnv = buildBackendEnv(dataDir);
    console.log(`[backend] Spawning: ${pythonPath} -m uvicorn app.main:app --host 127.0.0.1 --port ${port}`);
    console.log(`[backend] Working directory: ${backendDir}`);
    console.log(`[backend] Data directory: ${dataDir}`);
    backendProcess = (0, child_process_1.spawn)(pythonPath, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port)], {
        cwd: backendDir,
        env: backendEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    backendProcess.stdout?.on('data', (chunk) => {
        console.log(`[backend:stdout] ${chunk.toString().trimEnd()}`);
    });
    backendProcess.stderr?.on('data', (chunk) => {
        console.log(`[backend:stderr] ${chunk.toString().trimEnd()}`);
    });
    backendProcess.on('exit', (code, signal) => {
        console.warn(`[backend] Process exited (code=${code}, signal=${signal})`);
        backendProcess = null;
    });
    // Wait for /health to respond
    await waitForHealth((0, runtime_paths_1.getBackendUrl)(), timeoutMs);
}
function stopProcessTreeForWindows(pid, run = child_process_1.spawnSync) {
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
function stopBackend(options = {}) {
    if (!backendProcess)
        return;
    const pid = backendProcess.pid;
    console.log(`[backend] Stopping backend process${options.forceTree ? ' tree' : ''}...`);
    try {
        if (options.forceTree && process.platform === 'win32' && pid) {
            stopProcessTreeForWindows(pid);
        }
        else {
            backendProcess.kill();
        }
    }
    catch (err) {
        console.warn('[backend] Error killing backend process:', err);
    }
    backendProcess = null;
}
function waitForHealth(baseUrl, timeoutMs) {
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
                }
                else {
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
//# sourceMappingURL=backend-runtime.js.map