import { app, BrowserWindow, ipcMain, Notification, powerMonitor } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { join } from 'path'
import { registerApiProxyIpc } from './api-proxy'
import { getCurrentUser, getCurrentUserEmail, getGraphAccessToken, onMsalSignedIn, registerAuthSessionIpc } from './auth-session'
import { startGraphDetectionRuntime } from './graph/runtime'
import { loadPublicEnv } from './env'
import { evaluateHostGate, hostGateLogContext } from './graph/host-gate'
import { initLogger, logger } from './logger'
import { registerMediaPermissions } from './media-permissions'
import {
  cleanupRecordingIpc,
  extendActiveRecordingFromMain,
  extendAutoStop,
  getRecordingStateMachine,
  handleRendererRecordingError,
  handleRendererRecordingReady,
  handleRendererRecordingStarted,
  handleRendererRecordingStopped,
  hasPendingAutoStart,
  registerManualRecording,
  sendAutoStartRequest,
  setRecordingPaused
} from './recording-ipc'
import { registerRecordingStorageIpc } from './recording-storage'
import { ensureDefaultAutoLaunchEnabled, isBackgroundLaunch, registerStartupIpc } from './startup'
import {
  buildUpdateReadyToastXml,
  toastActionFromArgv,
  TOAST_PROTOCOL_SCHEME
} from './toast-xml'
import { createTray, destroyTray, setTraySkipped, setUpdateReady, setUpdateRestartHandler, updateTrayMenu } from './tray'
import {
  deferUpdate,
  registerUpdaterIpc,
  restartNowRequested,
  startUpdaterLifecycle,
  stopUpdaterTimers
} from './updater'
import { startBackendSupervisor, stopBackendSupervisor } from './backend-supervisor'
import { createWindow, registerWindowSizingIpc } from './window'
import type { GraphEventDecision } from './graph/types'

loadPublicEnv()
initLogger()
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
}

registerAuthSessionIpc()
registerApiProxyIpc()
registerRecordingStorageIpc()
registerUpdaterIpc()
registerStartupIpc()
registerWindowSizingIpc()

function registerRecordingIpcHandlers(): void {
  ipcMain.on('renderer:debug-log', (_event, message: string, details?: unknown) => {
    logger().info('[renderer]', { message, details })
  })

  ipcMain.on('recording:ready', () => {
    handleRendererRecordingReady()
  })
  ipcMain.on('recording:started', () => {
    handleRendererRecordingStarted()
    updateTrayMenu()
  })
  ipcMain.on('recording:manual-started', (_event, recording) => {
    registerManualRecording(recording)
    updateTrayMenu()
  })
  ipcMain.on('recording:stopped', () => {
    handleRendererRecordingStopped()
    updateTrayMenu()
  })
  ipcMain.on('recording:error', (_event, message: string) => {
    handleRendererRecordingError(message)
    updateTrayMenu()
  })
  ipcMain.handle('recording:extend', () => extendAutoStop())
  ipcMain.on('recording:paused-changed', (_event, paused: boolean) => {
    setRecordingPaused(Boolean(paused))
    updateTrayMenu()
  })
}

registerRecordingIpcHandlers()

// IN-469: earliest known auto-record-eligible meeting start (UTC ms) for the
// update gate. Intentionally never reset to null — the graph runtime only
// invokes handleAutoRecordEligible when there ARE eligible decisions, and a
// stale past value is neutralised by the gate's bounded window (see
// AUTO_RECORD_GRACE_MS in update-gate.ts). The updater lifecycle consumes it
// via the `() => nextAutoRecordStartUtcMs` closure below.
let nextAutoRecordStartUtcMs: number | null = null

function showMainWindow(): void {
  const windows = BrowserWindow.getAllWindows()
  if (windows.length > 0) {
    windows[0].show()
    windows[0].focus()
  } else {
    createWindow()
  }
}

// IN-469: "Update {version} is ready." with Restart now / Later buttons.
// Same display pattern as the ending-soon toast in recording-ipc.ts.
function showUpdateReadyToast(version: string): void {
  if (!Notification?.isSupported?.()) return
  try {
    if (process.platform === 'win32') {
      new Notification({ toastXml: buildUpdateReadyToastXml(version) }).show()
      logger().info('[app] update-ready Windows toast requested', { version })
    } else {
      new Notification({
        title: 'Meeting Notetaker',
        body: `Update ${version} is ready.`,
        silent: true
      }).show()
      logger().info('[app] update-ready notification requested', { version })
    }
  } catch (err) {
    logger().warn('[app] could not show update-ready notification', {
      message: err instanceof Error ? err.message : String(err)
    })
  }
}

app.on('second-instance', (_event, argv) => {
  // Toast buttons arrive as notetaker:// protocol launches (IN-483 — the old
  // activationType="foreground" arguments were silently dropped by Windows
  // because Electron has no COM activation callback; legacy mn-* args are
  // still parsed for toasts shown by pre-fix app versions).
  const toastAction = toastActionFromArgv(argv)
  if (toastAction === 'extend') {
    // IN-124: extend in place without stealing focus to the window.
    logger().info('[app] extend requested from toast notification')
    extendActiveRecordingFromMain()
    return
  }
  if (toastAction === 'update-restart') {
    logger().info('[app] update restart requested from toast notification')
    restartNowRequested()
    return
  }
  if (toastAction === 'update-defer') {
    logger().info('[app] update deferred from toast notification')
    deferUpdate()
    return
  }
  if (argv.includes('--background') || argv.includes('--hidden')) {
    logger().info('[app] background second instance ignored')
    return
  }
  // toastAction === 'open' (toast body click) falls through to the window.
  showMainWindow()
})

