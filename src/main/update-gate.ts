// IN-469: decides when a downloaded update may auto-install. Pure logic —
// no Electron imports — so verify-update-gate.ts can pin the truth table.

export const AUTO_RECORD_LEAD_MS = 15 * 60_000
/** Small look-back so the instant around a meeting's start (before the
 * auto-start dispatch flips pendingAutoStart) still blocks. Starts older
 * than this are NOT imminent — a recording in progress is caught by
 * recordingState/pendingAutoStart, and without a lower bound a stale past
 * start would block installs forever. */
export const AUTO_RECORD_GRACE_MS = 2 * 60_000
export const SYSTEM_IDLE_MIN_SECONDS = 300
export const SNOOZE_MS = 4 * 60 * 60_000
export const COUNTDOWN_SECONDS = 60

export interface UpdateGateInput {
  updateDownloaded: boolean
  /** recording-state machine state; anything but 'idle' blocks. */
  recordingState: string
  /** recording-ipc has an auto-start handed to the renderer, unacked or active. */
  pendingAutoStart: boolean
  /** Next auto-record-eligible meeting start (UTC ms), null when none known. */
  nextAutoRecordStartUtcMs: number | null
  /** Any backend meeting still in pending_audio (young), queued, or processing. */
  backendBusy: boolean
  systemIdleSeconds: number
  /** Deferral expiry (UTC ms), 0 when never deferred. */
  snoozedUntilUtcMs: number
  nowUtcMs: number
}

export type UpdateGateVerdict =
  | { allow: true }
  | { allow: false; reason: string }

export function evaluateUpdateGate(input: UpdateGateInput): UpdateGateVerdict {
  if (!input.updateDownloaded) return { allow: false, reason: 'no_update_downloaded' }
  if (input.recordingState !== 'idle') return { allow: false, reason: 'recording_active' }
  if (input.pendingAutoStart) return { allow: false, reason: 'auto_start_pending' }
  if (input.nextAutoRecordStartUtcMs !== null) {
    const untilStart = input.nextAutoRecordStartUtcMs - input.nowUtcMs
    // Bounded window: a stale PAST start must not block forever.
    if (untilStart <= AUTO_RECORD_LEAD_MS && untilStart >= -AUTO_RECORD_GRACE_MS) {
      return { allow: false, reason: 'auto_record_imminent' }
    }
  }
  if (input.backendBusy) return { allow: false, reason: 'backend_processing' }
  if (input.systemIdleSeconds < SYSTEM_IDLE_MIN_SECONDS) {
    return { allow: false, reason: 'user_active' }
  }
  if (input.nowUtcMs < input.snoozedUntilUtcMs) return { allow: false, reason: 'snoozed' }
  return { allow: true }
}

/** Meetings in these pipeline states mean work is in flight. pending_audio
 * only counts while young — an ancient stuck pending_audio meeting must not
 * block updates forever. */
export const BUSY_PIPELINE_STATUSES = new Set(['queued', 'processing'])
export const PENDING_AUDIO_BUSY_WINDOW_MS = 30 * 60_000

export function isBackendBusy(
  meetings: Array<{ pipeline_status: string; created_at: string }>,
  nowUtcMs: number
): boolean {
  return meetings.some((m) => {
    if (BUSY_PIPELINE_STATUSES.has(m.pipeline_status)) return true
    if (m.pipeline_status !== 'pending_audio') return false
    const created = Date.parse(m.created_at)
    return Number.isFinite(created) && nowUtcMs - created <= PENDING_AUDIO_BUSY_WINDOW_MS
  })
}
