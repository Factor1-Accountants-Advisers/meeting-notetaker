import { BrowserWindow } from 'electron'
import { createRecordingStateMachine, type ActiveRecording, type RecordingStateMachine } from './recording-state'
import { logger } from './logger'

let mainWindow: BrowserWindow | null = null
let recordingSM: RecordingStateMachine | null = null
let autoStopTimer: ReturnType<typeof setTimeout> | null = null
let autoStartAckTimer: ReturnType<typeof setTimeout> | null = null
let autoStartAckTimeoutMs = 15_000
let pendingAutoStart: ActiveRecording | null = null
let rendererRecordingReady = false

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

  clearAutoStopTimer()

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
    sm.startAutoRecording(recording)
    scheduleAutoStop(recording)
  }
  logger().info('[recording] renderer confirmed recording started', {
    state: sm.getState()
  })
}

export function registerManualRecording(recording: ActiveRecording): void {
  clearAutoStartAckTimer()
  pendingAutoStart = null
  const sm = getRecordingStateMachine()
  sm.startManualRecording({ ...recording, source: 'manual' })
  logger().info('[recording] manual recording registered', {
    eventId: recording.eventId,
    idempotencyKey: recording.idempotencyKey
  })
}

export function handleRendererRecordingStopped(): void {
  clearAutoStopTimer()

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
  clearAutoStopTimer()
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
  clearAutoStopTimer()

  const endMs = new Date(recording.endTimeUtc).getTime()
  const delayMs = Math.max(0, endMs - Date.now())

  logger().info('[recording] scheduling auto-stop', {
    eventId: recording.eventId,
    delayMs,
    endTimeUtc: recording.endTimeUtc
  })

  autoStopTimer = setTimeout(() => {
    autoStopTimer = null
    logger().info('[recording] auto-stop timer fired', {
      eventId: recording.eventId
    })
    sendAutoStopRequest()
  }, delayMs)
}

function clearAutoStopTimer(): void {
  if (autoStopTimer) {
    clearTimeout(autoStopTimer)
    autoStopTimer = null
  }
}

export function cleanupRecordingIpc(): void {
  clearAutoStopTimer()
  clearAutoStartAckTimer()
  pendingAutoStart = null
  rendererRecordingReady = false
  mainWindow = null
  recordingSM = null
  autoStartAckTimeoutMs = 15_000
}