app.whenReady().then(() => {
  // A losing second instance calls app.quit() at module scope, but quit is
  // asynchronous and 'ready' can still fire first — without this guard the
  // doomed instance briefly built a full window, tray, and backend supervisor
  // (observed as a window flash when a toast protocol launch raced the lock).
  if (!gotSingleInstanceLock) return
  electronApp.setAppUserModelId('com.factor1.notetaker')
  // IN-483: toast action buttons activate via the notetaker:// protocol.
  // The installer registers the scheme (electron-builder `protocols`); this
  // call self-heals the registration on packaged launches. Deliberately NOT
  // in dev: a bare registration there would point the system-wide scheme at
  // electron.exe without the app path — a broken handler that shadows the
  // installed app's.
  if (app.isPackaged && !app.setAsDefaultProtocolClient(TOAST_PROTOCOL_SCHEME)) {
    logger().warn('[app] could not register toast protocol scheme', {
      scheme: TOAST_PROTOCOL_SCHEME
    })
  }
  logger().info('[app] ready')
  ensureDefaultAutoLaunchEnabled()

  // IN-469: tray "Restart to update" delegates to the updater's gated path.
  setUpdateRestartHandler(() => restartNowRequested())

  startUpdaterLifecycle({
    getRecordingState: () => getRecordingStateMachine().getState(),
    hasPendingAutoStart,
    getNextAutoRecordStartUtcMs: () => nextAutoRecordStartUtcMs,
    getActor: getCurrentUser,
    onUpdateReady: (version) => {
      setUpdateReady(version)
      showUpdateReadyToast(version)
    }
  })
  registerMediaPermissions()

  function handleAutoRecordEligible(decisions: GraphEventDecision[]): void {
    const eligible = decisions.filter((d) => d.autoRecordEligible && d.status === 'candidate')

    // IN-469: track the earliest parseable start among this batch's eligible
    // candidates; keep the previous value when none parse.
    let earliestStartMs = Number.POSITIVE_INFINITY
    for (const decision of eligible) {
      if (decision.logContext.startUtc === undefined) continue
      const parsedStartMs = Date.parse(decision.logContext.startUtc)
      if (Number.isFinite(parsedStartMs)) {
        earliestStartMs = Math.min(earliestStartMs, parsedStartMs)
      }
    }
    if (Number.isFinite(earliestStartMs)) {
      nextAutoRecordStartUtcMs = earliestStartMs
    }

    for (const decision of eligible) {
      const gate = evaluateHostGate(decision, getCurrentUserEmail())
      if (!gate.allowed) {
        logger().info('[app] auto-record skipped by host-gate', {
          ...hostGateLogContext(gate),
          ...decision.logContext
        })
        setTraySkipped(decision.metadata?.title ?? null)
        continue
      }

      const key = decision.idempotencyKey ?? decision.eventId
      const sm = getRecordingStateMachine()
      if (!sm.canStartAutoRecording(key)) {
        logger().info('[app] auto-record skipped: already recorded or recording active', {
          idempotencyKey: key
        })
        continue
      }

      logger().info('[app] auto-record triggered', {
        idempotencyKey: key,
        startUtc: decision.logContext.startUtc,
        endUtc: decision.logContext.endUtc,
        ...decision.logContext
      })

      sendAutoStartRequest({
        eventId: decision.eventId,
        idempotencyKey: key,
        startTimeUtc: decision.logContext.startUtc ?? '',
        endTimeUtc: decision.logContext.endUtc ?? '',
        source: 'auto',
        metadata: decision.metadata
      })
    }
  }

  const graphRuntime = startGraphDetectionRuntime({
    statePath: join(app.getPath('userData'), 'graph', 'scheduler-state.json'),
    getAccessToken: getGraphAccessToken,
    getSignedInEmail: getCurrentUserEmail,
    logger: logger(),
    onAutoRecordEligible: handleAutoRecordEligible
  })

  onMsalSignedIn(() => {
    logger().info('[graph] sign-in completed; triggering immediate sync')
    void graphRuntime.syncNow().then((result) => {
      logger().info('[graph] post-sign-in sync finished', {
        status: result.status,
        decisions: result.decisions.length
      })
      if (result.status === 'success') graphRuntime.startPolling()
    })
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Trigger a sync when the system wakes from sleep.
  if (powerMonitor) {
    powerMonitor.on('resume', () => {
      logger().info('[app] system resumed from sleep')
      graphRuntime.scheduleResumeSync()
    })
    powerMonitor.on('unlock-screen', () => {
      logger().info('[app] screen unlocked')
      graphRuntime.scheduleResumeSync()
    })
  }

  createWindow({ showOnReady: !isBackgroundLaunch() })
  createTray(showMainWindow)

  // Packaged builds: spawn + supervise backend (dev uses external uvicorn).
  startBackendSupervisor().catch((err) => {
    logger().error('[app] backend supervisor failed to start', {
      message: err instanceof Error ? err.message : String(err)
    })
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// With a tray, closing all windows should not quit the app.
app.on('window-all-closed', () => {
  // Keep running in tray on all platforms.
})

app.on('before-quit', () => {
  cleanupRecordingIpc()
  stopBackendSupervisor()
  stopUpdaterTimers()
  destroyTray()
})
