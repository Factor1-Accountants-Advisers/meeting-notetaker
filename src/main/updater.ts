import { app, ipcMain, Notification, powerMonitor } from 'electron'
import updater from 'electron-updater'
import { logger } from './logger'
import {
  COUNTDOWN_SECONDS,
  evaluateUpdateGate,
  isBackendBusy,
  SNOOZE_MS,
  type UpdateGateInput,
  type UpdateGateVerdict
} from './update-gate'
import { buildUpdateCountdownToastXml } from './toast-xml'

// electron-updater is CommonJS; named ESM imports fail at runtime.
const { autoUpdater } = updater

// Updates (decision #12): electron-updater against the static Blob feed.
// Background download, install on restart. No-ops in dev / unpackaged builds.
export interface UpdateStatus {
  state: 'dev' | 'checking' | 'up-to-date' | 'available' | 'downloaded' | 'error'
  version?: string
  message?: string
}

// IN-469: lifecycle dependencies injected from index.ts so this module stays
// free of imports into recording-ipc/tray (no cycles) and testable.
export interface UpdaterDeps {
  getRecordingState: () => string
  hasPendingAutoStart: () => boolean
  getNextAutoRecordStartUtcMs: () => number | null
  getActor: () => string
  onUpdateReady: (version: string) => void // tray + toast surfacing
}

autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true

const CHECK_INTERVAL_MS = 4 * 60 * 60_000
const IDLE_POLL_MS = 5 * 60_000

let lifecycleDeps: UpdaterDeps | null = null
let downloadedVersion: string | null = null
let snoozedUntilUtcMs = 0
let idlePollTimer: NodeJS.Timeout | null = null
let countdownTimer: NodeJS.Timeout | null = null
let idleTickInFlight = false
// Last logged gate outcome: a reason string while blocked, null once allowed,
// undefined before the first tick. Used to log only on transitions.
let lastGateReason: string | null | undefined = undefined

// IN-469: probe the local backend for in-flight pipeline work before letting
// an update auto-install. Every failure path returns true (busy) — we only
// install when the backend provably has nothing in flight.
async function fetchBackendBusy(getActor: () => string): Promise<boolean> {
  const actor = getActor()
  // Fail-open guard: list_meetings filters by can_see(actor). An
  // unauthenticated/default actor gets an EMPTY list — which would read
  // as "not busy" while work may be in flight. Can't prove quiet → busy.
  if (!actor || actor === 'Unknown user') return true
  try {
    const res = await fetch('http://127.0.0.1:8787/api/v1/meetings', {
      headers: { 'X-MN-User': actor },
      signal: AbortSignal.timeout(5_000)
    })
    if (!res.ok) return true // can't prove quiet — fail safe, block install
    const meetings = (await res.json()) as Array<{ pipeline_status: string; created_at: string }>
    return isBackendBusy(meetings, Date.now())
  } catch {
    return true // backend unreachable mid-restart etc. — block install this cycle
  }
}

async function buildGateInput(deps: UpdaterDeps): Promise<UpdateGateInput> {
  return {
    updateDownloaded: downloadedVersion !== null,
    recordingState: deps.getRecordingState(),
    pendingAutoStart: deps.hasPendingAutoStart(),
    nextAutoRecordStartUtcMs: deps.getNextAutoRecordStartUtcMs(),
    backendBusy: await fetchBackendBusy(deps.getActor),
    systemIdleSeconds: powerMonitor.getSystemIdleTime(),
    snoozedUntilUtcMs,
    nowUtcMs: Date.now()
  }
}

/**
 * Single choke point for quitAndInstall — EVERY install goes through here and
 * re-evaluates the gate first. `user_active` and `snoozed` are neutralised by
 * design: both callers (countdown expiry, explicit "Restart now") have already
 * established user intent. recording_active / auto_start_pending /
 * auto_record_imminent / backend_processing always block.
 */
async function tryInstallNow(trigger: 'countdown' | 'restart-request'): Promise<UpdateGateVerdict> {
  const deps = lifecycleDeps
  if (!deps || downloadedVersion === null) {
    return { allow: false, reason: 'no_update_downloaded' }
  }
  const input = await buildGateInput(deps)
  const verdict = evaluateUpdateGate({
    ...input,
    systemIdleSeconds: Number.MAX_SAFE_INTEGER, // user_active non-blocking here
    snoozedUntilUtcMs: 0 // snoozed non-blocking here
  })
  if (!verdict.allow) {
    logger().info('[updater] install aborted by gate', { trigger, reason: verdict.reason })
    return verdict
  }
  logger().info('[updater] installing update', { version: downloadedVersion, trigger })
  autoUpdater.quitAndInstall(true, true) // silent install, force relaunch
  return verdict
}

function showWindowsToast(xml: string, fallbackBody: string, logTag: string): void {
  // Notification is undefined outside the Electron runtime (verify harnesses).
  if (!Notification?.isSupported?.()) return
  try {
    if (process.platform === 'win32') {
      new Notification({ toastXml: xml }).show()
    } else {
      new Notification({ title: 'Meeting Notetaker', body: fallbackBody, silent: true }).show()
    }
    logger().info(`[updater] ${logTag} toast requested`)
  } catch (err) {
    logger().warn(`[updater] could not show ${logTag} toast`, {
      message: err instanceof Error ? err.message : String(err)
    })
  }
}

