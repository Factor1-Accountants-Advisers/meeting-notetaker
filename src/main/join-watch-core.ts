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
 * `start − JOIN_WATCH_LEAD_MS`, polls that meeting's call-watch signal
 * history, derives *recorder-in-call* from the whole history (a position,
 * not an event — an early joiner still present at −3 min has no fresh
 * signal), and fires start / prompt / disarm.
 *
 * Every "no" is silent and fails closed: no positive signal, no recording.
 */

import type { CallSignal, CallSignalStopReason } from './call-signals-core'
import type { GraphEventDecision } from './graph/types'

// ---------------------------------------------------------------------------
// Constants (J7)
// ---------------------------------------------------------------------------

/** J2: how long before scheduled start a meeting arms for join-watch polling.
 *  MUST stay equal to `DEFAULT_AUTO_START_LEAD_MS` in `src/main/graph/runtime.ts`
 *  (also 3 min) — that constant decides when calendar-sync schedules the
 *  arm timer in the first place, so the two must never drift apart. */
export const JOIN_WATCH_LEAD_MS = 3 * 60_000
/** J3: how long into the armed window with no in-call signal before the
 *  "start recording?" prompt is shown. */
export const JOIN_WATCH_PROMPT_OFFSET_MS = 2 * 60_000
/** J3: how long the prompt stays on screen before it auto-dismisses. */
export const JOIN_WATCH_PROMPT_LIFETIME_MS = 60_000
/** J5: how often an armed meeting polls its call-watch signal history. */
export const JOIN_WATCH_POLL_INTERVAL_MS = 5_000
/** J2: how long after the meeting's scheduled end an unstarted watch stays
 *  armed before it gives up and disarms itself. */
export const JOIN_WATCH_DISARM_AFTER_END_MS = 10 * 60_000
/** J4: a join-triggered recording shorter than this counts as a false start
 *  (auto-recorded but nobody was really in the meeting). */
export const FALSE_START_MAX_DURATION_MS = 5 * 60_000
/** J4: a join-triggered recording that stops (via leave-grace) before the
 *  meeting's SCHEDULED start plus this margin can be a false start; anything
 *  ending later is the meeting itself. Anchored on scheduled start, not on
 *  the recording's own start — the duration guard above covers that. */
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
  /** `seq` of the last signal walked (sorted order) — what the watcher hands
   *  the attach poller as its drain baseline (J5/E5); null for no history. */
  lastSeq: string | null
}

/**
 * Walk the FULL signal history for a watch (the relay returns every signal
 * of the current watch generation, sorted by seq — verified 18 Aug in
 * storage-api `list_signals`) and compute the recorder's current position.
 *
 * `scheduledStartUtc` decides whether a `call_ended` means "the meeting is
 * over" (at/after start) or merely "not in call right now" (a pre-meeting
 * camera check that Teams ended). Missing/empty history is `inCall: false`
 * — unknown is never in-call. When `scheduledStartUtc` is omitted entirely,
 * a `call_ended` can never count as "ended" — `endedAtOrAfterStart` stays
 * false with no start time to compare against.
 */
export function deriveCallPresence(signals: readonly CallSignal[], scheduledStartUtc?: string): CallPresence {
  const startMs = scheduledStartUtc ? Date.parse(scheduledStartUtc) : Number.NaN
  const ordered = [...signals].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))
  let inCall = false
  let endedAtOrAfterStart = false
  let lastSignalUtc: string | null = null
  let lastSeq: string | null = null
  for (const s of ordered) {
    lastSignalUtc = s.received_utc
    lastSeq = s.seq
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
  return { inCall, endedAtOrAfterStart, lastSignalUtc, lastSeq }
}

// ---------------------------------------------------------------------------
// decideFalseStart (J4)
// ---------------------------------------------------------------------------

/** Per-recording provenance: what started THIS recording; `undefined` for
 *  manual recordings. */
export type RecordingTrigger = 'join' | 'prompt' | 'calendar'

