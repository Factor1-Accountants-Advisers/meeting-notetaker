import { app, dialog } from 'electron'
import { spawn, execFileSync, ChildProcess } from 'child_process'
import { existsSync, readFileSync, copyFileSync, mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { getLogInfo, logger } from './logger'
import { setTrayAlert } from './tray'
import {
  fetchHealthJson,
  probeHttpHealth,
  shouldAdoptExistingBackend,
  shouldRestartAfterBackendExit
} from './backend-health'

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
let adoptedPid: number | null = null
let restartTimestamps: number[] = []
let supervisorStarted = false
let stopRequested = false
let backendHealthy = false

function pidFilePath(): string {
  return join(app.getPath('userData'), 'backend-data', 'backend.pid')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Start the backend supervisor (packaged builds only — dev uses external uvicorn). */
export async function startBackendSupervisor(): Promise<void> {
  if (!app.isPackaged || supervisorStarted) return
  supervisorStarted = true
  stopRequested = false

  const logInfo = getLogInfo()
  logger().info('[supervisor] starting', { backendLog: logInfo.backendLog })

  // If 8787 is already healthy (e.g. an orphan from a prior crash), adopt it
  // ONLY when its /health proves the same app version (IN-484): stale
  // orphans 404 newer routes, and a failing enrolment-status silently
  // downgraded the gate to Slice 1 trust on a fleet machine (31 Jul).
  const probeStartedAt = Date.now()
  logger().info('[supervisor] probing existing backend')
  const existingHealth = await fetchHealthJson(HEALTH_URL, 2_000)
  logger().info('[supervisor] existing backend probe complete', {
    healthy: existingHealth !== null,
    reportedVersion: existingHealth?.app_version ?? null,
    elapsedMs: Date.now() - probeStartedAt,
  })
  if (existingHealth !== null) {
    if (shouldAdoptExistingBackend(existingHealth, app.getVersion())) {
      adoptedPid = readPidFile()
      logger().info('[supervisor] same-version backend on 8787 — adopting', { adoptedPid })
      return
    }
    logger().warn('[supervisor] stale or foreign backend on 8787 — replacing', {
      reportedVersion: existingHealth.app_version ?? null,
      expectedVersion: app.getVersion(),
    })
    killPortListeners()
    const freed = await waitForPortFree()
    if (!freed) {
      showBackendFailure(
        'Another process is holding the backend port (8787) and could not be stopped.',
        getLogInfo().backendLog
      )
      return
    }
  }

  await spawnAndWait()
}

/**
 * Kill every process listening on the backend port (IN-484). Orphans can
 * stack across install-over-running-app cycles, so this is by-port, not
 * by-remembered-pid. Fixed-argument execFileSync (no shell, no injectable
 * input). Best effort — callers re-probe afterwards.
 */
function killPortListeners(): void {
  if (process.platform !== 'win32') return
  try {
    const netstat = execFileSync('netstat', ['-ano', '-p', 'tcp'], {
      encoding: 'utf-8',
      windowsHide: true,
    })
    const pids = new Set<number>()
    for (const line of netstat.split(/\r?\n/)) {
      if (!line.includes(':8787 ') || !line.includes('LISTENING')) continue
      const pid = Number.parseInt(line.trim().split(/\s+/).at(-1) ?? '', 10)
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid)
    }
    for (const pid of pids) {
      // Tree-kill: a listener's multiprocessing children don't hold the port
      // themselves and would survive a single-pid kill (same failure mode as
      // the 10 Aug quit orphan — see killProcessTree).
      killProcessTree(pid)
      logger().info('[supervisor] killed backend-port listener tree', { pid })
    }
  } catch (err) {
    logger().warn('[supervisor] port-listener sweep failed', {
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Kill a process AND its descendants. Windows TerminateProcess has no group
 * semantics, so a single-pid kill orphans backend grandchildren — observed
 * live 10 Aug 2026: tray-Quit killed the direct child (14028) in 38ms but its
 * PyInstaller/multiprocessing child (18820) survived, holding port 8787.
 * taskkill /T walks the tree. Fixed-argument execFileSync, same no-shell
 * pattern as the netstat sweep above. Falls back to plain kill off-Windows.
 */
function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5_000,
      })
      return
    } catch {
      // taskkill failed (already exited, access denied) — fall through so the
      // plain kill still gets a chance at the root pid.
    }
  }
  try {
    process.kill(pid)
  } catch {
    // already exited
  }
}

async function waitForPortFree(): Promise<boolean> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (!(await healthProbe())) return true
    await sleep(250)
  }
  return false
}

