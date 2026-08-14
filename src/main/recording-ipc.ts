import { BrowserWindow, Notification, powerSaveBlocker } from 'electron'
import { createRecordingStateMachine, type ActiveRecording, type RecordingStateMachine } from './recording-state'
import { logger } from './logger'
import { buildEndingSoonToastXml, buildRecordingPausedToastXml } from './toast-xml'
import { armCallSignals, disarmCallSignals, joinUrlHash, readJoinWebUrl } from './call-signals'

// IN-129: while recording, hold the system awake so an idle timeout can't
// sleep the machine mid-meeting. (Lid-close sleep is OS power policy and
// cannot be blocked from Electron — the chunk spill covers that case.)
let sleepBlockerId: number | null = null

function blockSleepWhileRecording(): void {
  if (sleepBlockerId !== null && powerSaveBlocker.isStarted(sleepBlockerId)) return
  try {
    sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension')
    logger().info('[recording] sleep blocker started', { id: sleepBlockerId })
  } catch (err) {
    // powerSaveBlocker is undefined outside Electron (verify:graph harness).
    logger().warn('[recording] sleep blocker unavailable', {
      message: err instanceof Error ? err.message : String(err)
    })
  }
}

function unblockSleep(): void {
  if (sleepBlockerId === null) return
  try {
    if (powerSaveBlocker.isStarted(sleepBlockerId)) powerSaveBlocker.stop(sleepBlockerId)
    logger().info('[recording] sleep blocker stopped', { id: sleepBlockerId })
  } catch {
    // Same non-Electron guard as above.
  }
  sleepBlockerId = null
}

export function meetingTitleFrom(metadata: unknown): string | null {
  if (metadata && typeof metadata === 'object' && 'title' in metadata) {
    const title = (metadata as { title?: unknown }).title
    if (typeof title === 'string' && title.trim()) return title.trim()
  }
  return null
}

/** Toast the user that auto-recording began (Jira IN-83). */
function notifyAutoRecordingStarted(recording: ActiveRecording): void {
  // Notification is undefined outside the Electron runtime (e.g. the
  // esbuild-bundled verify:graph harness runs under plain Node).
  if (!Notification?.isSupported?.()) return
  const title = meetingTitleFrom(recording.metadata)
  try {
    // Silent: the renderer plays the Notetaker chime instead (IN-477).
    new Notification({
      title: 'Meeting Notetaker',
      body: title ? `Recording: ${title}` : 'Auto-recording started',
      silent: true
    }).show()
    playNotificationChime()
  } catch (err) {
    logger().warn('[recording] could not show auto-record notification', {
      message: err instanceof Error ? err.message : String(err)
    })
  }
}

/**
 * Cue the renderer to play the bundled notification chime (IN-477). OS toasts
 * are shown silent because toast XML cannot reference a bundled audio file in
 * an unpackaged win32 app; the renderer owns the wav asset instead. The main
 * window hides to the tray but is never destroyed, so the cue normally lands —
 * if the window is gone the toast still shows, only the chime is lost.
 */
function playNotificationChime(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('notification:chime')
}

// Per-meeting call watches (Task 10): hooks into the calendar-driven watch
// registrar, injected by index.ts at startup — the same direction as the rest
// of this module's wiring (index.ts imports us, never the reverse). Until
// they are configured, arming falls back to register mode and disarm skips
// the bookkeeping — exactly the pre-registrar behaviour.
export interface CallWatchRegistrarHooks {
  /** `CallWatchRegistrar.hasActiveWatch` — attach-mode pick (spec E5). */
  hasActiveWatch: (joinUrlHash: string) => boolean
  /** `CallWatchRegistrar.noteWatchDeleted` — free the slot after the poller
   *  deletes the watch on recording stop. */
  noteWatchDeleted: (joinUrlHash: string) => void
}

let registrarHooks: CallWatchRegistrarHooks | null = null

/** Called once from index.ts at startup, next to `configureCallSignals`.
 *  Passing `null` clears the hooks (test/teardown seam). */
