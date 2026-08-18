/**
 * Join-triggered recording — pure core (spec 2026-08-18 J1–J7).
 *
 * Nothing in this file may import Electron, MSAL, `electron-log`, or reach
 * the network: timers, HTTP, toast, start requests, logging and persistence
 * all arrive by injection, so `scripts/verify-join-watch.ts` can bundle this
 * file alone (and asserts the bundle contains no `require("electron")`).
 *
 * The calendar schedules; the roster signal triggers. This module tracks
 * host-owned meetings from calendar-sync decisions, arms each at
 * `start − AUTO_START_LEAD_MS`, polls that meeting's call-watch signal
 * history, derives *recorder-in-call* from the whole history (a position,
 * not an event — an early joiner still present at −3 min has no fresh
 * signal), and fires start / prompt / disarm.
 *
 * Every "no" is silent and fails closed: no positive signal, no recording.
 */

import type { CallSignal } from './call-signals-core'

// ---------------------------------------------------------------------------
// Constants (J7)
// ---------------------------------------------------------------------------

export const JOIN_WATCH_LEAD_MS = 3 * 60_000
export const JOIN_WATCH_PROMPT_OFFSET_MS = 2 * 60_000
export const JOIN_WATCH_PROMPT_LIFETIME_MS = 60_000
export const JOIN_WATCH_POLL_INTERVAL_MS = 5_000
export const JOIN_WATCH_DISARM_AFTER_END_MS = 10 * 60_000
export const FALSE_START_MAX_DURATION_MS = 5 * 60_000
export const FALSE_START_MAX_AFTER_START_MS = 2 * 60_000

// ---------------------------------------------------------------------------
// deriveCallPresence
// ---------------------------------------------------------------------------

export interface CallPresence {
  /** Last recorder signal is `recorder_rejoined` and no `call_ended` follows it. */
  inCall: boolean
  /** A `call_ended` at/after `scheduledStartUtc` with no later recorder IN. */
  endedAtOrAfterStart: boolean
  lastSignalUtc: string | null
}

/**
 * Walk the FULL signal history for a watch (the relay returns every signal
 * of the current watch generation, sorted by seq — verified 18 Aug in
 * storage-api `list_signals`) and compute the recorder's current position.
 *
 * `scheduledStartUtc` decides whether a `call_ended` means "the meeting is
 * over" (at/after start) or merely "not in call right now" (a pre-meeting
 * camera check that Teams ended). Missing/empty history is `inCall: false`
 * — unknown is never in-call.
 */
export function deriveCallPresence(signals: readonly CallSignal[], scheduledStartUtc?: string): CallPresence {
  const startMs = scheduledStartUtc ? Date.parse(scheduledStartUtc) : Number.NaN
  const ordered = [...signals].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))
  let inCall = false
  let endedAtOrAfterStart = false
  let lastSignalUtc: string | null = null
  for (const s of ordered) {
    lastSignalUtc = s.received_utc
    if (s.type === 'recorder_rejoined') {
      inCall = true
      endedAtOrAfterStart = false
    } else if (s.type === 'recorder_left') {
      inCall = false
    } else if (s.type === 'call_ended') {
      inCall = false
      const atMs = Date.parse(s.received_utc)
      endedAtOrAfterStart = Number.isFinite(startMs) && Number.isFinite(atMs) && atMs >= startMs
    }
  }
  return { inCall, endedAtOrAfterStart, lastSignalUtc }
}