/**
 * Why an auto-managed recording stopped. `grace_expired`, `call_ended`, and
 * `upload_now` come from the call-signal machine's `stop(reason)` (threaded
 * in Task 4):
 *  - `grace_expired` — the grace window opened by `recorder_left` ran out
 *    with no rejoin.
 *  - `call_ended` — a `call_ended` signal arrived.
 *  - `upload_now` — the paused toast's "Upload now" button: a human
 *    override that must ALWAYS deliver.
 * `scheduled_end` comes from the scheduled-end auto-stop timer. `manual` is
 * reserved for a user/tray stop routed through `sendAutoStopRequest` — today
 * renderer/tray-initiated stops go straight to the renderer and never pass
 * through it, so nothing emits `manual` yet.
 */
export type AutoStopReason = CallSignalStopReason | 'scheduled_end' | 'manual'

export interface FalseStartInput {
  trigger: RecordingTrigger | undefined
  stopReason: AutoStopReason
  scheduledStartUtc: string
  startedAtUtc: string | undefined
  nowUtc: string
}

/**
 * A join-triggered recording that the leave flow stopped BEFORE the meeting
 * was really under way is a false start (early join, then left): discard it
 * and let the meeting re-arm (J4). Anchored on scheduled start, not duration
 * alone, so a genuinely short call at its scheduled time still delivers.
 * Prompt- and calendar-triggered recordings are never discarded — a human
 * (or the legacy mode) chose those. Any doubt → deliver.
 *
 * Spec J4 says `stopReason == recorder_left`; the stop machine reports that
 * as `grace_expired` (the grace window opened by recorder_left ran out) —
 * the human "Upload now" override reports `upload_now` and always delivers.
 * Manual recordings carry no trigger and are never discarded.
 */
export function decideFalseStart(input: FalseStartInput): 'discard' | 'deliver' {
  if (input.trigger !== 'join') return 'deliver'
  if (input.stopReason !== 'grace_expired') return 'deliver'
  const startMs = Date.parse(input.scheduledStartUtc)
  const nowMs = Date.parse(input.nowUtc)
  const startedMs = input.startedAtUtc ? Date.parse(input.startedAtUtc) : Number.NaN
  if (![startMs, nowMs, startedMs].every(Number.isFinite)) return 'deliver'
  if (nowMs >= startMs + FALSE_START_MAX_AFTER_START_MS) return 'deliver'
  if (nowMs - startedMs >= FALSE_START_MAX_DURATION_MS) return 'deliver'
  return 'discard'
}

// ---------------------------------------------------------------------------
// readAutoStartTrigger (J6)
// ---------------------------------------------------------------------------

/** Machine-wide mode read from `MN_AUTO_START_TRIGGER` (J6), not a
 *  per-recording value — the literals overlap with `RecordingTrigger`
 *  deliberately. */
export type AutoStartTrigger = 'join' | 'calendar'

/**
 * `MN_AUTO_START_TRIGGER`. `layers` is the supervisor's merged two-layer
 * backend.env (bundled, then %PROGRAMDATA% — PROGRAMDATA wins) and takes
 * precedence over the process env; the code default is `join`; anything
 * unrecognised is `join` (fail closed: never fall back to calendar-time
 * recording by typo). An empty layer value does not mask the process env.
 * The process env is the dev/unpackaged fallback — packaged builds set the
 * file; spec J6's precedence is PROGRAMDATA > bundled > code default.
 */
export function readAutoStartTrigger(
  layers: Record<string, string | undefined>,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): AutoStartTrigger {
  const fromLayers = (layers.MN_AUTO_START_TRIGGER ?? '').trim()
  const raw = (fromLayers || (env.MN_AUTO_START_TRIGGER ?? '')).trim().toLowerCase()
  return raw === 'calendar' ? 'calendar' : 'join'
}

// ---------------------------------------------------------------------------
// Engine (J1–J3, J5)
// ---------------------------------------------------------------------------