export function configureCallWatchRegistrarHooks(hooks: CallWatchRegistrarHooks | null): void {
  registrarHooks = hooks
}

let mainWindow: BrowserWindow | null = null
let recordingSM: RecordingStateMachine | null = null
let autoStopTimer: ReturnType<typeof setTimeout> | null = null
let autoStopReminderTimer: ReturnType<typeof setTimeout> | null = null
let reminderNotifiedForEndMs: number | null = null
let autoStopEndMs: number | null = null
let autoStartAckTimer: ReturnType<typeof setTimeout> | null = null
let autoStartAckTimeoutMs = 15_000
let pendingAutoStart: ActiveRecording | null = null
let rendererRecordingReady = false
// Renderer-owned pause state mirrored for the active tray label (IN-120).
let recordingPaused = false

export function isRecordingPaused(): boolean {
  return recordingPaused
}

// IN-469: read-only view of the auto-start handoff for the update gate — an
// auto-start handed to the renderer (unacked or active) must block installs.
export function hasPendingAutoStart(): boolean {
  return pendingAutoStart !== null
}

export function setRecordingPaused(paused: boolean): void {
  recordingPaused = paused
}

/** Forward a tray command to the renderer that owns media capture. */
export function sendTrayRecordingControl(action: 'pause' | 'resume' | 'stop'): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    logger().warn('[recording] cannot send tray control: no main window', { action })
    return
  }
  logger().info('[recording] tray recording control', { action })
  mainWindow.webContents.send('recording:tray-control', { action })
}

// IN-117: manual recording extension.
const EXTEND_INCREMENT_MS = 10 * 60_000
const END_REMINDER_LEAD_MS = 5 * 60_000

export type EndReminderPlan =
  | { kind: 'scheduled'; delayMs: number }
  | { kind: 'immediate' }
  | { kind: 'skip'; reason: 'ended' | 'invalid_end' }

/** Determine how the one-time ending reminder should be delivered. */
export function getEndReminderPlan(endMs: number, nowMs: number = Date.now()): EndReminderPlan {
  if (!Number.isFinite(endMs)) return { kind: 'skip', reason: 'invalid_end' }
  const remainingMs = endMs - nowMs
  if (remainingMs <= 0) return { kind: 'skip', reason: 'ended' }
  if (remainingMs <= END_REMINDER_LEAD_MS) return { kind: 'immediate' }
  return { kind: 'scheduled', delayMs: remainingMs - END_REMINDER_LEAD_MS }
}

export function getRecordingStateMachine(): RecordingStateMachine {
  if (!recordingSM) recordingSM = createRecordingStateMachine()
  return recordingSM
}

export function setMainWindow(window: BrowserWindow | null): void {
  mainWindow = window
  if (!window) rendererRecordingReady = false
}

export function setAutoStartAckTimeoutMsForTest(timeoutMs: number): void {
  autoStartAckTimeoutMs = timeoutMs
}

export function sendAutoStartRequest(recording: ActiveRecording): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    logger().warn('[recording] cannot send auto-start: no main window')
    return
  }

  const sm = getRecordingStateMachine()
  if (pendingAutoStart) {
    logger().info('[recording] auto-start skipped', {
      reason: 'pending auto-start awaiting renderer ack',
      recordingKey: recording.idempotencyKey,
      pendingKey: pendingAutoStart.idempotencyKey
    })
    return
  }
  if (!sm.canStartAutoRecording(recording.idempotencyKey)) {
    logger().info('[recording] auto-start skipped', {
      reason: 'state machine rejected',
      recordingKey: recording.idempotencyKey
    })
    return
  }

  pendingAutoStart = { ...recording, source: 'auto' }
  if (!rendererRecordingReady) {
    logger().info('[recording] auto-start pending until renderer is ready', {
      eventId: recording.eventId,
      idempotencyKey: recording.idempotencyKey
    })
    return
  }
  sendPendingAutoStart('sending auto-start to renderer')
  scheduleAutoStartAckTimeout()
}

