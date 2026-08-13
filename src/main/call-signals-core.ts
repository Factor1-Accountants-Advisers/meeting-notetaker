/**
 * Call-signal state machine + poller core (meeting-call-events, spec
 * D5/D6/D7/D9) — the Electron-free half of the feature.
 *
 * Nothing in this file may import Electron, MSAL, `electron-log`, or reach the
 * network: every effect (timers, HTTP, identity, logging, recording controls)
 * arrives by injection. `storage-api-identity` is the only non-type import and
 * is itself a pure helper module. That keeps `scripts/verify-call-signals.ts`
 * a plain-Node harness — it bundles this file alone, and asserts that the
 * bundle contains no `require("electron")`.
 *
 * `call-signals.ts` re-exports everything here and adds the runtime layer
 * (real fetch, MSAL identity headers, electron-log, the module singleton), so
 * Task 13 imports only `./call-signals`.
 *
 * Two robustness rules run through the whole file:
 *
 * - **State first, actions last.** Every transition commits its state, timer,
 *   toast flag, and seen-set changes BEFORE any injected action runs. A
 *   throwing action can therefore never leave the machine half-transitioned,
 *   and an action that re-enters the machine synchronously sees the new state
 *   (so a re-entrant `call_ended` during `closePausedToast()` cannot produce a
 *   second stop).
 * - **Actions are untrusted.** Every `actions.*` call is wrapped; a throw is
 *   swallowed, counted (`getActionErrorCount()`), and the remaining effects of
 *   that transition still run. Losing a toast must never cost us the stop.
 *
 * Privacy: logs carry status codes and state only — never join URLs, tokens,
 * emails, OIDs, or response bodies (same rule as `hostGateLogContext`).
 */

import type { ActiveRecording } from './recording-state'
import { isStorageApiEnabled } from './storage-api-identity'

// ===========================================================================
// PURE CORE — state machine, wire translation, arm gate
// ===========================================================================

/** Grace window between "you left the call" and the automatic stop. */
export const CALL_SIGNAL_GRACE_MS = 60_000
/** How often the desktop asks the relay for new signals. */
export const CALL_SIGNAL_POLL_INTERVAL_MS = 10_000
/** Single registration retry (D7: one retry, then dormant for this recording). */
export const CALL_SIGNAL_REGISTRATION_RETRY_MS = 30_000

export type CallSignalType = 'recorder_left' | 'recorder_rejoined' | 'call_ended'

export interface CallSignal {
  seq: string
  type: CallSignalType
  /** Graph's `eventDateTime` is optional, so this is nullable on the wire.
   *  The machine never reads it: grace is anchored on desktop receipt time. */
  event_utc: string | null
  received_utc: string
}

/** Control surfaces the machine drives. Task 13 supplies the real ones.
 *  All of them may throw without consequence — the machine guards each call. */
export interface CallSignalActions {
  /** -> sendTrayRecordingControl('pause') */
  pause(): void
  /** -> sendTrayRecordingControl('resume') */
  resume(): void
  /** -> sendAutoStopRequest() */
  stop(): void
  /** Sticky "recording paused" toast + the renderer chime. */
  showPausedToast(): void
  /** MUST be safe to call when no toast is showing — the machine closes
   *  defensively on every terminal transition. */
  closePausedToast(): void
  /** -> isRecordingPaused() */
  isPaused(): boolean
}

/** Injectable timer surface so the harness can drive time by hand. */
export interface CallSignalTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type CallSignalState = 'watching' | 'grace' | 'done'

export type CallSignalToastAction = 'upload-now' | 'resume-recording'

