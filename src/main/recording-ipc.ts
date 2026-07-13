import { BrowserWindow, Notification, powerSaveBlocker } from 'electron'
import { createRecordingStateMachine, type ActiveRecording, type RecordingStateMachine } from './recording-state'
import { logger } from './logger'

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
    new Notification({
      title: 'Meeting Notetaker',
      body: title ? `Recording: ${title}` : 'Auto-recording started'
    }).show()
  } catch (err) {
    logger().warn('[recording] could not show auto-record notification', {
      message: err instanceof Error ? err.message : String(err)
    })
  }
}

let mainWindow: BrowserWindow | null = null
let recordingSM: RecordingStateMachine | null = null
let autoStopTimer: ReturnType<typeof setTimeout> | null = null
let autoStopReminderTimer: ReturnType<typeof setTimeout> | null = null
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
    notifyAutoRecordingStarted(recording)
  }
  logger().info('[recording] renderer confirmed recording started', {
    state: sm.getState()
  })
}

export function handleRendererRecordingStopped(): void {
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

  // Bonus (IN-117): remind the user 5 minutes before the scheduled end.
  const reminderDelay = autoStopEndMs - END_REMINDER_LEAD_MS - Date.now()
  if (reminderDelay > 0) {
    autoStopReminderTimer = setTimeout(() => {
      autoStopReminderTimer = null
      notifyMeetingEndingSoon(recording)
    }, reminderDelay)
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

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function notifyMeetingEndingSoon(recording: ActiveRecording): void {
  if (!Notification?.isSupported?.()) return
  const title = meetingTitleFrom(recording.metadata)
  const body = title
    ? `"${title}" is scheduled to end in 5 minutes.`
    : 'Recording is scheduled to end in 5 minutes.'
  try {
    if (process.platform === 'win32') {
      // Windows ignores the cross-platform `actions` array (macOS-only), so an
      // Extend button requires raw toast XML. The button activates the app with
      // `mn-extend`, handled by the single-instance hook in index.ts.
      const toastXml =
        '<toast activationType="foreground" launch="mn-open">' +
        '<visual><binding template="ToastGeneric">' +
        '<text>Meeting Notetaker</text>' +
        `<text>${xmlEscape(body)}</text>` +
        '</binding></visual>' +
        '<actions>' +
        '<action content="Extend 10 min" activationType="foreground" arguments="mn-extend"/>' +
        '</actions>' +
        '</toast>'
      new Notification({ toastXml }).show()
    } else {
      new Notification({ title: 'Meeting Notetaker', body }).show()
    }
  } catch (err) {
    logger().warn('[recording] could not show ending-soon notification', {
      message: err instanceof Error ? err.message : String(err)
    })
  }
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
  autoStopEndMs = null
}

export function cleanupRecordingIpc(): void {
  resetAutoStopState()
  unblockSleep()
  clearAutoStartAckTimer()
  pendingAutoStart = null
  rendererRecordingReady = false
  mainWindow = null
  recordingSM = null
  autoStartAckTimeoutMs = 15_000
}
