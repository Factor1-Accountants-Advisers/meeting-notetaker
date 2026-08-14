import { app, BrowserWindow, ipcMain, Notification, powerMonitor } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { join } from 'path'
import { registerApiProxyIpc } from './api-proxy'
import { getCurrentUser, getCurrentUserEmail, getGraphAccessToken, onMsalSignedIn, registerAuthSessionIpc } from './auth-session'
import { callSignalsManualResume, callSignalsToastAction, configureCallSignals } from './call-signals'
import { createCallWatchRegistrar } from './call-watch-registrar'
import { startGraphDetectionRuntime } from './graph/runtime'
import { loadPublicEnv } from './env'
import { evaluateHostGate, hostGateLogContext } from './graph/host-gate'
import { initLogger, logger } from './logger'
import { registerMediaPermissions } from './media-permissions'
import {
  cleanupRecordingIpc,
  closeRecordingPausedToast,
  configureCallWatchRegistrarHooks,
  extendActiveRecordingFromMain,
  extendAutoStop,
  getRecordingStateMachine,
  handleRendererRecordingError,
  handleRendererRecordingReady,
  handleRendererRecordingStarted,
  handleRendererRecordingStopped,
  hasPendingAutoStart,
  isRecordingPaused,
  registerManualRecording,
  sendAutoStartRequest,
  sendAutoStopRequest,
  sendTrayRecordingControl,
  setRecordingPaused,
  showRecordingPausedToast
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
import { AudioEndpointService, resolveAudioEndpointHelperPath } from './audio-endpoint-service'
import type { GraphEventDecision } from './graph/types'

loadPublicEnv()
initLogger()
const gotSingleInstanceLock = app.requestSingleInstanceLock()
// Windows-only: the helper observes Core Audio endpoints; other platforms
// (and dev before a cargo build, via the service's exists guard) run without.
const audioEndpointService =
  process.platform === 'win32'
    ? new AudioEndpointService({
        helperPath: resolveAudioEndpointHelperPath({
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          appPath: app.getAppPath()
        }),
        onSnapshot: (snapshot) => {
          for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send('audio-endpoints:changed', snapshot)
          }
        },
        log: logger()
      })
    : null

if (!gotSingleInstanceLock) {
  app.quit()
}

registerAuthSessionIpc()
registerApiProxyIpc()
registerRecordingStorageIpc()
registerUpdaterIpc()
registerStartupIpc()
registerWindowSizingIpc()
ipcMain.handle('audio-endpoints:get', () => audioEndpointService?.getSnapshot() ?? null)

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
    const isPaused = Boolean(paused)
    setRecordingPaused(isPaused)
    // meeting-call-events (D6): a manual resume must reach the call-signal
    // machine after isRecordingPaused() already reflects it — the machine's
    // contract requires that ordering.
    if (!isPaused) callSignalsManualResume()
    updateTrayMenu()
  })
}

registerRecordingIpcHandlers()