export interface CallSignalMachine {
  /** Feed a poll response. Signals are processed in `seq` order and deduped
   *  against a seen-set (the relay returns ALL signals for the watch). */
  ingest(signals: CallSignal[]): void
  /** The user resumed from the tray/screen during grace: cancel the grace,
   *  keep recording. Explicit user intent wins (D6). */
  onManualResume(): void
  /** A click on the paused toast. No-op outside grace (stale clicks). */
  onToastAction(action: CallSignalToastAction): void
  /** Teardown: cancel the grace timer, fire nothing.
   *
   *  Disposing DURING a terminal transition (e.g. from inside a re-entrant
   *  `closePausedToast()`) stands the rest of that transition down, so a
   *  pending `stop()` may never fire. That is the correct precedence — a
   *  teardown means nobody is listening any more — but it means a caller must
   *  never treat `dispose()` as "the stop has been issued". Task 13 disarms
   *  from `recording-ipc`'s own stop path, which is the real guard. */
  dispose(): void
  getState(): CallSignalState
  /** True while the machine believes its paused toast is on screen.
   *
   *  Task 13 MUST check this and close the toast BEFORE calling
   *  `disarmCallSignals()` on a recording that stops during grace (manual
   *  stop, error path): `dispose()` deliberately fires no actions — it also
   *  runs on teardown paths where the window is already gone — so the sticky
   *  toast would otherwise outlive the recording. */
  isPausedToastVisible(): boolean
  /** How many injected actions threw. Zero in every healthy run; the harness
   *  asserts on it, and Task 13 may surface it in a log line. */
  getActionErrorCount(): number
}

/**
 * Build the machine. `graceMs` and `timers` are injectable for the harness.
 *
 * Transition rules (spec D5/D6/D9):
 * - `recorder_left` in `watching`: pause (only if not already paused —
 *   a manual pause is never taken over), arm the grace timer on receipt time,
 *   show the toast, enter `grace`. Ignored while already in `grace`.
 * - `recorder_rejoined` in `grace`: cancel the grace, close the toast, resume
 *   ONLY if this machine initiated the pause, back to `watching`. A rejoin in
 *   `watching` is a stale/duplicate delivery and does nothing.
 * - `call_ended` in any live state, and grace expiry: close the toast, stop.
 * - `done` is terminal: everything afterwards is ignored.
 *
 * Ordering note: every exit from grace closes the toast BEFORE issuing the
 * control action, so a sticky toast can never outlive the decision it was
 * asking about.
 */
