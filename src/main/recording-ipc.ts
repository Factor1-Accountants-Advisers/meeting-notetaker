import { BrowserWindow } from 'electron'
import { createRecordingStateMachine, type ActiveRecording, type RecordingStateMachine } from './recording-state'
import { logger } from './logger'

let mainWindow: BrowserWindow | null = null
let recordingSM: RecordingStateMachine | null = null
let autoStopTimer: ReturnType<typeof setTimeout> | null = null

export function getRecordingStateMachine(): RecordingStateMachine {
  if (!recordingSM) recordingSM = createRecordingStateMachine()
  return recordingSM
}

export function setMainWindow(window: BrowserWindow): void {
  mainWindow = window
}

export function sendAutoStartRequest(recording: ActiveRecording): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    logger().warn('[recording] cannot send auto-start: no main window')
    return
  }

  const sm = getRecordingStateMachine()
  if (!sm.canStartAutoRecording(recording.idempotencyKey)) {
    logger().info('[recording] auto-start skipped', {
      reason: 'state machine rejected',
      recordingKey: recording.idempotencyKey
    })
    return
  }

  sm.startAutoRecording(recording)

  logger().info('[recording] sending auto-start to renderer', {
    eventId: recording.eventId,
    idempotencyKey: recording.idempotencyKey,
    startTimeUtc: recording.startTimeUtc,
    endTimeUtc: recording.endTimeUtc
  })

  mainWindow.webContents.send('recording:auto-start-request', {
    eventId: recording.eventId,
    idempotencyKey: recording.idempotencyKey,
    startTimeUtc: recording.startTimeUtc,
    endTimeUtc: recording.endTimeUtc,
    source: recording.source,
    metadata: recording.metadata
  })

  scheduleAutoStop(recording)
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

export function handleRendererRecordingStarted(): void {
  const sm = getRecordingStateMachine()
  logger().info('[recording] renderer confirmed recording started', {
    state: sm.getState()
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

  const sm = getRecordingStateMachine()
  sm.stopRecording()
  sm.completeProcessing()

  logger().warn('[recording] renderer reported error', { message })
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
  mainWindow = null
  recordingSM = null
}
