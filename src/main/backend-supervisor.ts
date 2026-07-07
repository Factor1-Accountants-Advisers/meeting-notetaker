import { app, dialog } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getLogInfo, logger } from './logger'
import { setTrayAlert } from './tray'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEALTH_URL = 'http://127.0.0.1:8787/health'
const HEALTH_POLL_INTERVAL_MS = 500
const HEALTH_TIMEOUT_MS = 20_000
const RESTART_BACKOFF_MS = [1_000, 5_000, 25_000]
const RESTART_WINDOW_MS = 5 * 60 * 1_000
const MAX_RESTARTS_IN_WINDOW = 3

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let child: ChildProcess | null = null
let restartTimestamps: number[] = []
let supervisorStarted = false

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Start the backend supervisor (packaged builds only — dev uses external uvicorn). */
export async function startBackendSupervisor(): Promise<void> {
  if (!app.isPackaged || supervisorStarted) return
  supervisorStarted = true

  const logInfo = getLogInfo()
  logger().info('[supervisor] starting', { backendLog: logInfo.backendLog })

  // If 8787 is already healthy (e.g. dev uvicorn still running), adopt it.
  const alreadyHealthy = await healthProbe()
  if (alreadyHealthy) {
    logger().info('[supervisor] port 8787 already healthy — adopting existing backend')
    return
  }

  await spawnAndWait()
}

/** Stop the backend child process (called from before-quit). */
export function stopBackendSupervisor(): void {
  const proc = child
  if (!proc) return

  logger().info('[supervisor] stopping backend child', { pid: proc.pid })

  // Graceful shutdown first.
  proc.kill('SIGTERM')

  // Wait briefly, then force-kill.
  const forceTimer = setTimeout(() => {
    if (!proc.killed) {
      logger().warn('[supervisor] force-killing backend child', { pid: proc.pid })
      proc.kill('SIGKILL')
    }
  }, 3_000)

  proc.on('exit', () => {
    clearTimeout(forceTimer)
    logger().info('[supervisor] backend child exited')
  })

  child = null
}

// ---------------------------------------------------------------------------
// Health probe
// ---------------------------------------------------------------------------

async function healthProbe(): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2_000)
    const resp = await fetch(HEALTH_URL, { signal: controller.signal })
    clearTimeout(timeout)
    return resp.ok
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Spawn + restart loop
// ---------------------------------------------------------------------------

async function spawnAndWait(): Promise<void> {
  spawnChild()
  if (!child) return

  const started = await pollHealth()
  if (started) {
    logger().info('[supervisor] backend healthy after spawn')
    return
  }

  // Backend didn't become healthy — restart with backoff.
  await restartWithBackoff()
}

function spawnChild(): void {
  const exePath = join(process.resourcesPath, 'backend', 'notetaker-backend.exe')
  if (!existsSync(exePath)) {
    logger().error('[supervisor] backend executable not found', { path: exePath })
    showBackendFailure('Backend executable not found', exePath)
    return
  }

  const cwd = join(process.resourcesPath, 'backend')
  const dataDir = join(app.getPath('userData'), 'backend-data')

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MN_DATA_DIR: dataDir,
  }

  // Merge %PROGRAMDATA% credentials file if present (C4).
  const credsEnv = loadProgramDataEnv()
  Object.assign(env, credsEnv)

  logger().info('[supervisor] spawning backend', { exePath, cwd, dataDir })

  const proc = spawn(exePath, [], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child = proc

  proc.stdout?.on('data', (data: Buffer) => {
    logger().info('[backend]', { message: data.toString().trimEnd() })
  })
  proc.stderr?.on('data', (data: Buffer) => {
    logger().error('[backend:stderr]', { message: data.toString().trimEnd() })
  })

  proc.on('error', (err: Error) => {
    logger().error('[supervisor] backend spawn error', { message: err.message })
    child = null
  })

  proc.on('exit', (code: number | null, signal: string | null) => {
    logger().info('[supervisor] backend child exited', { code, signal })
    child = null
  })
}

async function pollHealth(): Promise<boolean> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await healthProbe()) return true
    await sleep(HEALTH_POLL_INTERVAL_MS)
  }
  return false
}

async function restartWithBackoff(): Promise<void> {
  const now = Date.now()

  // Prune restart timestamps outside the window.
  restartTimestamps = restartTimestamps.filter((t) => now - t < RESTART_WINDOW_MS)

  if (restartTimestamps.length >= MAX_RESTARTS_IN_WINDOW) {
    logger().error(
      '[supervisor] max restarts exceeded',
      { restarts: restartTimestamps.length, windowMs: RESTART_WINDOW_MS }
    )
    showBackendFailure(
      'Backend failed to start after multiple attempts.\n\nCheck the log file for details.',
      getLogInfo().backendLog
    )
    return
  }

  restartTimestamps.push(now)
  const attempt = restartTimestamps.length
  const delay = RESTART_BACKOFF_MS[Math.min(attempt - 1, RESTART_BACKOFF_MS.length - 1)]

  logger().warn('[supervisor] restarting backend', { attempt, delayMs: delay })
  await sleep(delay)
  await spawnAndWait()
}

// ---------------------------------------------------------------------------
// %PROGRAMDATA% credentials file (C4)
// ---------------------------------------------------------------------------

function loadProgramDataEnv(): Record<string, string> {
  const envPath = join(
    process.env.PROGRAMDATA ?? 'C:\\ProgramData',
    'Factor1',
    'MeetingNotetaker',
    'backend.env'
  )

  if (!existsSync(envPath)) {
    logger().info('[supervisor] no credentials file at %PROGRAMDATA% — using stubs', { path: envPath })
    return {}
  }

  try {
    const content = readFileSync(envPath, 'utf-8')
    const env: Record<string, string> = {}
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue
      const key = trimmed.slice(0, eqIdx).trim()
      const value = trimmed.slice(eqIdx + 1).trim()
      if (key) env[key] = value
    }
    logger().info('[supervisor] loaded credentials file', { path: envPath, keys: Object.keys(env) })
    return env
  } catch (err) {
    logger().error('[supervisor] failed to read credentials file', {
      path: envPath,
      message: err instanceof Error ? err.message : String(err),
    })
    return {}
  }
}

// ---------------------------------------------------------------------------
// Failure UX
// ---------------------------------------------------------------------------

function showBackendFailure(message: string, logPath: string): void {
  logger().error('[supervisor] backend failure surfaced to user', { message, logPath })

  // Tray tooltip.
  setTrayAlert('Backend unavailable')

  // Modal dialog (won't block if window not shown yet — queued for next show).
  dialog.showErrorBox(
    'Meeting Notetaker — Backend Unavailable',
    `${message}\n\nLog file: ${logPath}`
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