export function createCallSignalMachine(
  actions: CallSignalActions,
  graceMs: number = CALL_SIGNAL_GRACE_MS,
  timers: CallSignalTimers = { setTimeout, clearTimeout }
): CallSignalMachine {
  const seen = new Set<string>()
  let state: CallSignalState = 'watching'
  let signalInitiatedPause = false
  let toastVisible = false
  let graceTimer: unknown = null
  let actionErrors = 0
  // Bumped by every committed transition. Effects carry the generation they
  // were committed under and stand down if a re-entrant action has since moved
  // the machine on — the newer transition is the truth.
  let generation = 0

  const cancelGrace = (): void => {
    if (graceTimer === null) return
    timers.clearTimeout(graceTimer)
    graceTimer = null
  }

  /** Run a committed transition's effects. Each is guarded, and the sequence
   *  stands down if the machine moved on underneath it. */
  const runEffects = (committedGeneration: number, steps: Array<() => void>): void => {
    for (const step of steps) {
      if (generation !== committedGeneration) return
      try {
        step()
      } catch {
        actionErrors += 1
      }
    }
  }

  /** `isPaused()` decides D6 ownership, so a throw is not merely counted: we
   *  fall back to "not paused" (pausing is the safe best effort) but decline
   *  to claim the pause, because auto-resuming a pause we are not sure we
   *  created would violate D6. */
  const queryIsPaused = (): { paused: boolean; trusted: boolean } => {
    try {
      return { paused: actions.isPaused(), trusted: true }
    } catch {
      actionErrors += 1
      return { paused: false, trusted: false }
    }
  }

  /** Terminal transition: grace expiry, `call_ended`, or "Upload now". */
  const finish = (): void => {
    cancelGrace()
    toastVisible = false
    signalInitiatedPause = false
    state = 'done'
    const committed = ++generation
    runEffects(committed, [() => actions.closePausedToast(), () => actions.stop()])
  }

  /** Leave grace and keep recording. `resume` is false when the pause was the
   *  user's own (D6) or when the user has already resumed by hand. */
  const backToWatching = (resume: boolean): void => {
    cancelGrace()
    toastVisible = false
    state = 'watching'
    signalInitiatedPause = false
    const committed = ++generation
    const steps: Array<() => void> = [() => actions.closePausedToast()]
    if (resume) steps.push(() => actions.resume())
    runEffects(committed, steps)
  }

  /** Enter the grace window. `shouldPause` is false when the user had already
   *  paused by hand; `trusted` is false when the pause query threw, in which
   *  case we pause but decline ownership (D6). */
  const enterGrace = (shouldPause: boolean, trusted: boolean): void => {
    signalInitiatedPause = shouldPause && trusted
    state = 'grace'
    graceTimer = timers.setTimeout(onGraceExpired, graceMs)
    toastVisible = true
    const committed = ++generation
    const steps: Array<() => void> = []
    if (shouldPause) steps.push(() => actions.pause())
    steps.push(() => actions.showPausedToast())
    runEffects(committed, steps)
  }

  const onGraceExpired = (): void => {
    graceTimer = null
    if (state !== 'grace') return
    finish()
  }

  const applySignal = (signal: CallSignal): void => {
    // `done` is terminal, including part-way through a batch: two `call_ended`
    // signals in one poll response must still produce exactly one stop.
    if (state === 'done') return
    switch (signal.type) {
      case 'recorder_left': {
        if (state !== 'watching') return
        const paused = queryIsPaused()
        // The one action that must run BEFORE the commit — it decides D6
        // ownership. So it is also the one place a re-entrant signal can land
        // while this transition is still uncommitted. Anything but `watching`
        // means the machine moved underneath us (a `call_ended` finished it, or
        // another `recorder_left` already entered grace), and the newer
        // transition owns the outcome: stand down rather than resurrect a
        // finished machine or arm a second grace timer over a live one.
        if (state !== 'watching') return
        enterGrace(!paused.paused, paused.trusted)
        return
      }
      case 'recorder_rejoined': {
        if (state !== 'grace') return
        backToWatching(signalInitiatedPause)
        return
      }
      case 'call_ended': {
        finish()
        return
      }
    }
  }

  return {
    ingest(signals: CallSignal[]): void {
      if (state === 'done') return
      // The relay returns every signal for the watch, unordered; `seq` is the
      // only ordering authority (lexically sortable by construction).
      const ordered = [...signals].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))
      for (const signal of ordered) {
        if (seen.has(signal.seq)) continue
        // Marked seen before the transition runs: an action that throws or
        // re-enters must not cause the same signal to be replayed later.
        seen.add(signal.seq)
        applySignal(signal)
      }
    },

    onManualResume(): void {
      if (state !== 'grace') return
      backToWatching(false)
    },

    onToastAction(action: CallSignalToastAction): void {
      if (state !== 'grace') return
      if (action === 'upload-now') {
        finish()
        return
      }
      // "Keep recording" is an explicit user choice, so it always resumes —
      // the renderer no-ops a resume when `session.pausedAt === null`.
      backToWatching(true)
    },

    dispose(): void {
      cancelGrace()
      toastVisible = false
      state = 'done'
      // Stand down any effects still mid-flight in a re-entrant action.
      generation += 1
    },

    getState: () => state,
    isPausedToastVisible: () => toastVisible,
    getActionErrorCount: () => actionErrors
  }
}

/** Shape check for a `GET /call-watch/signals` body. */
export function isCallSignalsPayload(payload: unknown): payload is { signals: unknown[] } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    Array.isArray((payload as { signals?: unknown }).signals)
  )
}

function isCallSignalType(value: unknown): value is CallSignalType {
  return value === 'recorder_left' || value === 'recorder_rejoined' || value === 'call_ended'
}

/**
 * Translate a relay response into signals. Anything malformed is dropped
 * rather than thrown: a bad payload must never break a poll tick (D7).
 * A missing `event_utc` normalises to null (Graph's `eventDateTime` is
 * optional and the field is nullable all the way down the contract).
 */