// meeting-call-events (Task 13): register the real control surfaces once at
// startup, before any recording can arm the poller. Does not need a window —
// the actions it wires (sendTrayRecordingControl, sendAutoStopRequest) each
// guard a missing window on their own.
configureCallSignals({
  actions: {
    pause: () => sendTrayRecordingControl('pause'),
    resume: () => sendTrayRecordingControl('resume'),
    stop: () => sendAutoStopRequest(),
    showPausedToast: showRecordingPausedToast,
    closePausedToast: closeRecordingPausedToast,
    isPaused: isRecordingPaused
  }
})

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
  if (toastAction === 'upload-now') {
    // meeting-call-events: route the paused-recording toast button to the
    // call-signal machine in place, without stealing focus (same rationale
    // as extend above).
    logger().info('[app] upload-now requested from toast notification')
    callSignalsToastAction('upload-now')
    return
  }
  if (toastAction === 'resume-recording') {
    // Same no-focus-steal rationale as extend/upload-now above.
    logger().info('[app] resume-recording requested from toast notification')
    callSignalsToastAction('resume-recording')
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

app.whenReady().then(async () => {
  // A losing second instance calls app.quit() at module scope, but quit is
  // asynchronous and 'ready' can still fire first — without this guard the
  // doomed instance briefly built a full window, tray, and backend supervisor
  // (observed as a window flash when a toast protocol launch raced the lock).
  if (!gotSingleInstanceLock) return
  electronApp.setAppUserModelId('com.factor1.notetaker')
  audioEndpointService?.start()
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
  // Start the packaged relay immediately, in parallel with the lightweight UI
  // setup below. Calendar/watch discovery awaits this promise before its first
  // sync; dev resolves immediately because it owns an external uvicorn.
  const backendStartup = startBackendSupervisor().catch((err) => {
    logger().error('[app] backend supervisor failed to start', {
      message: err instanceof Error ? err.message : String(err)
    })
  })
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

  // Show the UI while the packaged backend completes its health handshake.
  // Watch registration itself must not race that handshake (v2.0.26 field
  // failure), so only the meeting-automation startup below is gated.
  createWindow({ showOnReady: !isBackgroundLaunch() })
  createTray(showMainWindow)
  await backendStartup

  // Per-meeting call watches (call-watch-per-meeting spec): one registrar for
  // the app's lifetime, created before the graph runtime so even the startup
  // sync's decisions land on it. Its state file sits beside the graph
  // scheduler state under userData; the synchronous read at creation makes
  // hasActiveWatch truthful before the first sync completes.
  const registrar = createCallWatchRegistrar({
    statePath: join(app.getPath('userData'), 'call-watch-registrar.json')
  })
  callWatchRegistrar = registrar
  // Same handover direction as configureCallSignals above: index.ts pushes
  // the callbacks into recording-ipc so recording-ipc never imports us.
  configureCallWatchRegistrarHooks({
    hasActiveWatch: (hash) => registrar.hasActiveWatch(hash),
    noteWatchDeleted: (hash) => registrar.noteWatchDeleted(hash)
  })

  const graphRuntime = startGraphDetectionRuntime({
    statePath: join(app.getPath('userData'), 'graph', 'scheduler-state.json'),
    getAccessToken: getGraphAccessToken,
    getSignedInEmail: getCurrentUserEmail,
    logger: logger(),
    onAutoRecordEligible: handleAutoRecordEligible,
    // Same signed-in-email source as getSignedInEmail above. Reconciliation is
    // awaited by the Graph runtime so auto-record cannot inspect
    // hasActiveWatch while the discovery-time POST is still in flight.
    onSyncCompleted: (decisions) => registrar.handleSyncDecisions(decisions, getCurrentUserEmail())
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


  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// With a tray, closing all windows should not quit the app.
app.on('window-all-closed', () => {
  // Keep running in tray on all platforms.
})

// Module-level so before-quit can flush its pending state writes; assigned
// once inside whenReady (null until then, and flushState is null-safe there).
let callWatchRegistrar: ReturnType<typeof createCallWatchRegistrar> | null = null

let quitFailsafeArmed = false
app.on('before-quit', () => {
  cleanupRecordingIpc()
  // cleanupRecordingIpc's noteWatchDeleted persist is fire-and-forget; flush
  // the registrar's write chain so a quit right after a recording stop can't
  // lose it (stale hasActiveWatch on relaunch would attach to a deleted
  // watch — self-healing, but avoidable for one line).
  void callWatchRegistrar?.flushState()
  audioEndpointService?.stop()
  stopBackendSupervisor()
  stopUpdaterTimers()
  destroyTray()

  // Teardown-hang failsafe. Observed live 10 Aug 2026 (v2.0.21): tray-Quit ran
  // this handler to completion (backend killed, tray gone, windows gone) but
  // the main process never terminated — still alive 15 minutes later — leaving
  // a zombie that holds the single-instance lock and blocks the next launch.
  // Root cause unidentified (suspect a native-module thread refusing to join);
  // until it is, a hung teardown gets 8s and is then forced out. Normal quits
  // exit well before the timer fires, so this is inert on the happy path.
  // Safe with quitAndInstall: electron-updater spawns the installer as a
  // separate process before quitting, so a forced exit cannot interrupt it.
  if (!quitFailsafeArmed) {
    quitFailsafeArmed = true
    setTimeout(() => {
      try {
        logger().warn('[app] teardown hung after quit — forcing exit')
      } catch {
        // logging is best-effort on the way out
      }
      process.exit(0)
    }, 8_000)
  }
})