export function sendAutoStopRequest(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    logger().warn('[recording] cannot send auto-stop: no main window')
    return
  }

  const sm = getRecordingStateMachine()
  const active = sm.getActiveRecording()
  if (!active) {
    logger().info('[recording] auto-stop skipped: no active recording')
    return
  }

  resetAutoStopState()

  logger().info('[recording] sending auto-stop to renderer', {
    eventId: active.eventId,
    idempotencyKey: active.idempotencyKey
  })

  mainWindow.webContents.send('recording:auto-stop-request', {
    eventId: active.eventId,
    idempotencyKey: active.idempotencyKey
  })
}

export function handleRendererRecordingReady(): void {
  rendererRecordingReady = true
  if (!pendingAutoStart) return
  sendPendingAutoStart('sending pending auto-start to ready renderer')
  scheduleAutoStartAckTimeout()
}

export function handleRendererRecordingStarted(): void {
  const sm = getRecordingStateMachine()
  if (pendingAutoStart) {
    const recording = pendingAutoStart
    pendingAutoStart = null
    clearAutoStartAckTimer()
    recordingPaused = false
    sm.startAutoRecording(recording)
    blockSleepWhileRecording()
    scheduleAutoStop(recording)
    // Attach-aware arm (spec E5): when the registrar already parked a watch
    // for this meeting at calendar discovery, the poller attaches to it and
    // baseline-drains instead of registering. Deps stay at the configured
    // default (`undefined` selects it).
    armCallSignals(recording, undefined, (hash) => registrarHooks?.hasActiveWatch(hash) ?? false)
    notifyAutoRecordingStarted(recording)
  }
  logger().info('[recording] renderer confirmed recording started', {
    state: sm.getState()
  })
}

export function registerManualRecording(recording: ActiveRecording & { title?: string }): void {
  clearAutoStartAckTimer()
  pendingAutoStart = null
  recordingPaused = false
  const sm = getRecordingStateMachine()
  if (sm.getState() !== 'idle') {
    logger().warn('[recording] manual recording ignored: another recording is active', {
      idempotencyKey: recording.idempotencyKey
    })
    return
  }
  sm.startManualRecording({
    ...recording,
    source: 'manual',
    metadata: recording.title ? { title: recording.title } : recording.metadata
  })
  blockSleepWhileRecording()
  logger().info('[recording] manual recording registered', {
    eventId: recording.eventId,
    idempotencyKey: recording.idempotencyKey
  })
}

export function handleRendererRecordingStopped(): void {
  closePausedToastAndDisarm(activeRecordingJoinWebUrl())

  recordingPaused = false
  resetAutoStopState()
  unblockSleep()

  const sm = getRecordingStateMachine()
  const finished = sm.stopRecording()
  if (finished) {
    logger().info('[recording] recording finished', {
      eventId: finished.eventId,
      idempotencyKey: finished.idempotencyKey
    })
  }

  // Transition back to idle after processing
  sm.completeProcessing()
}

export function handleRendererRecordingError(message: string): void {
  closePausedToastAndDisarm(activeRecordingJoinWebUrl())

  recordingPaused = false
  resetAutoStopState()
  unblockSleep()
  clearAutoStartAckTimer()
  pendingAutoStart = null

  const sm = getRecordingStateMachine()
  sm.stopRecording()
  sm.completeProcessing()

  logger().warn('[recording] renderer reported error', { message })
}

function sendPendingAutoStart(logMessage: string): void {
  if (!pendingAutoStart) return
  if (!mainWindow || mainWindow.isDestroyed()) {
    logger().warn('[recording] cannot send pending auto-start: no main window')
    return
  }

  logger().info(`[recording] ${logMessage}`, {
    eventId: pendingAutoStart.eventId,
    idempotencyKey: pendingAutoStart.idempotencyKey,
    startTimeUtc: pendingAutoStart.startTimeUtc,
    endTimeUtc: pendingAutoStart.endTimeUtc
  })

  mainWindow.webContents.send('recording:auto-start-request', {
    eventId: pendingAutoStart.eventId,
    idempotencyKey: pendingAutoStart.idempotencyKey,
    startTimeUtc: pendingAutoStart.startTimeUtc,
    endTimeUtc: pendingAutoStart.endTimeUtc,
    source: pendingAutoStart.source,
    metadata: pendingAutoStart.metadata
  })
}

