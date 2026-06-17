import log from 'electron-log';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

// ── Configuration ──────────────────────────────────────────────────────────

const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const MAIN_LOG = path.join(LOG_DIR, 'main.log');
const BACKEND_LOG = path.join(LOG_DIR, 'backend.log');
const RENDERER_LOG = path.join(LOG_DIR, 'renderer.log');

// ── Setup ──────────────────────────────────────────────────────────────────

export function initLogger(): void {
  // Ensure the logs directory exists
  fs.mkdirSync(LOG_DIR, { recursive: true });

  // Configure electron-log transports
  log.transports.file.resolvePathFn = () => MAIN_LOG;
  log.transports.file.maxSize = 5 * 1024 * 1024; // 5 MB per file
  log.transports.file.archiveLog = (logFile: { path: string }) => {
    // Rotate: rename to main.old.log before starting fresh
    const p = logFile.path;
    const oldLog = p.replace('.log', '.old.log');
    try {
      if (fs.existsSync(oldLog)) fs.unlinkSync(oldLog);
      if (fs.existsSync(p)) fs.renameSync(p, oldLog);
    } catch { /* best-effort */ }
  };

  // Also keep console output in dev mode
  if (!app.isPackaged) {
    log.transports.console.level = 'silly';
  }

  // Replace global console with electron-log so all existing console.log/warn/error calls
  // are automatically captured to file.
  console.log = (...args: unknown[]) => log.info(...args);
  console.warn = (...args: unknown[]) => log.warn(...args);
  console.error = (...args: unknown[]) => log.error(...args);
  console.debug = (...args: unknown[]) => log.debug(...args);

  // Capture uncaught exceptions and unhandled promise rejections
  process.on('uncaughtException', (err) => {
    log.error('[fatal] Uncaught exception:', err.message);
    log.error('[fatal] Stack:', err.stack);
    // Keep the default Electron crash dialog
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
    log.warn('[fatal] Unhandled promise rejection:', msg);
  });

  log.info('═══════════════════════════════════════');
  const version = typeof app.getVersion === 'function' ? app.getVersion() : 'unknown';
  log.info(`App started — v${version} — ${new Date().toISOString()}`);
  log.info(`Packaged: ${app.isPackaged}`);
  log.info(`User data: ${app.getPath('userData')}`);
  log.info(`Log file: ${MAIN_LOG}`);
  log.info('═══════════════════════════════════════');
}

// ── Backend process logging ────────────────────────────────────────────────

/**
 * Create a writeable stream that logs backend stdout/stderr to backend.log
 * and also forwards to the main logger (for real-time console visibility).
 */
export function createBackendLogger(): { stdout: fs.WriteStream; stderr: fs.WriteStream } {
  const stdoutStream = fs.createWriteStream(BACKEND_LOG, { flags: 'a' });
  const stderrStream = fs.createWriteStream(BACKEND_LOG, { flags: 'a' });

  const timestamp = new Date().toISOString();
  stdoutStream.write(`\n─── Backend started at ${timestamp} ───\n`);
  stderrStream.write(`\n─── Backend started at ${timestamp} ───\n`);

  // Override write to also echo to main log
  const origStdoutWrite = stdoutStream.write.bind(stdoutStream);
  stdoutStream.write = (chunk: unknown, ...rest: unknown[]) => {
    const str = typeof chunk === 'string' ? chunk : String(chunk);
    log.info(`[backend] ${str.trimEnd()}`);
    return origStdoutWrite(chunk, ...(rest as []));
  };

  const origStderrWrite = stderrStream.write.bind(stderrStream);
  stderrStream.write = (chunk: unknown, ...rest: unknown[]) => {
    const str = typeof chunk === 'string' ? chunk : String(chunk);
    log.warn(`[backend:err] ${str.trimEnd()}`);
    return origStderrWrite(chunk, ...(rest as []));
  };

  return { stdout: stdoutStream, stderr: stderrStream };
}

/**
 * Get the renderer log file path (for forwarding renderer console logs).
 */
export function getRendererLogPath(): string {
  return RENDERER_LOG;
}

/**
 * Get the main log file path.
 */
export function getMainLogPath(): string {
  return MAIN_LOG;
}

/**
 * Get the backend log file path.
 */
export function getBackendLogPath(): string {
  return BACKEND_LOG;
}

// ── IPC handler helper ─────────────────────────────────────────────────────

/**
 * Return log directory info for the Settings page.
 */
export function getLogInfo(): { logDir: string; mainLog: string; backendLog: string; rendererLog: string } {
  return {
    logDir: LOG_DIR,
    mainLog: MAIN_LOG,
    backendLog: BACKEND_LOG,
    rendererLog: RENDERER_LOG,
  };
}
