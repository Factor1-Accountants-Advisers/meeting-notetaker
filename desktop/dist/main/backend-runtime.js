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
exports.startBackend = startBackend;
exports.stopBackend = stopBackend;
const child_process_1 = require("child_process");
const runtime_paths_1 = require("./runtime-paths");
const http = __importStar(require("http"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
let backendProcess = null;
/**
 * Start the bundled FastAPI backend and wait until it responds to /health.
 * Rejects if the backend fails to start within the timeout.
 */
async function startBackend(timeoutMs = 30000) {
    if (backendProcess)
        return; // Already running
    const pythonPath = (0, runtime_paths_1.getPythonPath)();
    const backendDir = (0, runtime_paths_1.getBackendDir)();
    const port = (0, runtime_paths_1.getBackendPort)();
    // Ensure the writable data directory exists (for SQLite DB + audio files)
    const dataDir = (0, runtime_paths_1.getBackendDataDir)();
    fs.mkdirSync(dataDir, { recursive: true });
    // Build environment for the backend process.
    // In packaged mode, pass env vars that override defaults in config.py
    // so the backend writes to a writable location, not Program Files.
    const backendEnv = {
        ...process.env,
        DATABASE_URL: `sqlite+aiosqlite:///${path.join(dataDir, 'meetings.db').replace(/\\/g, '/')}`,
        LOCAL_STORAGE_DIR: path.join(dataDir, 'audio'),
        STORAGE_BACKEND: 'local',
        BACKEND_HOST: '127.0.0.1',
        BACKEND_PORT: String(port),
    };
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
/** Stop the backend process. Safe to call multiple times. */
function stopBackend() {
    if (!backendProcess)
        return;
    console.log('[backend] Stopping backend process...');
    try {
        // On Windows, child_process.kill() sends taskkill by default.
        // tree-kill would be better, but for a single uvicorn process this works.
        backendProcess.kill();
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