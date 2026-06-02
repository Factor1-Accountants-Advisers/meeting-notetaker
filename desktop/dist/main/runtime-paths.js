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
exports.getPackagedPythonRuntimeDir = getPackagedPythonRuntimeDir;
exports.getPackagedPythonArchivePath = getPackagedPythonArchivePath;
exports.ensurePackagedPythonRuntime = ensurePackagedPythonRuntime;
exports.loadEnv = loadEnv;
exports.getBackendUrl = getBackendUrl;
exports.getBackendPort = getBackendPort;
exports.getPythonPath = getPythonPath;
exports.getBackendDir = getBackendDir;
exports.getBackendDataDir = getBackendDataDir;
const electron_1 = require("electron");
const path = __importStar(require("path"));
const dotenv = __importStar(require("dotenv"));
const fs = __importStar(require("fs"));
const child_process_1 = require("child_process");
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
function getPackagedPythonRuntimeDir() {
    return path.join(electron_1.app.getPath('userData'), 'python-runtime');
}
function getPackagedPythonArchivePath() {
    return path.join(process.resourcesPath, 'python-runtime.zip');
}
function ensurePackagedPythonRuntime(run = child_process_1.spawnSync) {
    if (!electron_1.app.isPackaged)
        return;
    const runtimeDir = getPackagedPythonRuntimeDir();
    const pythonExe = path.join(runtimeDir, 'python.exe');
    if (fs.existsSync(pythonExe))
        return;
    const archivePath = getPackagedPythonArchivePath();
    if (!fs.existsSync(archivePath)) {
        throw new Error(`[runtime] Packaged Python archive missing: ${archivePath}`);
    }
    fs.mkdirSync(runtimeDir, { recursive: true });
    console.log(`[runtime] Extracting packaged Python runtime to ${runtimeDir}`);
    const result = run('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `$ErrorActionPreference='Stop'; Expand-Archive -Path ${JSON.stringify(archivePath)} -DestinationPath ${JSON.stringify(runtimeDir)} -Force`,
    ], {
        windowsHide: true,
        encoding: 'utf8',
    });
    if (result.status !== 0 || !fs.existsSync(pythonExe)) {
        throw new Error(`[runtime] Failed to extract packaged Python runtime: ${result.stderr || result.error?.message || `exit ${result.status}`}`);
    }
}
/** Load env vars appropriate to the current mode. */
function loadEnv() {
    if (electron_1.app.isPackaged) {
        // In packaged mode, read from a bundled config next to app.asar
        const envFile = path.join(process.resourcesPath, '.env.production');
        dotenv.config({ path: envFile });
    }
    else {
        // Dev mode: read from the desktop project root
        const envFile = path.join(__dirname, '../../.env.local');
        dotenv.config({ path: envFile });
    }
}
/** Backend URL — fixed loopback port in packaged, env-configurable in dev. */
function getBackendUrl() {
    if (electron_1.app.isPackaged) {
        return process.env.BACKEND_URL ?? `http://127.0.0.1:${PACKAGED_BACKEND_PORT}`;
    }
    return process.env.BACKEND_URL ?? 'http://localhost:8000';
}
/** Port the backend should listen on when spawned by Electron. */
function getBackendPort() {
    return PACKAGED_BACKEND_PORT;
}
/** Path to the bundled Python interpreter (extraResources/python/). */
function getPythonPath() {
    if (electron_1.app.isPackaged) {
        return path.join(getPackagedPythonRuntimeDir(), 'python.exe');
    }
    return process.env.PYTHON_PATH ?? 'python';
}
/** Path to the backend source directory (extraResources/backend/). */
function getBackendDir() {
    if (electron_1.app.isPackaged) {
        return path.join(process.resourcesPath, 'backend');
    }
    return path.join(__dirname, '../../../backend');
}
/**
 * Writable data directory for the packaged backend (database + audio files).
 * Program Files is read-only, so we use %LOCALAPPDATA%/meeting-notetaker-desktop/backend-data/.
 */
function getBackendDataDir() {
    return path.join(electron_1.app.getPath('userData'), 'backend-data');
}
//# sourceMappingURL=runtime-paths.js.map