function scheduleAutoStartAckTimeout(): void {
  clearAutoStartAckTimer()
  if (!pendingAutoStart) return
  const pending = pendingAutoStart
  autoStartAckTimer = setTimeout(() => {
    if (pendingAutoStart?.idempotencyKey !== pending.idempotencyKey) return
    logger().warn('[recording] auto-start ack timeout; returning to idle', {
      eventId: pending.eventId,
      idempotencyKey: pending.idempotencyKey,
      timeoutMs: autoStartAckTimeoutMs
    })
    pendingAutoStart = null
    autoStartAckTimer = null
  }, autoStartAckTimeoutMs)
}

function clearAutoStartAckTimer(): void {
  if (autoStartAckTimer) {
    clearTimeout(autoStartAckTimer)
    autoStartAckTimer = null
  }
}

function scheduleAutoStop(recording: ActiveRecording): void {
  autoStopEndMs = new Date(recording.endTimeUtc).getTime()
  rescheduleAutoStopTimers(recording)
}

/** (Re)arm the auto-stop and 5-min-before reminder timers to `autoStopEndMs`. */
function rescheduleAutoStopTimers(recording: ActiveRecording): void {
  clearAutoStopTimer()
  clearAutoStopReminder()
  if (autoStopEndMs === null) return

  const delayMs = Math.max(0, autoStopEndMs - Date.now())
  logger().info('[recording] scheduling auto-stop', {
    eventId: recording.eventId,
    delayMs,
    endTimeUtc: new Date(autoStopEndMs).toISOString()
  })
  autoStopTimer = setTimeout(() => {
    autoStopTimer = null
    logger().info('[recording] auto-stop timer fired', { eventId: recording.eventId })
    sendAutoStopRequest()
  }, delayMs)

  const reminderPlan = getEndReminderPlan(autoStopEndMs)
  if (reminderPlan.kind === 'scheduled') {
    const plannedEndMs = autoStopEndMs
    logger().info('[recording] scheduling ending-soon reminder', {
      eventId: recording.eventId,
      delayMs: reminderPlan.delayMs,
      endTimeUtc: new Date(plannedEndMs).toISOString()
    })
    autoStopReminderTimer = setTimeout(() => {
      autoStopReminderTimer = null
      if (autoStopEndMs !== plannedEndMs) {
        logger().info('[recording] ending-soon reminder ignored after reschedule', { eventId: recording.eventId })
        return
      }
      sendEndingSoonReminder(recording, plannedEndMs, 'timer')
    }, reminderPlan.delayMs)
  } else if (reminderPlan.kind === 'immediate') {
    logger().info('[recording] sending ending-soon reminder immediately', {
      eventId: recording.eventId,
      endTimeUtc: new Date(autoStopEndMs).toISOString()
    })
    sendEndingSoonReminder(recording, autoStopEndMs, 'immediate')
  } else {
    logger().info('[recording] ending-soon reminder skipped', {
      eventId: recording.eventId,
      reason: reminderPlan.reason
    })
  }
}

/**
 * Push the scheduled auto-stop out by one increment (IN-117). Returns the new
 * end time, or null if there is no active auto-recording to extend.
 */
