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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initLogger = initLogger;
exports.createBackendLogger = createBackendLogger;
exports.getRendererLogPath = getRendererLogPath;
exports.getMainLogPath = getMainLogPath;
exports.getBackendLogPath = getBackendLogPath;
exports.getLogInfo = getLogInfo;
const electron_log_1 = __importDefault(require("electron-log"));
const electron_1 = require("electron");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
// ── Configuration ──────────────────────────────────────────────────────────
const LOG_DIR = path.join(electron_1.app.getPath('userData'), 'logs');
const MAIN_LOG = path.join(LOG_DIR, 'main.log');
const BACKEND_LOG = path.join(LOG_DIR, 'backend.log');
const RENDERER_LOG = path.join(LOG_DIR, 'renderer.log');
// ── Setup ──────────────────────────────────────────────────────────────────
function initLogger() {
    // Ensure the logs directory exists
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // Configure electron-log transports
    electron_log_1.default.transports.file.resolvePathFn = () => MAIN_LOG;
    electron_log_1.default.transports.file.maxSize = 5 * 1024 * 1024; // 5 MB per file
    electron_log_1.default.transports.file.archiveLog = (logFile) => {
        // Rotate: rename to main.old.log before starting fresh
        const p = logFile.path;
        const oldLog = p.replace('.log', '.old.log');
        try {
            if (fs.existsSync(oldLog))
                fs.unlinkSync(oldLog);
            if (fs.existsSync(p))
                fs.renameSync(p, oldLog);
        }
        catch { /* best-effort */ }
    };
    // Also keep console output in dev mode
    if (!electron_1.app.isPackaged) {
        electron_log_1.default.transports.console.level = 'silly';
    }
    // Replace global console with electron-log so all existing console.log/warn/error calls
    // are automatically captured to file.
    console.log = (...args) => electron_log_1.default.info(...args);
    console.warn = (...args) => electron_log_1.default.warn(...args);
    console.error = (...args) => electron_log_1.default.error(...args);
    console.debug = (...args) => electron_log_1.default.debug(...args);
    // Capture uncaught exceptions and unhandled promise rejections
    process.on('uncaughtException', (err) => {
        electron_log_1.default.error('[fatal] Uncaught exception:', err.message);
        electron_log_1.default.error('[fatal] Stack:', err.stack);
        // Keep the default Electron crash dialog
    });
    process.on('unhandledRejection', (reason) => {
        const msg = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
        electron_log_1.default.warn('[fatal] Unhandled promise rejection:', msg);
    });
    electron_log_1.default.info('═══════════════════════════════════════');
    const version = typeof electron_1.app.getVersion === 'function' ? electron_1.app.getVersion() : 'unknown';
    electron_log_1.default.info(`App started — v${version} — ${new Date().toISOString()}`);
    electron_log_1.default.info(`Packaged: ${electron_1.app.isPackaged}`);
    electron_log_1.default.info(`User data: ${electron_1.app.getPath('userData')}`);
    electron_log_1.default.info(`Log file: ${MAIN_LOG}`);
    electron_log_1.default.info('═══════════════════════════════════════');
}
// ── Backend process logging ────────────────────────────────────────────────
/**
 * Create a writeable stream that logs backend stdout/stderr to backend.log
 * and also forwards to the main logger (for real-time console visibility).
 */
function createBackendLogger() {
    const stdoutStream = fs.createWriteStream(BACKEND_LOG, { flags: 'a' });
    const stderrStream = fs.createWriteStream(BACKEND_LOG, { flags: 'a' });
    const timestamp = new Date().toISOString();
    stdoutStream.write(`\n─── Backend started at ${timestamp} ───\n`);
    stderrStream.write(`\n─── Backend started at ${timestamp} ───\n`);
    // Override write to also echo to main log
    const origStdoutWrite = stdoutStream.write.bind(stdoutStream);
    stdoutStream.write = (chunk, ...rest) => {
        const str = typeof chunk === 'string' ? chunk : String(chunk);
        electron_log_1.default.info(`[backend] ${str.trimEnd()}`);
        return origStdoutWrite(chunk, ...rest);
    };
    const origStderrWrite = stderrStream.write.bind(stderrStream);
    stderrStream.write = (chunk, ...rest) => {
        const str = typeof chunk === 'string' ? chunk : String(chunk);
        electron_log_1.default.warn(`[backend:err] ${str.trimEnd()}`);
        return origStderrWrite(chunk, ...rest);
    };
    return { stdout: stdoutStream, stderr: stderrStream };
}
/**
 * Get the renderer log file path (for forwarding renderer console logs).
 */
function getRendererLogPath() {
    return RENDERER_LOG;
}
/**
 * Get the main log file path.
 */
function getMainLogPath() {
    return MAIN_LOG;
}
/**
 * Get the backend log file path.
 */
function getBackendLogPath() {
    return BACKEND_LOG;
}
// ── IPC handler helper ─────────────────────────────────────────────────────
/**
 * Return log directory info for the Settings page.
 */
function getLogInfo() {
    return {
        logDir: LOG_DIR,
        mainLog: MAIN_LOG,
        backendLog: BACKEND_LOG,
        rendererLog: RENDERER_LOG,
    };
}
//# sourceMappingURL=logger.js.map