export function parseCallSignals(payload: unknown): CallSignal[] {
  if (!isCallSignalsPayload(payload)) return []
  const signals: CallSignal[] = []
  for (const entry of payload.signals) {
    if (typeof entry !== 'object' || entry === null) continue
    const raw = entry as Record<string, unknown>
    const seq = typeof raw.seq === 'string' ? raw.seq.trim() : ''
    const receivedUtc = typeof raw.received_utc === 'string' ? raw.received_utc.trim() : ''
    if (!seq || !receivedUtc || !isCallSignalType(raw.type)) continue
    signals.push({
      seq,
      type: raw.type,
      event_utc: typeof raw.event_utc === 'string' ? raw.event_utc : null,
      received_utc: receivedUtc
    })
  }
  return signals
}

/** Read `metadata.joinWebUrl` off an ActiveRecording's opaque metadata. */
export function readJoinWebUrl(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null
  const value = (metadata as { joinWebUrl?: unknown }).joinWebUrl
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

export type CallSignalArmSkipReason =
  | 'feature_disabled'
  | 'not_auto_recording'
  | 'no_join_url'
  | 'storage_api_disabled'
  | 'no_storage_scope'

export type CallSignalArmDecision =
  | { arm: true; joinWebUrl: string }
  | { arm: false; reason: CallSignalArmSkipReason }

/**
 * Whether this recording gets a call watch. Every "no" is silent and leaves
 * today's behaviour untouched (D7/D8) — the scheduled auto-stop and the T-5
 * Extend toast are unaffected either way.
 */
export function shouldArmCallSignals(
  recording: Pick<ActiveRecording, 'source' | 'metadata'>,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): CallSignalArmDecision {
  if ((env.MN_CALL_SIGNALS_ENABLED ?? '').trim().toLowerCase() === 'false') {
    return { arm: false, reason: 'feature_disabled' }
  }
  if (recording.source !== 'auto') return { arm: false, reason: 'not_auto_recording' }
  const joinWebUrl = readJoinWebUrl(recording.metadata)
  if (!joinWebUrl) return { arm: false, reason: 'no_join_url' }
  if (!isStorageApiEnabled(env)) return { arm: false, reason: 'storage_api_disabled' }
  if (!(env.MN_STORAGE_API_SCOPE ?? '').trim()) return { arm: false, reason: 'no_storage_scope' }
  return { arm: true, joinWebUrl }
}

// ===========================================================================
// POLLER CORE (I/O injected; still Electron-free)
// ===========================================================================

export interface CallSignalHttpResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type CallSignalHttp = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string }
) => Promise<CallSignalHttpResponse>

export type CallSignalLog = (
  level: 'info' | 'warn',
  message: string,
  context?: Record<string, unknown>
) => void

export type CallSignalPollerStatus =
  | 'idle'
  | 'registering'
  | 'retry_pending'
  | 'polling'
  | 'dormant'
  | 'stopped'

export interface CallSignalPollerDeps {
  actions: CallSignalActions
  joinWebUrl: string
  scheduledEndUtc: string
  apiBase: string
  http: CallSignalHttp
  identityHeaders: () => Promise<Record<string, string>>
  timers: CallSignalTimers
  log: CallSignalLog
  graceMs?: number
  pollIntervalMs?: number
  retryDelayMs?: number
}

export interface CallSignalPoller {
  readonly machine: CallSignalMachine
  /** Register the watch, then start polling. Resolves once the first
   *  registration attempt has settled; the retry (if any) runs on the timer. */
  start(): Promise<void>
  /** Cancel timers, dispose the machine, best-effort DELETE the watch. */
  stop(): void
  getStatus(): CallSignalPollerStatus
}

/**
 * Registration → poll → teardown, with every failure mode collapsing to
 * "dormant" or "skip this tick" (D7).
 *
 * Relay status codes are all handled identically but logged distinctly:
 * 503 = storage unavailable, 502 = Graph trouble, 422 = client bug, 0 = the
 * request never completed (backend down, timeout, token acquisition failed).
 */
