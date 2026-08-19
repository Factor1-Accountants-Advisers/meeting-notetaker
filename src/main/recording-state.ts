/**
 * Auto-recording state machine (IN-66).
 *
 * Owns the lifecycle of automated recording sessions triggered by Graph meeting
 * detection. Manual recordings are tracked through the same lifecycle so tray
 * controls and Graph-start arbitration remain consistent.
 */

export type RecordingState = 'idle' | 'recording' | 'processing'

export interface ActiveRecording {
  eventId: string
  idempotencyKey: string
  startTimeUtc: string
  endTimeUtc: string
  source: 'auto' | 'manual'
  /** What started it (join-trigger spec): the recorder's join signal, the
   *  prompt's Record now, or the legacy calendar timer. Absent for manual.
   *  Mirrors `RecordingTrigger` in join-watch-core.ts (kept inline so this
   *  module stays dependency-free). */
  trigger?: 'join' | 'prompt' | 'calendar'
  /** Set when the renderer acks the start; feeds the false-start rule (J4). */
  startedAtUtc?: string
  /** Last call-watch signal seq the join watcher had seen when it started
   *  this recording; the attach poller drains only up to it and acts on
   *  anything later (spec J5/E5). Absent for calendar/manual/prompt-without-
   *  watch starts, where the poller drains everything as before. */
  callSignalBaselineSeq?: string
  metadata?: unknown
}

export interface RecordingStateMachine {
  getState(): RecordingState
  getActiveRecording(): ActiveRecording | null
  canStartAutoRecording(idempotencyKey: string): boolean
  startAutoRecording(recording: ActiveRecording): void
  startManualRecording(recording: ActiveRecording): void
  stopRecording(): ActiveRecording | null
  completeProcessing(): void
  /** Drop a completed key so the meeting can auto-record again — a discarded
   *  join-trigger false start (spec J4). No-op if the key is unknown. */
  forgetCompleted(idempotencyKey: string): void
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

    startManualRecording(recording: ActiveRecording): void {
      if (state !== 'idle') return
      recording.source = 'manual'
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
    },

    forgetCompleted(idempotencyKey: string): void {
      completedKeys.delete(idempotencyKey)
    }
  }
}