/** The slice of a calendar decision the engine keeps per tracked meeting. */
export interface JoinWatchMeeting {
  /** `decision.idempotencyKey ?? decision.eventId` — the recording key. */
  idempotencyKey: string
  eventId: string
  joinWebUrl: string
  /** `sha256(joinWebUrl)` in production — the call-watch address (E2). Logs
   *  and lookups use this, never the URL. */
  joinUrlHash: string
  startUtc: string
  endUtc: string
  title: string
  metadata: GraphEventDecision['metadata']
}

/**
 * J2 lifecycle: `tracked` (arm timer pending) → `armed` (polling / prompt
 * timer live) → `recording` (the stop machine owns it). `disarmed` is
 * terminal and the record is dropped from the map, so `getPhase` returns
 * `undefined` for a disarmed meeting — the literal exists so callers holding
 * a stale reference can still name the state.
 */
export type JoinWatchPhase = 'tracked' | 'armed' | 'recording' | 'disarmed'

export interface JoinWatchTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type JoinWatchLog = (level: 'info' | 'warn', message: string, context?: Record<string, unknown>) => void

export interface JoinWatchDeps {
  /** The registrar's `hasActiveWatch(hash)`: no watch → prompt-only (J2). */
  hasActiveWatch: (joinUrlHash: string) => boolean
  joinUrlHash: (joinWebUrl: string) => string
  /** Full signal history for a watch, or null on any transport failure —
   *  null is "unknown", and unknown is never in-call (J2). */
  fetchSignals: (joinUrlHash: string) => Promise<CallSignal[] | null>
  /** True while ANY recording is active or a start is pending. */
  isRecordingActive: () => boolean
  /** Issue the start request. Return true once it is ACCEPTED (queued or
   *  sent); false — or a throw — means nothing started: the engine stays
   *  armed and the next poll / prompt tries again. `baseline.lastSeenSeq` is
   *  the seq of the last watch signal this engine had seen for the meeting
   *  (null if it never read a history): the attach poller drains only up to
   *  it and acts on anything later, so a leave that lands between this
   *  decision and the first attach poll is not swallowed (J5/E5). */
  startRecording: (
    meeting: JoinWatchMeeting,
    trigger: Exclude<RecordingTrigger, 'calendar'>,
    baseline: { lastSeenSeq: string | null }
  ) => boolean
  showPrompt: (meeting: JoinWatchMeeting) => void
  onDisarm: (meeting: JoinWatchMeeting) => void
  /** Persisted "prompted for meeting X" (survives restart, J3). */
  promptedKeys: { has: (key: string) => boolean; add: (key: string) => void }
  timers: JoinWatchTimers
  now: () => number
  log: JoinWatchLog
  leadMs?: number
  promptOffsetMs?: number
  pollIntervalMs?: number
  disarmAfterEndMs?: number
  /** Ownership check for a decision (the registrar's `evaluateHostOwnership`).
   *  Defaults to `logContext.isOrganizer && status === 'candidate'`. */
  isHostOwned?: (decision: GraphEventDecision, signedInEmail?: string) => boolean
}

/** Whether a sync's decisions are a complete snapshot of the calendar
 *  window or a delta (changed events only) — `GraphSyncMeta` in
 *  `graph/runtime.ts`, mirrored here so the core stays import-light. */
export interface JoinWatchSyncMeta {
  fullSnapshot: boolean
}

export interface JoinWatchEngine {
  /** Called after EVERY calendar sync with the unfiltered decision list.
   *  `meta.fullSnapshot` (default true) gates the vanish-disarm: only a full
   *  snapshot can prove a tracked meeting is gone. */
  handleSyncDecisions(
    decisions: readonly GraphEventDecision[],
    signedInEmail?: string,
    meta?: JoinWatchSyncMeta
  ): void
  /** The prompt's "Record now" (J3): start with trigger `'prompt'`. */
  acceptPrompt(key: string): void
  /** After a discarded false start (J4) or a start that never became a
   *  recording: back to `armed`; polling resumes one interval later. */
  rearm(key: string): void
  /** A recording for `key` started (by us or otherwise): stop polling it. */
  noteRecordingStarted(key: string): void
  getPhase(key: string): JoinWatchPhase | undefined
  dispose(): void
}