export function extendAutoStop(incrementMs: number = EXTEND_INCREMENT_MS): { endTimeUtc: string } | null {
  const sm = getRecordingStateMachine()
  const active = sm.getActiveRecording()
  if (!active || autoStopEndMs === null) {
    logger().info('[recording] extend ignored: no active auto-recording')
    return null
  }
  // Extend from the later of (scheduled end, now) so a press near the wire
  // always buys a full increment of usable recording time.
  autoStopEndMs = Math.max(autoStopEndMs, Date.now()) + incrementMs
  rescheduleAutoStopTimers(active)
  const endTimeUtc = new Date(autoStopEndMs).toISOString()
  logger().info('[recording] recording extended', {
    eventId: active.eventId,
    incrementMs,
    endTimeUtc
  })
  return { endTimeUtc }
}

function sendEndingSoonReminder(
  recording: ActiveRecording,
  scheduledEndMs: number,
  trigger: 'timer' | 'immediate'
): void {
  if (reminderNotifiedForEndMs === scheduledEndMs) {
    logger().info('[recording] ending-soon reminder skipped: already sent for scheduled end', {
      eventId: recording.eventId,
      trigger
    })
    return
  }
  reminderNotifiedForEndMs = scheduledEndMs
  logger().info('[recording] showing ending-soon reminder', {
    eventId: recording.eventId,
    trigger,
    endTimeUtc: new Date(scheduledEndMs).toISOString()
  })
  notifyMeetingEndingSoon(recording)
}

function notifyMeetingEndingSoon(recording: ActiveRecording): void {
  if (!Notification?.isSupported?.()) {
    logger().warn('[recording] ending-soon notification unsupported by Electron')
    return
  }
  const title = meetingTitleFrom(recording.metadata)
  const body = title
    ? `"${title}" is scheduled to end in 5 minutes.`
    : 'Recording is scheduled to end in 5 minutes.'
  try {
    if (process.platform === 'win32') {
      // Sticky reminder toast with Extend/Dismiss buttons (IN-124, IN-477).
      // The Extend button activates the app with `mn-extend`, handled by the
      // single-instance hook in index.ts.
      new Notification({ toastXml: buildEndingSoonToastXml(body) }).show()
      logger().info('[recording] ending-soon Windows toast requested')
    } else {
      // Silent: the renderer plays the Notetaker chime instead (IN-477).
      new Notification({ title: 'Meeting Notetaker', body, silent: true }).show()
      logger().info('[recording] ending-soon notification requested')
    }
    playNotificationChime()
  } catch (err) {
    logger().warn('[recording] could not show ending-soon notification', {
      message: err instanceof Error ? err.message : String(err)
    })
  }
}

// Kept module-level so closeRecordingPausedToast() can .close() the toast the
// call-signal machine asked us to show (call-signals.ts's disarmCallSignals
// doc comment, obligation 1: a visible toast must be closed before disarm).
let pausedToastNotification: Notification | null = null

/**
 * "Recording paused — you left the meeting" toast (meeting-call-events,
 * Task 13). Driven by the call-signal machine's `showPausedToast` action, not
 * called directly elsewhere. Same win32-toast / other-platforms-notification
 * split as notifyMeetingEndingSoon; unlike that one, the instance is kept so
 * closeRecordingPausedToast() can dismiss it early.
 */
export function showRecordingPausedToast(): void {
  if (!Notification?.isSupported?.()) {
    logger().warn('[recording] paused-toast notification unsupported by Electron')
    return
  }
  // Clear/replace any toast already on screen before showing the new one.
  closeRecordingPausedToast()
  const body = 'Looks like you left the meeting — recording paused. Upload now, or keep recording?'
  try {
    if (process.platform === 'win32') {
      // Sticky reminder toast with Upload now/Keep recording buttons, same
      // protocol-activation convention as the ending-soon toast above.
      pausedToastNotification = new Notification({ toastXml: buildRecordingPausedToastXml(body) })
      logger().info('[recording] paused Windows toast requested')
    } else {
      // Silent: the renderer plays the Notetaker chime instead (IN-477).
      pausedToastNotification = new Notification({ title: 'Meeting Notetaker', body, silent: true })
      logger().info('[recording] paused notification requested')
    }
    pausedToastNotification.show()
    playNotificationChime()
  } catch (err) {
    pausedToastNotification = null
    logger().warn('[recording] could not show paused-recording notification', {
      message: err instanceof Error ? err.message : String(err)
    })
  }
}

