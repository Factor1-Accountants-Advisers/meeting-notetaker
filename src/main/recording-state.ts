/**
 * Auto-recording state machine (IN-66).
 *
 * Owns the lifecycle of automated recording sessions triggered by Graph meeting
 * detection.
 */

export type RecordingState = 'idle' | 'recording' | 'processing'

export interface ActiveRecording {
  eventId: string
  idempotencyKey: string
  startTimeUtc: string
  endTimeUtc: string
  source: 'auto'
  metadata?: unknown
}

export interface RecordingStateMachine {
  getState(): RecordingState
  getActiveRecording(): ActiveRecording | null
  canStartAutoRecording(idempotencyKey: string): boolean
  startAutoRecording(recording: ActiveRecording): void
  stopRecording(): ActiveRecording | null
  completeProcessing(): void
}

export function createRecordingStateMachine(): RecordingStateMachine {
  let state: RecordingState = 'idle'
  let active: ActiveRecording | null = null
  const completedKeys = new Set<string>()

  return {
    getState: () => state,

    getActiveRecording: () => active,

    canStartAutoRecording(idempotencyKey: string): boolean {
      if (state !== 'idle') return false
      if (completedKeys.has(idempotencyKey)) return false
      if (active?.idempotencyKey === idempotencyKey) return false
      return true
    },

    startAutoRecording(recording: ActiveRecording): void {
      if (state !== 'idle') return
      recording.source = 'auto'
      active = recording
      state = 'recording'
    },

    stopRecording(): ActiveRecording | null {
      const finished = active
      if (!finished) return null
      completedKeys.add(finished.idempotencyKey)
      active = null
      state = 'processing'
      return finished
    },

    completeProcessing(): void {
      if (state === 'processing') {
        state = 'idle'
      }
    }
  }
}
