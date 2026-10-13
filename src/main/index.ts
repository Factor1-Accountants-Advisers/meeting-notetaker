import { app, BrowserWindow, ipcMain, Notification, powerMonitor } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { join } from 'path'
import { registerApiProxyIpc } from './api-proxy'
import { getCurrentUser, getCurrentUserEmail, getGraphAccessToken, onMsalSignedIn, registerAuthSessionIpc } from './auth-session'
import { callSignalsManualResume, callSignalsToastAction, configureCallSignals } from './call-signals'
import { createCallWatchRegistrar } from './call-watch-registrar'
import { startGraphDetectionRuntime, refreshGraphCalendarAndResumePolling } from './graph/runtime'
import { loadPublicEnv } from './env'
import { evaluateHostGate, hostGateLogContext } from './graph/host-gate'
import { initLogger, logger } from './logger'
import { registerMediaPermissions } from './media-permissions'
import {
  cleanupRecordingIpc,
  closeRecordingPausedToast,
  configureCallWatchRegistrarHooks,
  configureJoinWatchHooks,
  extendActiveRecordingFromMain,
  extendAutoStop,
  getRecordingStateMachine,
  handleRendererRecordingError,
  handleRendererStopFailed,
  handleRendererRecordingNotReady,
  handleRendererRecordingReady,
  handleRendererRecordingStarted,
  handleRendererRecordingStopped,
  hasPendingAutoStart,
  isRendererRecordingReady,
  isRecordingPaused,
  playNotificationChime,
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
  parseToastArgv,
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
import { getBackendEnvLayers, startBackendSupervisor, stopBackendSupervisor } from './backend-supervisor'
import {
  configureJoinWatch,
  disposeJoinWatch,
  handleJoinWatchSyncDecisions,
  JOIN_WATCH_POLL_INTERVAL_MS,
  joinWatchPromptAccepted,
  joinWatchRecordingDiscarded,
  joinWatchRecordingStartFailed,
  joinWatchRecordingStarted,
  readAutoStartTrigger,
  type AutoStartTrigger
} from './join-watch'
import { createWindow, registerWindowSizingIpc } from './window'
import { AudioEndpointService, resolveAudioEndpointHelperPath } from './audio-endpoint-service'
import { disposeInviteePrompt, inviteePromptToastAnswered, registerInviteePromptIpc } from './invitee-prompt'
import {
  acceptTeamsCall,
  answerTeamsCallUncertainty,
  configureTeamsCallRuntime,
  disposeTeamsCallRuntime,
  invalidateTeamsCallTracking,
  observeTeamsCall,
  setTeamsCallCalendar,
  teamsCallObserverUnavailable,
  teamsCallRecordingPaused,
  teamsCallRecordingResumed,
  teamsCallRecordingStopped
} from './teams-call'
import { isPromptedTeamsCallRecording, readTeamsCallPromptEnabled, type PromptedTeamsCall, type TeamsCallObservation } from './teams-call-core'
import type { GraphEventDecision, GraphMeetingMetadata } from './graph/types'
import type { AudioEndpointSnapshot } from '../shared/audio-endpoints'

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
        onSnapshot: (snapshot: AudioEndpointSnapshot) => {
          for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send('audio-endpoints:changed', snapshot)
          }
        },
        // FD-97 is opt-in and the native worker owns the helper flag/protocol
        // details. This callback is evaluated from the same env layers as the
        // backend; no titles are logged or persisted here.
        observeTeams: () => readTeamsCallPromptEnabled(getBackendEnvLayers(), process.env),
        onTeamsCall: (observation: TeamsCallObservation) => observeTeamsCall(observation),
        onTeamsUnavailable: () => teamsCallObserverUnavailable(),
        log: logger()
      } as unknown as ConstructorParameters<typeof AudioEndpointService>[0])
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
registerInviteePromptIpc()
ipcMain.handle('audio-endpoints:get', () => audioEndpointService?.getSnapshot() ?? null)

let refreshTeamsCallCalendar: (() => void) | null = null

