import { app, dialog } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { existsSync, readFileSync, copyFileSync, mkdirSync, writeFileSync, unlinkSync } from 'fs'
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
let adoptedPid: number | null = null
let restartTimestamps: number[] = []
let supervisorStarted = false

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

  const logInfo = getLogInfo()
  logger().info('[supervisor] starting', { backendLog: logInfo.backendLog })

  // If 8787 is already healthy (e.g. an orphan from a prior crash), adopt it
  // — and remember its PID (from our own pid file) so quit can still stop it.
  const alreadyHealthy = await healthProbe()
  if (alreadyHealthy) {
    adoptedPid = readPidFile()
    logger().info('[supervisor] port 8787 already healthy — adopting existing backend', {
      adoptedPid,
    })
    return
  }

  await spawnAndWait()
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
    if (child && !child.killed) child.kill('SIGKILL')
  } catch {
    // best-effort only
  }
  try {
    if (adoptedPid) process.kill(adoptedPid)
  } catch {
    // already gone or not ours — fine
  }
}

/** Stop the backend child process (called from before-quit). */
export function stopBackendSupervisor(): void {
  const proc = child
  if (!proc) {
    // Adopted (not spawned) backend: we still own it via our pid file —
    // kill it so quit never leaves notetaker-backend.exe running.
    if (adoptedPid) {
      logger().info('[supervisor] stopping adopted backend', { pid: adoptedPid })
      try {
        process.kill(adoptedPid)
      } catch {
        // already exited or PID no longer ours
      }
      adoptedPid = null
      clearPidFile()
    }
    return
  }

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

  // Seed initial voiceprints on first launch — bundled in extraResources.
  seedInitialData(dataDir)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MN_DATA_DIR: dataDir,
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
    child = null
  })

  proc.on('exit', (code: number | null, signal: string | null) => {
    logger().info('[supervisor] backend child exited', { code, signal })
    child = null
    clearPidFile()
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