function readPidFile(): number | null {
  try {
    const pid = Number.parseInt(readFileSync(pidFilePath(), 'utf-8').trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/**
 * Best-effort synchronous kill for crash paths (uncaughtException / exit).
 * Safe to call at any time; never throws.
 */
export function forceKillBackendChild(): void {
  try {
    if (child?.pid && !child.killed) killProcessTree(child.pid)
  } catch {
    // best-effort only
  }
  try {
    if (adoptedPid) killProcessTree(adoptedPid)
  } catch {
    // already gone or not ours — fine
  }
}

/** Stop the backend child process (called from before-quit). */
export function stopBackendSupervisor(): void {
  stopRequested = true
  backendHealthy = false
  const proc = child
  if (!proc) {
    // Adopted (not spawned) backend: kill by PORT, not just the remembered
    // pid — orphans stack across install cycles and the pid file only names
    // one of them (IN-484: a second orphan survived a pid-file kill on a
    // fleet machine, 31 Jul).
    if (adoptedPid) {
      logger().info('[supervisor] stopping adopted backend tree', { pid: adoptedPid })
      killProcessTree(adoptedPid)
      adoptedPid = null
      clearPidFile()
    }
    killPortListeners()
    return
  }

  logger().info('[supervisor] stopping backend child tree', { pid: proc.pid })

  // Tree-kill, not proc.kill: on Windows proc.kill terminates only the direct
  // child, orphaning its multiprocessing children (10 Aug quit orphan). It is
  // also synchronous — the old 3s SIGKILL fallback timer could never fire on
  // the quit path anyway, because the app exits before the timer does.
  if (proc.pid) killProcessTree(proc.pid)

  proc.on('exit', () => {
    logger().info('[supervisor] backend child exited')
  })

  child = null
}

// ---------------------------------------------------------------------------
// Health probe
// ---------------------------------------------------------------------------

async function healthProbe(): Promise<boolean> {
  return probeHttpHealth(HEALTH_URL, 2_000)
}

// ---------------------------------------------------------------------------
// Spawn + restart loop
// ---------------------------------------------------------------------------

async function spawnAndWait(): Promise<void> {
  spawnChild()
  if (!child) return

  const started = await pollHealth()
  if (started) {
    backendHealthy = true
    logger().info('[supervisor] backend healthy after spawn')
    return
  }

  // Backend didn't become healthy — restart with backoff.
  await restartWithBackoff()
}

function spawnChild(): void {
  backendHealthy = false
  const exePath = join(process.resourcesPath, 'backend', 'notetaker-backend.exe')
  if (!existsSync(exePath)) {
    logger().error('[supervisor] backend executable not found', { path: exePath })
    showBackendFailure('Backend executable not found', exePath)
    return
  }

  const cwd = join(process.resourcesPath, 'backend')
  const dataDir = join(app.getPath('userData'), 'backend-data')

  // Seed initial voiceprints on first launch — bundled in extraResources.
  seedInitialData(dataDir)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MN_DATA_DIR: dataDir,
    // IN-484 adoption handshake: /health echoes this so a future supervisor
    // can tell our backend from a stale orphan before adopting it.
    MN_APP_VERSION: app.getVersion(),
  }

  // Two-layer credentials: bundled team keys (shipped in installer) then
  // %PROGRAMDATA% per-machine overrides (key-rotation path, wins on conflict).
  const credsEnv = loadCredentials(join(process.resourcesPath, 'backend'))
  Object.assign(env, credsEnv)

  logger().info('[supervisor] spawning backend', { exePath, cwd, dataDir })

  const proc = spawn(exePath, [], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child = proc
  writePidFile(proc.pid)

  proc.stdout?.on('data', (data: Buffer) => {
    logger().info('[backend]', { message: data.toString().trimEnd() })
  })
  proc.stderr?.on('data', (data: Buffer) => {
    logger().error('[backend:stderr]', { message: data.toString().trimEnd() })
  })

  proc.on('error', (err: Error) => {
    logger().error('[supervisor] backend spawn error', { message: err.message })
    if (child === proc) {
      child = null
      backendHealthy = false
      clearPidFile()
    }
  })

  proc.on('exit', (code: number | null, signal: string | null) => {
    const wasCurrentChild = child === proc
    const wasHealthy = wasCurrentChild && backendHealthy
    logger().info('[supervisor] backend child exited', { code, signal })
    if (wasCurrentChild) {
      child = null
      backendHealthy = false
      clearPidFile()
    }

    if (shouldRestartAfterBackendExit({ stopRequested, wasHealthy })) {
      logger().warn('[supervisor] healthy backend exited unexpectedly; scheduling restart')
      void restartWithBackoff().catch((err) => {
        logger().error('[supervisor] unexpected-exit restart failed', {
          message: err instanceof Error ? err.message : String(err),
        })
      })
    }
  })
}

function writePidFile(pid: number | undefined): void {
  if (!pid) return
  try {
    mkdirSync(join(app.getPath('userData'), 'backend-data'), { recursive: true })
    writeFileSync(pidFilePath(), String(pid), 'utf-8')
  } catch (err) {
    logger().warn('[supervisor] could not write pid file', {
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

function clearPidFile(): void {
  try {
    unlinkSync(pidFilePath())
  } catch {
    // already absent
  }
}

// A crashed main process bypasses before-quit; make sure the child does not
// outlive us as an orphan holding port 8787.
process.on('exit', () => {
  forceKillBackendChild()
})

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
// Credentials — two-layer loading (C5)
// ---------------------------------------------------------------------------

/**
 * Parse a KEY=VALUE env file (``#`` comments, CRLF-tolerant).
 * Returns parsed entries; never logs values or key names with values.
 */
function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  try {
    // Strip a UTF-8 BOM: PowerShell's `-Encoding utf8` emits one, and a
    // BOM-prefixed first key ("﻿MN_OPENAI_API_KEY") would never match.
    const content = readFileSync(path, 'utf-8').replace(/^\uFEFF/, '')
    const env: Record<string, string> = {}
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue
      const key = trimmed.slice(0, eqIdx).trim()
      let value = trimmed.slice(eqIdx + 1).trim()
      // Tolerate the common KEY="value" / KEY='value' convention.
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1)
      }
      if (key) env[key] = value
    }
    return env
  } catch (err) {
    logger().error('[supervisor] failed to read credentials file', {
      path,
      message: err instanceof Error ? err.message : String(err),
    })
    return {}
  }
}

/**
 * Load credentials in two layers:
 * 1. Bundled ``<resources>/backend/backend.env`` — spend-capped team keys
 *    shipped in the installer (exec-approved per plan doc §3 amendment).
 * 2. ``%PROGRAMDATA%\\Factor1\\MeetingNotetaker\\backend.env`` — per-machine
 *    overrides (key-rotation path; wins on conflict).
 *
 * Logs file paths only — never key names or values.
 */
function loadCredentials(bundleDir: string): Record<string, string> {
  const bundledPath = join(bundleDir, 'backend.env')
  const programDataPath = join(
    process.env.PROGRAMDATA ?? 'C:\\ProgramData',
    'Factor1',
    'MeetingNotetaker',
    'backend.env'
  )

  const layers: { path: string; found: boolean }[] = [
    { path: bundledPath, found: false },
    { path: programDataPath, found: false },
  ]

  // Layer 1: bundled team keys (base).
  const result: Record<string, string> = {}
  const bundled = parseEnvFile(bundledPath)
  if (Object.keys(bundled).length > 0) {
    layers[0].found = true
    Object.assign(result, bundled)
  }

  // Layer 2: %PROGRAMDATA% overrides (wins on conflict).
  const programData = parseEnvFile(programDataPath)
  if (Object.keys(programData).length > 0) {
    layers[1].found = true
    Object.assign(result, programData)
  }

  logger().info('[supervisor] credentials layers', {
    layers: layers.map((l) => ({ path: l.path, found: l.found })),
  })

  return result
}

// ---------------------------------------------------------------------------
// Seed data — first-launch voiceprint preload
// ---------------------------------------------------------------------------

/**
 * Copy bundled seed files into the data directory on first launch.
 * Never overwrites existing data — only seeds when the target is missing.
 */
function seedInitialData(dataDir: string): void {
  const seedDir = join(process.resourcesPath, 'seed-data')
  if (!existsSync(seedDir)) {
    logger().info('[supervisor] no seed-data directory — skipping')
    return
  }

  const seedVoiceprints = join(seedDir, 'voiceprints.json')
  const targetVoiceprints = join(dataDir, 'voiceprints.json')

  if (existsSync(seedVoiceprints) && !existsSync(targetVoiceprints)) {
    mkdirSync(dataDir, { recursive: true })
    copyFileSync(seedVoiceprints, targetVoiceprints)
    logger().info('[supervisor] seeded initial voiceprints', {
      source: seedVoiceprints,
      target: targetVoiceprints,
    })
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