function registerRecordingIpcHandlers(): void {
  ipcMain.on('renderer:debug-log', (_event, message: string, details?: unknown) => {
    logger().info('[renderer]', { message, details })
  })

  ipcMain.on('recording:ready', () => {
    logger().info('[teams-call] renderer ready')
    handleRendererRecordingReady()
    refreshTeamsCallCalendar?.()
  })
  ipcMain.on('recording:not-ready', () => {
    logger().info('[teams-call] renderer not-ready; prompted-call tracking invalidated')
    handleRendererRecordingNotReady()
    invalidateTeamsCallTracking()
  })
  ipcMain.on('recording:started', () => {
    handleRendererRecordingStarted()
    updateTrayMenu()
  })
  ipcMain.on('recording:manual-started', (_event, recording) => {
    registerManualRecording(recording)
    updateTrayMenu()
  })
  ipcMain.on('recording:stopped', (_event, opts?: { discarded?: boolean }) => {
    handleRendererRecordingStopped(opts)
    teamsCallRecordingStopped()
    updateTrayMenu()
  })
  ipcMain.on('recording:stop-failed', (_event, message: string) => {
    handleRendererStopFailed(message)
  })
  ipcMain.on('recording:error', (_event, message: string) => {
    handleRendererRecordingError(message)
    teamsCallRecordingStopped()
    updateTrayMenu()
  })
  ipcMain.handle('recording:extend', () => extendAutoStop())
  ipcMain.on('recording:paused-changed', (_event, paused: boolean) => {
    const isPaused = Boolean(paused)
    setRecordingPaused(isPaused)
    if (isPaused) teamsCallRecordingPaused()
    else teamsCallRecordingResumed()
    // meeting-call-events (D6): a manual resume must reach the call-signal
    // machine after isRecordingPaused() already reflects it — the machine's
    // contract requires that ordering.
    if (!isPaused) callSignalsManualResume()
    updateTrayMenu()
  })
}

registerRecordingIpcHandlers()

const PROMPTED_CALL_MAX_DURATION_MS = 3 * 60 * 60_000

function promptedCallMetadata(call: PromptedTeamsCall): GraphMeetingMetadata {
  return {
    title: call.title,
    attendees: [],
    meetingId: call.nonce,
    promptedTeamsCall: {
      nonce: call.nonce,
      observedStartUtc: call.observedStartUtc
    }
  }
}

function startPromptedTeamsCall(call: PromptedTeamsCall): boolean {
  const startMs = Date.parse(call.observedStartUtc)
  const endMs = (Number.isFinite(startMs) ? startMs : Date.now()) + PROMPTED_CALL_MAX_DURATION_MS
  return sendAutoStartRequest({
    eventId: `teams-prompt-${call.nonce}`,
    idempotencyKey: `teams-prompt-${call.nonce}`,
    startTimeUtc: call.observedStartUtc,
    endTimeUtc: new Date(endMs).toISOString(),
    source: 'auto',
    trigger: 'prompt',
    metadata: promptedCallMetadata(call)
  })
}

function promptedTeamsCallEnded(call: PromptedTeamsCall, endedAtUtc: string): void {
  // Observation belongs to the consented call, not whichever capture happens
  // to be active now. Tray Stop may already have finished that recording.
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('recording:prompted-teams-call-ended', {
        eventId: 'teams-prompt-' + call.nonce,
        idempotencyKey: 'teams-prompt-' + call.nonce,
        nonce: call.nonce,
        endedAtUtc
      })
    }
  }
}

function stopPromptedTeamsCall(call: PromptedTeamsCall): void {
  if (!isPromptedTeamsCallRecording(call, getRecordingStateMachine().getActiveRecording())) return
  sendAutoStopRequest({ reason: 'call_ended' })
}

function controlPromptedTeamsCall(call: PromptedTeamsCall, action: 'pause' | 'resume'): void {
  if (!isPromptedTeamsCallRecording(call, getRecordingStateMachine().getActiveRecording())) return
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('recording:prompted-teams-control', { nonce: call.nonce, action })
    }
  }
  logger().info('[teams-call] prompted recording control requested', { action })
}

configureTeamsCallRuntime({
  enabled: false,
  isRecordingActive: () => getRecordingStateMachine().getState() !== 'idle' || hasPendingAutoStart(),
  isCurrentRecording: (call) => isPromptedTeamsCallRecording(call, getRecordingStateMachine().getActiveRecording()),
  isRecordingPaused,
  isReady: isRendererRecordingReady,
  start: startPromptedTeamsCall,
  observedEnd: promptedTeamsCallEnded,
  pause: (call) => controlPromptedTeamsCall(call, 'pause'),
  resume: (call) => controlPromptedTeamsCall(call, 'resume'),
  stop: stopPromptedTeamsCall,
  chime: playNotificationChime,
  log: logger()
})