/** Close the paused-recording toast if one is showing. Safe to call when none
 *  is showing — the call-signal machine closes defensively on every terminal
 *  transition, and this is the disarm-path guard too. */
export function closeRecordingPausedToast(): void {
  if (!pausedToastNotification) return
  const notification = pausedToastNotification
  pausedToastNotification = null
  try {
    notification.close()
  } catch (err) {
    logger().warn('[recording] could not close paused-recording notification', {
      message: err instanceof Error ? err.message : String(err)
    })
  }
}

/**
 * Close a visible paused toast, then disarm the call-signal poller. Every
 * recording-teardown path (stopped, error, cleanup) shares this exact
 * ordering: call-signals.ts's disarmCallSignals doc comment requires the
 * toast closed FIRST, because `dispose()` fires no actions and a sticky
 * toast would otherwise outlive the recording — and disarming is never the
 * stop itself (this module's own teardown in each caller is the real stop
 * path). closeRecordingPausedToast() is already a safe no-op when nothing is
 * showing, so callers need no visibility check of their own.
 *
 * `joinWebUrl` (Task 10): the recording's join URL, when the caller still has
 * the recording in scope — callers pass `activeRecordingJoinWebUrl()` BEFORE
 * tearing the state machine down. Disarm best-effort deletes the watch for
 * any non-idle poller, so the registrar is told its tracked entry is gone.
 * Deliberately unconditional whenever a join URL exists: if the poller never
 * actually deleted (arm declined, or the poller was still idle), the stale
 * noteWatchDeleted only drops a client-side entry for a watch the server
 * still holds — the next calendar sync re-registers it, which the server
 * treats as replace-in-place (spec E2). Benign, and far simpler than
 * mirroring the poller's internal state out here.
 */
function closePausedToastAndDisarm(joinWebUrl?: string | null): void {
  closeRecordingPausedToast()
  disarmCallSignals()
  if (joinWebUrl) registrarHooks?.noteWatchDeleted(joinUrlHash(joinWebUrl))
}

/** Join URL of the recording currently held by the state machine, if any.
 *  Reads `recordingSM` directly (not the lazy getter) so the cleanup path
 *  never resurrects a machine just to ask it. */
function activeRecordingJoinWebUrl(): string | null {
  const active = recordingSM?.getActiveRecording()
  return active ? readJoinWebUrl(active.metadata) : null
}

/** True while an auto-recording with a scheduled end is active (extendable). */
export function hasExtendableRecording(): boolean {
  return getRecordingStateMachine().getState() === 'recording' && autoStopEndMs !== null
}

/**
 * Extend the active recording from a main-process trigger (tray menu or toast
 * button) and push the new end time to the renderer so its countdown updates.
 */
export function extendActiveRecordingFromMain(): void {
  const result = extendAutoStop()
  if (result && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('recording:end-extended', result)
  }
}

function clearAutoStopTimer(): void {
  if (autoStopTimer) {
    clearTimeout(autoStopTimer)
    autoStopTimer = null
  }
}

function clearAutoStopReminder(): void {
  if (autoStopReminderTimer) {
    clearTimeout(autoStopReminderTimer)
    autoStopReminderTimer = null
  }
}

/** Tear down all auto-stop scheduling — used at every terminal transition. */
function resetAutoStopState(): void {
  clearAutoStopTimer()
  clearAutoStopReminder()
  reminderNotifiedForEndMs = null
  autoStopEndMs = null
}

export function cleanupRecordingIpc(): void {
  closePausedToastAndDisarm(activeRecordingJoinWebUrl())
  resetAutoStopState()
  unblockSleep()
  clearAutoStartAckTimer()
  pendingAutoStart = null
  rendererRecordingReady = false
  mainWindow = null
  recordingSM = null
  autoStartAckTimeoutMs = 15_000
}