interface Tracked {
  meeting: JoinWatchMeeting
  phase: JoinWatchPhase
  armTimer: unknown
  promptTimer: unknown
  disarmTimer: unknown
  pollTimer: unknown
  /** A fetch is in flight — a second `pollOnce` is a no-op (single-flight). */
  polling: boolean
  /** "start refused: recording active" has been logged for this streak; reset
   *  once the recorder is seen out of the call, so a 5 s poll does not repeat
   *  the same line for the length of a manual recording. */
  refusalLogged: boolean
  /** "start refused: past scheduled end" has been logged; past-end is
   *  monotonic for a tracked slot (a reschedule re-tracks from scratch), so
   *  once is enough for the whole +10 tail. */
  pastEndLogged: boolean
  /** seq of the last signal in the most recent SUCCESSFUL poll's history —
   *  handed to `startRecording` as the attach poller's drain baseline (J5).
   *  A failed poll leaves it untouched. */
  lastSeenSeq: string | null
  /** A signal-fetch failure streak is in progress and its one "failing"
   *  line has been logged; the next success logs "recovered" once and
   *  resets. Same shape as `refusalLogged`: a relay outage must not write
   *  a warning every 5 s for the length of the arm window. */
  fetchFailing: boolean
}

type TimerSlot = 'armTimer' | 'promptTimer' | 'disarmTimer' | 'pollTimer'
const ALL_TIMERS: readonly TimerSlot[] = ['armTimer', 'promptTimer', 'disarmTimer', 'pollTimer']

/**
 * The join watcher (J1–J3, J5). Per host-owned meeting: `tracked` →
 * `armed` at `start − leadMs` → `recording` when recorder-in-call, with a
 * one-time prompt at `start + promptOffsetMs` if still armed and idle, and
 * disarm on `call_ended` at/after start, `end + disarmAfterEndMs`,
 * cancellation (vanished from a later sync), or reschedule.
 *
 * Every injected effect runs inside `safe()` — nothing thrown by a toast,
 * a start request, or persistence can escape a timer callback or kill the
 * poll loop. Logs carry keys, hashes, booleans and counts only: never a
 * join URL, a title, or an email.
 */