// meeting-call-events (Task 13): register the real control surfaces once at
// startup, before any recording can arm the poller. Does not need a window —
// the actions it wires (sendTrayRecordingControl, sendAutoStopRequest) each
// guard a missing window on their own.
configureCallSignals({
  actions: {
    pause: () => sendTrayRecordingControl('pause'),
    resume: () => sendTrayRecordingControl('resume'),
    stop: (reason) => sendAutoStopRequest({ reason }),
    showPausedToast: showRecordingPausedToast,
    closePausedToast: closeRecordingPausedToast,
    isPaused: isRecordingPaused
  },
  // Join-trigger spec J5: the same 5s tick that drives the join watcher
  // carries over to the attach poller, so leave-detection tightens for free.
  pollIntervalMs: JOIN_WATCH_POLL_INTERVAL_MS
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
  const parsedToast = parseToastArgv(argv)
  const toastAction = parsedToast?.action ?? null
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
  if (toastAction === 'record-now') {
    // Join-trigger prompt (spec J3): start the prompted meeting in place,
    // without stealing focus (same rationale as extend/upload-now above).
    logger().info('[app] record-now requested from join prompt')
    joinWatchPromptAccepted()
    return
  }
  if (toastAction === 'teams-call-accept') {
    // FD-97: the nonce is part of the URI and is revalidated against the
    // current active connection before any capture request is sent.
    acceptTeamsCall(parsedToast?.callNonce)
    return
  }
  if (toastAction === 'teams-call-continue' || toastAction === 'teams-call-stop') {
    const accepted = answerTeamsCallUncertainty(
      parsedToast?.callNonce, parsedToast?.decisionNonce,
      toastAction === 'teams-call-continue' ? 'continue' : 'stop'
    )
    logger().info('[teams-call] uncertainty answer', { accepted, action: toastAction })
    return
  }
  if (toastAction === 'invitees-approve' || toastAction === 'invitees-decline') {
    // IN-488: answer the invitee prompt in place, without stealing focus (same
    // rationale as extend/upload-now above). The meeting id rides on the URI
    // because more than one prompt can be up; a click for a meeting whose
    // timer already fired is dropped by the engine as a stale click.
    const approved = toastAction === 'invitees-approve'
    logger().info('[app] invitee prompt answered from toast notification', { approved })
    if (parsedToast?.meetingId) inviteePromptToastAnswered(parsedToast.meetingId, approved)
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
  electronApp.setAppUserModelId(process.env.MN_DEV_INSTANCE === '1' ? 'com.factor1.notetaker.dev' : 'com.factor1.notetaker')
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

  // Auto-record trigger mode (spec J6): read from the supervisor's backend.env
  // layers once they are loaded (after `await backendStartup` below). Nothing
  // can reach handleAutoRecordEligible before then — the Graph runtime that
  // calls it starts after the await — so the placeholder is never observed.
  let autoStartTrigger: AutoStartTrigger = 'join'

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

      if (autoStartTrigger === 'join') {
        // Join-trigger mode (spec J1): the calendar only schedules. The join
        // watcher — fed by onSyncCompleted below — arms at start−3 and starts
        // on the recorder's roster IN. Nothing to start here. The host gate
        // above still runs in this mode so its tray hint and log line
        // (IN-77/IN-84 "Skipped: X (not host)") are kept.
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
        trigger: 'calendar',
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
  configureTeamsCallRuntime({
    enabled: readTeamsCallPromptEnabled(getBackendEnvLayers(), process.env),
    isRecordingActive: () => getRecordingStateMachine().getState() !== 'idle' || hasPendingAutoStart(),
    isCurrentRecording: (call) => isPromptedTeamsCallRecording(call, getRecordingStateMachine().getActiveRecording()),
    isRecordingPaused,
    isReady: isRendererRecordingReady,
    start: startPromptedTeamsCall,
    observedEnd: promptedTeamsCallEnded,
    pause: (call) => controlPromptedTeamsCall(call, 'pause'),
    resume: (call) => controlPromptedTeamsCall(call, 'resume'),
    stop: stopPromptedTeamsCall,
    chime: playNotificationChime,
    log: logger()
  })
  audioEndpointService?.start()
  // The two-layer backend.env is parsed by now (spawn and adoption paths both
  // populate it before backendStartup resolves) — PROGRAMDATA > bundled >
  // code default `join` (spec J6).
  autoStartTrigger = readAutoStartTrigger(getBackendEnvLayers(), process.env)
  logger().info('[app] auto-start trigger', { mode: autoStartTrigger })

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
    hasActiveWatch: (hash) => registrar.hasActiveWatch(hash)
  })

  // Join-triggered recording (spec J1–J3): built only in join mode — under
  // `calendar` the watcher is never constructed (J6). Same handover direction
  // as the registrar hooks: index.ts pushes the callbacks into recording-ipc.
  if (autoStartTrigger === 'join') {
    configureJoinWatch({ hasActiveWatch: (hash) => registrar.hasActiveWatch(hash) })
    configureJoinWatchHooks({
      onRecordingDiscarded: joinWatchRecordingDiscarded,
      onRecordingStarted: joinWatchRecordingStarted,
      onRecordingStartFailed: joinWatchRecordingStartFailed
    })
  }

  const graphRuntime = startGraphDetectionRuntime({
    statePath: join(app.getPath('userData'), 'graph', 'scheduler-state.json'),
    getAccessToken: getGraphAccessToken,
    getSignedInEmail: getCurrentUserEmail,
    logger: logger(),
    onAutoRecordEligible: handleAutoRecordEligible,
    // Same signed-in-email source as getSignedInEmail above. Reconciliation is
    // awaited by the Graph runtime so auto-record cannot inspect
    // hasActiveWatch while the discovery-time POST is still in flight.
    onSyncCompleted: async (decisions, meta) => {
      // FD-97 consumes the complete, unfiltered calendar decision feed,
      // including attendee/non-organizer decisions. The core fails closed
      // when this successful snapshot becomes stale.
      setTeamsCallCalendar(
        decisions.map((decision) => ({
          eventId: decision.eventId,
          isTeamsMeeting: decision.logContext.isOnlineMeeting || Boolean(decision.metadata.joinWebUrl),
          title: decision.metadata.title ?? '',
          startUtc: decision.logContext.startUtc,
          endUtc: decision.logContext.endUtc,
          status: decision.status,
          reason: decision.reason
        })),
        Date.now(),
        meta.fullSnapshot
      )
      try {
        await registrar.handleSyncDecisions(decisions, getCurrentUserEmail())
      } finally {
        // The join watcher consumes the same unfiltered feed AFTER the
        // registrar has reconciled, so its hasActiveWatch answers are current
        // (spec J1) — and it is fed even if reconciliation threw: the prompt
        // is the fail-closed path for exactly the meetings a watch never covers.
        // `meta` (full snapshot vs delta) gates its vanish-disarm; the
        // registrar's planner ignores it (absence is "unchanged" for it).
        if (autoStartTrigger === 'join') handleJoinWatchSyncDecisions(decisions, getCurrentUserEmail(), meta)
      }
    }
  })

  refreshTeamsCallCalendar = () => {
    if (!readTeamsCallPromptEnabled(getBackendEnvLayers(), process.env)) return
    void refreshGraphCalendarAndResumePolling(graphRuntime).catch((error) => {
      logger().warn('[teams-call] calendar refresh failed', {
        message: error instanceof Error ? error.message : String(error)
      })
    })
  }

  onMsalSignedIn(() => {
    invalidateTeamsCallTracking()
    logger().info('[graph] sign-in completed; triggering immediate sync')
    void graphRuntime.syncNow({ forceFullSnapshot: true }).then((result) => {
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
  // Join watcher: clear its timers and any visible prompt (no-op in calendar mode).
  disposeJoinWatch()
  disposeTeamsCallRuntime()
  // Invitee prompts: clear timers and toasts. Quitting decides nothing; an
  // unanswered meeting resurfaces as a card on the next launch.
  disposeInviteePrompt()
  // Flush any registrar state writes already in flight before shutdown.
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