export function createCallSignalPoller(deps: CallSignalPollerDeps): CallSignalPoller {
  const pollIntervalMs = deps.pollIntervalMs ?? CALL_SIGNAL_POLL_INTERVAL_MS
  const retryDelayMs = deps.retryDelayMs ?? CALL_SIGNAL_REGISTRATION_RETRY_MS
  const machine = createCallSignalMachine(
    deps.actions,
    deps.graceMs ?? CALL_SIGNAL_GRACE_MS,
    deps.timers
  )
  const watchUrl = `${deps.apiBase}/api/v1/call-watch`
  const signalsUrl = `${watchUrl}/signals`

  let status: CallSignalPollerStatus = 'idle'
  let timer: unknown = null
  let registrationAttempts = 0

  const clearTimer = (): void => {
    if (timer === null) return
    deps.timers.clearTimeout(timer)
    timer = null
  }

  /** Never throws: a transport failure surfaces as null (logged as status 0). */
  const request = async (
    method: string,
    url: string,
    body?: string
  ): Promise<CallSignalHttpResponse | null> => {
    try {
      const headers: Record<string, string> = { ...(await deps.identityHeaders()) }
      if (body !== undefined) headers['content-type'] = 'application/json'
      return await deps.http(url, { method, headers, body })
    } catch {
      return null
    }
  }

  const schedulePoll = (): void => {
    if (status !== 'polling') return
    timer = deps.timers.setTimeout(() => {
      timer = null
      void pollOnce().catch(() => undefined)
    }, pollIntervalMs)
  }

  const pollOnce = async (): Promise<void> => {
    const response = await request('GET', signalsUrl)
    if (status !== 'polling') return // disarmed while the request was in flight
    if (!response || !response.ok) {
      deps.log('warn', '[call-signals] signal poll failed', { status: response?.status ?? 0 })
      schedulePoll()
      return
    }
    let payload: unknown = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    if (status !== 'polling') return
    if (!isCallSignalsPayload(payload)) {
      deps.log('warn', '[call-signals] signal poll returned an unexpected payload', {
        status: response.status
      })
      schedulePoll()
      return
    }
    const signals = parseCallSignals(payload)
    try {
      // The machine guards its own actions, so this should never throw —
      // defence in depth so that no future change can kill the poll loop.
      if (signals.length > 0) machine.ingest(signals)
    } catch {
      // Status only: an exception message could carry anything.
      deps.log('warn', '[call-signals] signal ingest failed', { status: response.status })
    } finally {
      // Polling continues until disarm even once the machine is done: the stop
      // it just requested comes back through the renderer, and Task 13 disarms
      // on `recording:stopped` / error. Extra ticks are cheap and idempotent.
      schedulePoll()
    }
  }

  const register = async (): Promise<void> => {
    registrationAttempts += 1
    status = 'registering'
    const response = await request(
      'POST',
      watchUrl,
      JSON.stringify({ join_web_url: deps.joinWebUrl, scheduled_end_utc: deps.scheduledEndUtc })
    )
    if (status !== 'registering') return // stopped while the request was in flight
    if (response && response.ok) {
      status = 'polling'
      deps.log('info', '[call-signals] call watch registered', { status: response.status })
      schedulePoll()
      return
    }
    const willRetry = registrationAttempts < 2
    deps.log('warn', '[call-signals] call watch registration failed', {
      status: response?.status ?? 0,
      willRetry
    })
    if (!willRetry) {
      // Dormant for this recording — the scheduled auto-stop still applies.
      status = 'dormant'
      return
    }
    status = 'retry_pending'
    timer = deps.timers.setTimeout(() => {
      timer = null
      void register().catch(() => undefined)
    }, retryDelayMs)
  }

  return {
    machine,

    async start(): Promise<void> {
      if (status !== 'idle') return
      await register()
    },

    stop(): void {
      clearTimer()
      // A registration that failed client-side may still have landed, so any
      // poller that got as far as a POST cleans up after itself. A second
      // stop() is inert: the watch is already deleted (or already orphaned).
      const mayHaveWatch = status !== 'idle' && status !== 'stopped'
      status = 'stopped'
      machine.dispose()
      if (!mayHaveWatch) return
      void (async () => {
        const response = await request('DELETE', watchUrl)
        if (!response || !response.ok) {
          deps.log('warn', '[call-signals] call watch delete failed', {
            status: response?.status ?? 0
          })
        }
      })().catch(() => {
        // Best effort: an orphaned watch expires server-side (spec D3).
      })
    },

    getStatus: () => status
  }
}