export function createJoinWatchEngine(deps: JoinWatchDeps): JoinWatchEngine {
  const leadMs = deps.leadMs ?? JOIN_WATCH_LEAD_MS
  const promptOffsetMs = deps.promptOffsetMs ?? JOIN_WATCH_PROMPT_OFFSET_MS
  const pollIntervalMs = deps.pollIntervalMs ?? JOIN_WATCH_POLL_INTERVAL_MS
  const disarmAfterEndMs = deps.disarmAfterEndMs ?? JOIN_WATCH_DISARM_AFTER_END_MS
  const isHostOwned =
    deps.isHostOwned ?? ((d: GraphEventDecision): boolean => d.status === 'candidate' && d.logContext.isOrganizer)

  const tracked = new Map<string, Tracked>()
  let disposed = false

  const clear = (t: Tracked, which: TimerSlot): void => {
    const handle = t[which]
    if (handle === null || handle === undefined) return
    t[which] = null
    try {
      deps.timers.clearTimeout(handle)
    } catch {
      // A timer host that throws on clear is still a cleared slot for us.
    }
  }

  const clearAll = (t: Tracked): void => {
    for (const slot of ALL_TIMERS) clear(t, slot)
  }

  /** Wrap every injected effect: catch, log (label + error class only — an
   *  exception message could carry anything, so it never reaches the log),
   *  continue. The lifecycle must outlive any effect. */
  const safe = (label: string, fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      deps.log('warn', '[join-watch] effect threw', {
        effect: label,
        name: err instanceof Error ? err.name : typeof err
      })
    }
  }

  const hasWatch = (t: Tracked): boolean => {
    try {
      return deps.hasActiveWatch(t.meeting.joinUrlHash) === true
    } catch {
      return false // no answer = no watch = prompt-only (fail closed)
    }
  }

  const recordingActive = (): boolean => {
    try {
      return deps.isRecordingActive() === true
    } catch {
      return true // cannot tell → assume busy: never start over an unknown
    }
  }

  const alreadyPrompted = (key: string): boolean => {
    try {
      return deps.promptedKeys.has(key) === true
    } catch {
      return false
    }
  }

  const disarm = (t: Tracked, reason: string): void => {
    if (t.phase === 'disarmed') return
    clearAll(t)
    t.phase = 'disarmed'
    tracked.delete(t.meeting.idempotencyKey)
    deps.log('info', '[join-watch] disarmed', { key: t.meeting.idempotencyKey, reason })
    safe('onDisarm', () => deps.onDisarm(t.meeting))
  }

  /** J2 amendment: a recording may start only while `now < scheduled end`.
   *  The arm window's +10 tail exists so late signals and GC are handled —
   *  never to start a recording after the meeting is over: the scheduled-end
   *  backstop (`scheduleAutoStop`) would fire at 0 ms and deliver a
   *  sub-second junk recording. */
  const pastScheduledEnd = (t: Tracked): boolean => {
    const endMs = Date.parse(t.meeting.endUtc)
    return Number.isFinite(endMs) && deps.now() >= endMs
  }

  /** J1/J3 start. Refused (not queued) while anything records or once the
   *  meeting's scheduled end has passed, and not flipped to `recording`
   *  unless the start request is ACCEPTED: in every case the meeting stays
   *  armed and the next poll / prompt decides again. */
  const start = (t: Tracked, trigger: Exclude<RecordingTrigger, 'calendar'>): void => {
    if (t.phase !== 'armed') return
    if (pastScheduledEnd(t)) {
      // Both triggers: a join inside the +10 tail and a Record now clicked
      // after the end would each produce the junk recording described above.
      // Phase untouched — the end + 10 timer is pure GC from here. The join
      // refusal logs once (a 5 s poll would otherwise repeat it for the whole
      // tail); a Record now click is a human action and always logs.
      if (!t.pastEndLogged || trigger === 'prompt') {
        t.pastEndLogged = true
        deps.log('info', '[join-watch] start refused: past scheduled end', {
          key: t.meeting.idempotencyKey,
          trigger
        })
      }
      return
    }
    if (recordingActive()) {
      if (!t.refusalLogged) {
        t.refusalLogged = true
        deps.log('info', '[join-watch] start refused: a recording is active', {
          key: t.meeting.idempotencyKey,
          trigger
        })
      }
      return
    }
    deps.log('info', '[join-watch] starting recording', { key: t.meeting.idempotencyKey, trigger })
    let accepted = false
    safe('startRecording', () => {
      accepted = deps.startRecording(t.meeting, trigger, { lastSeenSeq: t.lastSeenSeq }) === true
    })
    if (!accepted) {
      // Nothing started (renderer busy / not ready / effect threw): stay
      // armed so the loop retries; the prompt window is untouched.
      deps.log('warn', '[join-watch] start not accepted', { key: t.meeting.idempotencyKey, trigger })
      return
    }
    t.phase = 'recording'
    t.refusalLogged = false
    // The stop machine owns the meeting from here; the disarm timer stays as
    // the map's garbage collector (end + disarmAfterEndMs).
    clear(t, 'pollTimer')
    clear(t, 'promptTimer')
  }

  const schedulePoll = (t: Tracked): void => {
    clear(t, 'pollTimer')
    if (disposed || t.phase !== 'armed') return
    t.pollTimer = deps.timers.setTimeout(() => {
      t.pollTimer = null
      void pollOnce(t).catch(() => undefined)
    }, pollIntervalMs)
  }

  /**
   * J5 poll tick: read the watch's FULL history, derive the recorder's
   * position (J2 "derived state, not drained events"), act, reschedule.
   * A failed fetch is "unknown", and unknown is not in-call, so polling
   * simply continues until the window closes. The `finally` keeps the loop
   * alive whatever the body did (call sites also `.catch(() => undefined)`,
   * mirroring `call-signals-core.ts`).
   */
  const pollOnce = async (t: Tracked): Promise<void> => {
    if (disposed || t.phase !== 'armed' || t.polling) return
    t.polling = true
    try {
      let signals: CallSignal[] | null = null
      try {
        signals = await deps.fetchSignals(t.meeting.joinUrlHash)
      } catch {
        signals = null
      }
      // Disarmed, disposed, started manually, or rescheduled while in flight.
      if (disposed || t.phase !== 'armed') return
      if (signals === null) {
        if (!t.fetchFailing) {
          t.fetchFailing = true
          deps.log('warn', '[join-watch] signal fetch failing', { key: t.meeting.idempotencyKey })
        }
        return
      }
      if (t.fetchFailing) {
        t.fetchFailing = false
        deps.log('info', '[join-watch] signal fetch recovered', { key: t.meeting.idempotencyKey })
      }
      const presence = deriveCallPresence(signals, t.meeting.startUtc)
      t.lastSeenSeq = presence.lastSeq
      if (presence.endedAtOrAfterStart) {
        // The meeting is over (J2): a call_ended at/after scheduled start with
        // no later recorder IN. A pre-start call_ended never reaches here.
        disarm(t, 'call_ended')
        return
      }
      if (presence.inCall) start(t, 'join')
      else t.refusalLogged = false
    } finally {
      t.polling = false
      if (!disposed && t.phase === 'armed') schedulePoll(t)
    }
  }

  /**
   * J3 prompt timer: once, at `start + promptOffsetMs`, and only if the
   * meeting is still armed, nothing is recording, and it was never prompted
   * before (persisted, so a restart at +3 does not re-toast). If that moment
   * is already past (an app that wakes mid-meeting), a watched meeting waits
   * one poll interval first — an early joiner still in the call must START
   * on the first poll, not see a flash toast — while an unwatched meeting
   * asks at once (there is no poll to wait for). Suppression while another
   * recording is live does NOT consume the once-only key: the toast is
   * skipped for this process, and a restart inside the window would ask.
   */
  const schedulePrompt = (t: Tracked, watched: boolean): void => {
    clear(t, 'promptTimer')
    if (alreadyPrompted(t.meeting.idempotencyKey)) return
    const promptAt = Date.parse(t.meeting.startUtc) + promptOffsetMs
    const untilPrompt = Math.max(promptAt - deps.now(), watched ? pollIntervalMs : 0)
    t.promptTimer = deps.timers.setTimeout(() => {
      t.promptTimer = null
      if (disposed || t.phase !== 'armed') return
      if (pastScheduledEnd(t)) {
        // A meeting shorter than the prompt offset (or a late arm inside the
        // +10 tail) lands here after its end: Record now could only produce
        // the junk recording `start` refuses, so ask nothing. The once-only
        // key is NOT consumed — nothing was shown.
        deps.log('info', '[join-watch] prompt skipped: past scheduled end', {
          key: t.meeting.idempotencyKey
        })
        return
      }
      if (recordingActive()) {
        deps.log('info', '[join-watch] prompt suppressed: a recording is active', {
          key: t.meeting.idempotencyKey
        })
        return
      }
      if (alreadyPrompted(t.meeting.idempotencyKey)) return
      safe('promptedKeys.add', () => deps.promptedKeys.add(t.meeting.idempotencyKey))
      deps.log('info', '[join-watch] prompting', { key: t.meeting.idempotencyKey })
      safe('showPrompt', () => deps.showPrompt(t.meeting))
    }, untilPrompt)
  }

  /** Enter `armed` from `tracked` (the −3 timer) or from `recording`
   *  (`rearm` after a discarded false start or a start that never became a
   *  recording): prompt timer + poll loop. */
  const arm = (t: Tracked, via: 'timer' | 'sync' | 'rearm'): void => {
    if (disposed) return
    t.phase = 'armed'
    const watched = hasWatch(t)
    deps.log('info', '[join-watch] armed', { key: t.meeting.idempotencyKey, via, hasWatch: watched })
    schedulePrompt(t, watched)
    // Poll only when a watch exists; otherwise the prompt is the only path
    // to a recording (J2: beyond the cap, created too late, relay down).
    if (!watched) {
      deps.log('info', '[join-watch] no active watch: prompt-only', { key: t.meeting.idempotencyKey })
      return
    }
    // A re-arm's first poll waits one interval instead of running now: the
    // ack-timeout re-arm (15 s) can land while the renderer's createMeeting
    // for the previous start is still in flight (30 s budget), and an
    // immediate poll could re-issue a start on top of it. A fresh arm polls
    // at once so an early joiner starts at exactly −3 (s1).
    if (via === 'rearm') schedulePoll(t)
    else void pollOnce(t).catch(() => undefined)
  }

  const track = (meeting: JoinWatchMeeting): void => {
    const existing = tracked.get(meeting.idempotencyKey)
    if (existing) {
      if (existing.phase === 'recording') {
        // The stop machine owns a recording meeting; a reschedule mid-call
        // (the organiser extends it) must neither disarm nor re-arm. Refresh
        // the payload and re-point ONLY the end + 10 GC timer.
        const sameEnd = existing.meeting.endUtc === meeting.endUtc
        existing.meeting = meeting
        if (!sameEnd) {
          const newEndMs = Date.parse(meeting.endUtc)
          if (Number.isFinite(newEndMs)) {
            clear(existing, 'disarmTimer')
            existing.disarmTimer = deps.timers.setTimeout(() => {
              existing.disarmTimer = null
              disarm(existing, 'window_closed')
            }, Math.max(0, newEndMs + disarmAfterEndMs - deps.now()))
            deps.log('info', '[join-watch] recording meeting rescheduled; GC re-pointed', {
              key: meeting.idempotencyKey
            })
          }
        }
        return
      }
      if (existing.meeting.startUtc === meeting.startUtc && existing.meeting.endUtc === meeting.endUtc) {
        // Same slot: refresh the payload (title, metadata) and keep the timers.
        existing.meeting = meeting
        // Late-watch pickup: armed as prompt-only because the registrar had no
        // watch yet (beyond the cap, created late); if one exists now, start
        // the poll loop — but never a second loop beside a live one.
        if (existing.phase === 'armed' && !existing.polling && existing.pollTimer === null && hasWatch(existing)) {
          deps.log('info', '[join-watch] watch appeared after arming; polling', { key: meeting.idempotencyKey })
          void pollOnce(existing).catch(() => undefined)
        }
        return
      }
      // Reschedule (E4-style): the old timers are wrong now → re-track from scratch.
      disarm(existing, 'rescheduled')
    }
    const startMs = Date.parse(meeting.startUtc)
    const endMs = Date.parse(meeting.endUtc)
    const nowMs = deps.now()
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      deps.log('warn', '[join-watch] not tracked: unparseable times', { key: meeting.idempotencyKey })
      return
    }
    const disarmAt = endMs + disarmAfterEndMs
    if (disarmAt <= nowMs) {
      // The arm window is already closed (spec: [start − 3, end + 10]).
      deps.log('info', '[join-watch] not tracked: window closed', { key: meeting.idempotencyKey })
      return
    }
    const t: Tracked = {
      meeting,
      phase: 'tracked',
      armTimer: null,
      promptTimer: null,
      disarmTimer: null,
      pollTimer: null,
      polling: false,
      refusalLogged: false,
      pastEndLogged: false,
      lastSeenSeq: null,
      fetchFailing: false
    }
    tracked.set(meeting.idempotencyKey, t)
    t.disarmTimer = deps.timers.setTimeout(() => {
      t.disarmTimer = null
      disarm(t, 'window_closed')
    }, disarmAt - nowMs)
    const armAt = startMs - leadMs
    deps.log('info', '[join-watch] tracking', {
      key: meeting.idempotencyKey,
      armInMs: Math.max(0, armAt - nowMs),
      disarmInMs: disarmAt - nowMs
    })
    if (armAt <= nowMs) {
      arm(t, 'sync')
      return
    }
    t.armTimer = deps.timers.setTimeout(() => {
      t.armTimer = null
      if (t.phase === 'tracked') arm(t, 'timer')
    }, armAt - nowMs)
  }

  return {
    handleSyncDecisions(decisions, signedInEmail, meta = { fullSnapshot: true }) {
      if (disposed) return
      const seen = new Set<string>()
      for (const d of decisions) {
        let owned = false
        try {
          owned = isHostOwned(d, signedInEmail)
        } catch {
          owned = false // fail closed: an ownership check that throws is a "no"
        }
        if (!owned) continue
        const startUtc = d.logContext?.startUtc
        const endUtc = d.logContext?.endUtc
        const joinWebUrl = d.metadata?.joinWebUrl
        if (!startUtc || !endUtc || !joinWebUrl) continue
        const key = d.idempotencyKey ?? d.eventId
        seen.add(key)
        let joinUrlHash: string
        try {
          joinUrlHash = deps.joinUrlHash(joinWebUrl)
        } catch {
          continue // no address for the watch → nothing to poll; skip this decision
        }
        track({
          idempotencyKey: key,
          eventId: d.eventId,
          joinWebUrl,
          joinUrlHash,
          startUtc,
          endUtc,
          title: d.metadata?.title?.trim() || 'Teams meeting',
          metadata: d.metadata
        })
      }
      // Cancelled = tracked but absent from a FULL-SNAPSHOT sync while still
      // ahead of its scheduled end. A delta sync carries changed events only,
      // so absence there means "unchanged", never "gone" — the same contract
      // the call-watch registrar applies to this feed (rule 2 in
      // `call-watch-registrar-core.ts` `planRegistrarActions`); the runtime
      // tells us which kind this was (`GraphSyncMeta.fullSnapshot`). Past the
      // end Graph's calendar window no longer returns the event at all, so
      // absence is expected there and the end + 10 timer owns that disarm.
      // Recording meetings are never touched: the stop machine owns them.
      if (!meta.fullSnapshot) return
      const nowMs = deps.now()
      for (const [key, t] of [...tracked]) {
        if (seen.has(key) || t.phase === 'recording') continue
        const endMs = Date.parse(t.meeting.endUtc)
        if (Number.isFinite(endMs) && nowMs >= endMs) continue
        disarm(t, 'vanished')
      }
    },

    acceptPrompt(key) {
      const t = tracked.get(key)
      if (!t || disposed) return
      start(t, 'prompt')
    },

    rearm(key) {
      const t = tracked.get(key)
      if (!t || disposed || t.phase !== 'recording') return
      deps.log('info', '[join-watch] re-armed after discarded false start', { key })
      // Back to armed with a fresh prompt window: the J3 conditions (armed,
      // idle at start + 2) hold again for the re-armed meeting; the
      // once-per-meeting rule still applies via promptedKeys.
      arm(t, 'rearm')
    },

    noteRecordingStarted(key) {
      const t = tracked.get(key)
      if (!t || disposed || t.phase === 'recording') return
      t.phase = 'recording'
      // A pending arm must not revive polling; the disarm timer stays as GC.
      clear(t, 'armTimer')
      clear(t, 'pollTimer')
      clear(t, 'promptTimer')
      deps.log('info', '[join-watch] recording noted; stepping aside', { key })
    },

    getPhase: (key) => tracked.get(key)?.phase,

    dispose() {
      disposed = true
      for (const t of tracked.values()) clearAll(t)
      tracked.clear()
    }
  }
}