function startCountdown(): void {
  if (countdownTimer) return // one countdown at a time
  const version = downloadedVersion ?? ''
  const body = `Restarting to update to ${version} in ${COUNTDOWN_SECONDS} seconds…`
  showWindowsToast(buildUpdateCountdownToastXml(version, COUNTDOWN_SECONDS), body, 'update-countdown')
  logger().info('[updater] install countdown started', { version, seconds: COUNTDOWN_SECONDS })
  countdownTimer = setTimeout(() => {
    countdownTimer = null
    // Re-check ONCE: a recording may have started mid-countdown. user_active /
    // snoozed are non-blocking for this final check (see tryInstallNow).
    void tryInstallNow('countdown').catch((err) => {
      logger().warn('[updater] countdown install failed', {
        message: err instanceof Error ? err.message : String(err)
      })
    })
  }, COUNTDOWN_SECONDS * 1_000)
}

async function idlePollTick(deps: UpdaterDeps): Promise<void> {
  if (countdownTimer) return // countdown armed — it owns the next decision
  const verdict = evaluateUpdateGate(await buildGateInput(deps))
  if (!verdict.allow) {
    if (verdict.reason !== lastGateReason) {
      logger().info('[updater] install blocked', { reason: verdict.reason, version: downloadedVersion })
      lastGateReason = verdict.reason
    }
    return
  }
  if (lastGateReason !== null) {
    logger().info('[updater] gate allows install', { version: downloadedVersion })
    lastGateReason = null
  }
  startCountdown()
}

function startIdlePoll(deps: UpdaterDeps): void {
  if (idlePollTimer) return // only one poll, even across repeated download events
  idlePollTimer = setInterval(() => {
    if (idleTickInFlight) return // backend probe can outlast a tick — don't overlap
    idleTickInFlight = true
    idlePollTick(deps)
      .catch((err) => {
        logger().warn('[updater] idle poll tick failed', {
          message: err instanceof Error ? err.message : String(err)
        })
      })
      .finally(() => {
        idleTickInFlight = false
      })
  }, IDLE_POLL_MS)
}

export function startUpdaterLifecycle(deps: UpdaterDeps): void {
  lifecycleDeps = deps
  if (!app.isPackaged) {
    logger().info('[updater] lifecycle skipped in dev/unpackaged build')
    return
  }

  // Never checkForUpdatesAndNotify — our toasts replace the built-in one.
  const runCheck = (phase: string): void => {
    logger().info('[updater] check started', { phase })
    autoUpdater.checkForUpdates().catch((err) => {
      // Feed unreachable (e.g. not provisioned yet) — never block startup.
      logger().warn('[updater] check failed', {
        phase,
        message: err instanceof Error ? err.message : String(err)
      })
    })
  }

  autoUpdater.on('update-downloaded', (info) => {
    downloadedVersion = info.version
    logger().info('[updater] update downloaded', { version: info.version })
    deps.onUpdateReady(info.version)
    startIdlePoll(deps)
  })

  runCheck('launch')
  setInterval(() => runCheck('interval'), CHECK_INTERVAL_MS)
}

/** "Later" / "Not now" — snooze 4 h and cancel any armed countdown. */
export function deferUpdate(): void {
  snoozedUntilUtcMs = Date.now() + SNOOZE_MS
  if (countdownTimer) {
    clearTimeout(countdownTimer)
    countdownTimer = null
  }
  logger().info('[updater] update deferred', {
    version: downloadedVersion,
    snoozedUntilUtcMs
  })
}

/**
 * "Restart now" — explicit intent, so user_active/snoozed do not block, but
 * recordings and backend work still do; when blocked, explain via toast.
 */
export function restartNowRequested(): void {
  logger().info('[updater] restart now requested', { version: downloadedVersion })
  void (async () => {
    const verdict = await tryInstallNow('restart-request')
    if (verdict.allow) return
    const body =
      verdict.reason === 'backend_processing'
        ? 'A meeting is still processing — the update will install later.'
        : verdict.reason === 'no_update_downloaded'
          ? 'No update is ready to install yet.'
          : 'Recording in progress — the update will install later.'
    // Plain informational toast — no buttons needed.
    if (Notification?.isSupported?.()) {
      try {
        new Notification({ title: 'Meeting Notetaker', body, silent: true }).show()
      } catch (err) {
        logger().warn('[updater] could not show blocked-restart toast', {
          message: err instanceof Error ? err.message : String(err)
        })
      }
    }
  })().catch((err) => {
    logger().warn('[updater] restart request failed', {
      message: err instanceof Error ? err.message : String(err)
    })
  })
}

export function registerUpdaterIpc(): void {
  ipcMain.handle('updates:check', async (): Promise<UpdateStatus> => {
    logger().info('[updater] manual check requested', { packaged: app.isPackaged })
    if (!app.isPackaged) return { state: 'dev', version: app.getVersion() }
    try {
      const result = await autoUpdater.checkForUpdates()
      const latest = result?.updateInfo.version
      if (latest && latest !== app.getVersion()) {
        logger().info('[updater] update available', { version: latest })
        return { state: 'available', version: latest }
      }
      logger().info('[updater] app is up to date', { version: app.getVersion() })
      return { state: 'up-to-date', version: app.getVersion() }
    } catch (err) {
      logger().warn('[updater] manual check failed', {
        message: err instanceof Error ? err.message : String(err)
      })
      return { state: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  })
}
