/**
 * Call-signal state machine + poller core (meeting-call-events, spec
 * D5/D6/D7/D9 + per-meeting amendment E5) — the Electron-free half of the
 * feature.
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
/**
 * Watch registration/deletion traverse relay → storage-api → AAD token →
 * Graph subscription create → Graph's synchronous validation callback to our
 * webhook (which may cold-start the Function App). Live smoke 13 Aug 2026:
 * that chain exceeded the 8 s poll timeout and made the poller go dormant
 * even though the server side succeeded — so mutating requests carry their
 * own, much longer budget. Polls stay on the short default so ticks can
 * never stack.
 */
export const CALL_SIGNAL_MUTATION_TIMEOUT_MS = 30_000

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
  /** Mark seqs as consumed WITHOUT acting on them — the E5 baseline drain.
   *
   *  When the poller attaches to a watch that pre-dates the recording
   *  (registered at calendar discovery), the store may already hold signals
   *  from before recording started — the organizer popping into the call to
   *  check a camera and leaving, even a `call_ended` from an earlier
   *  incarnation of the call. Acting on those would pause or stop a
   *  brand-new recording, so the first successful poll feeds them here
   *  instead of `ingest`. Only the seen-set is touched: no transition runs,
   *  no timer arms, no toast shows. No-op once the machine is `done`. */
  primeSeen(signals: CallSignal[]): void
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

    primeSeen(signals: CallSignal[]): void {
      // The `done` guard mirrors `ingest` for consistency; a terminal machine
      // ignores everything either way. Deliberately NO transition logic here —
      // priming only ever grows the seen-set, so `ingest`'s dedupe does the
      // actual discarding when the relay replays these seqs on later polls.
      if (state === 'done') return
      for (const signal of signals) seen.add(signal.seq)
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

/** Shape check for a `GET /call-watch/{join_url_hash}/signals` body. */
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

export type CallSignalEnvGateFailReason =
  | 'feature_disabled'
  | 'storage_api_disabled'
  | 'no_storage_scope'

export type CallSignalEnvGateResult =
  | { ok: true }
  | { ok: false; reason: CallSignalEnvGateFailReason }

/**
 * The three env-only checks that also appear in `shouldArmCallSignals`: the
 * desktop kill switch, the storage-API kill switch, and the storage scope.
 * Exists for `createCallWatchTransport` (`call-signals.ts`, consumed by the
 * Task 9 registrar), which has no recording to gate on — the registrar runs
 * at calendar discovery, before any recording exists.
 *
 * Deliberately NOT reused by `shouldArmCallSignals` itself: composing the two
 * would change ITS reason precedence for a recording that fails both an env
 * check and a recording-shape check (see that function's doc). The three
 * `reason` values below intentionally shadow three of
 * `CallSignalArmSkipReason`'s five — keep both lists in sync by hand if
 * either gate grows a new check.
 */
export function callSignalsEnvGate(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): CallSignalEnvGateResult {
  if ((env.MN_CALL_SIGNALS_ENABLED ?? '').trim().toLowerCase() === 'false') {
    return { ok: false, reason: 'feature_disabled' }
  }
  if (!isStorageApiEnabled(env)) return { ok: false, reason: 'storage_api_disabled' }
  if (!(env.MN_STORAGE_API_SCOPE ?? '').trim()) return { ok: false, reason: 'no_storage_scope' }
  return { ok: true }
}

/**
 * Whether this recording gets a call watch. Every "no" is silent and leaves
 * today's behaviour untouched (D7/D8) — the scheduled auto-stop and the T-5
 * Extend toast are unaffected either way.
 *
 * Reason precedence is deliberately NOT `callSignalsEnvGate` followed by the
 * recording checks: field triage reads `reason` to diagnose a single
 * recording, so a manual recording on a machine with no storage scope must
 * still report `not_auto_recording` (the actionable cause for THIS
 * recording), not `no_storage_scope` (a machine-wide condition that would be
 * true for every recording, auto or manual). Kept inline, byte-for-byte the
 * original order, rather than composed from `callSignalsEnvGate` — the two
 * storage checks are unreachable until after the recording-shape checks.
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
  init: {
    method: string
    headers: Record<string, string>
    body?: string
    /** Per-request budget; absent = the transport's short poll default. */
    timeoutMs?: number
  }
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

/**
 * How the poller acquires its watch (per-meeting amendment, spec E5):
 *
 * - `'attach'`: the watch already exists server-side — the calendar-driven
 *   registrar POSTed it at meeting discovery, possibly hours ago (E1). The
 *   poller skips registration and starts with an immediate baseline poll
 *   whose signals are drained via `machine.primeSeen`, not acted on.
 * - `'register'`: today's fallback for when the registrar never managed to
 *   park a watch — POST first (with the single-retry/dormant semantics of
 *   D7), then poll. No baseline drain: a fresh registration replaces the
 *   watch server-side, so a brand-new subscription generation has no prior
 *   signals to discard.
 */
export type CallSignalPollerMode = 'register' | 'attach'

export interface CallSignalPollerDeps {
  actions: CallSignalActions
  mode: CallSignalPollerMode
  joinWebUrl: string
  /** sha256 hex of `joinWebUrl` (spec E2) — the per-meeting path segment for
   *  the signals GET and the watch DELETE. Derived by the runtime layer so the
   *  core stays free of `node:crypto` and the harness can pin exact URLs. */
  joinUrlHash: string
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
  /** Acquire the watch, then start polling. In `'register'` mode: resolves
   *  once the first registration attempt has settled; the retry (if any) runs
   *  on the timer. In `'attach'` mode: resolves once the immediate baseline
   *  poll has settled (success or not — a failed baseline retries on the
   *  normal poll interval). */
  start(): Promise<void>
  /** Cancel timers, dispose the machine, best-effort DELETE the watch. */
  stop(): void
  getStatus(): CallSignalPollerStatus
}

/**
 * Watch acquisition (register or attach, see `CallSignalPollerMode`) → poll →
 * teardown, with every failure mode collapsing to "dormant" or "skip this
 * tick" (D7).
 *
 * Baseline drain (E5): in attach mode, the FIRST poll that both completes and
 * parses feeds its signals to `machine.primeSeen` instead of `ingest` — those
 * signals were stored before we ever managed to look, so they predate the
 * recording by construction and must not pause/stop it. Every poll after that
 * baseline ingests normally. A failed first poll does not count: the next
 * successful one still primes.
 *
 * Known accepted race (E5): a GENUINE `recorder_left` (or `call_ended`) that
 * lands in the store between recording start and the first successful poll is
 * indistinguishable from pre-recording noise and gets drained with it. If the
 * recorder never returns, no leave signal ever fires for that departure — the
 * grace window never opens — and the scheduled auto-stop remains the stop
 * path, exactly as for a machine with the feature dormant. The exposure is at
 * most one failed-poll stretch plus the seconds before the baseline lands.
 *
 * The reverse race is equally inherent to E5: a signal generated BEFORE
 * recording started but whose webhook delivery to the store is delayed past
 * the baseline poll gets ingested as if it were live, and can pause a
 * brand-new recording. This is self-healing — a genuine late rejoin resolves
 * it within the grace window, and a lone late leave surfaces the normal
 * cancellable "recording paused" toast well before the 60s auto-stop fires.
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
  // POST registers against the collection route; the signals GET and the
  // watch DELETE are per-meeting (spec E2/E6 — hash, not raw URL, so join
  // URLs stay out of paths and logs).
  const watchUrl = `${deps.apiBase}/api/v1/call-watch`
  const meetingUrl = `${watchUrl}/${deps.joinUrlHash}`
  const signalsUrl = `${meetingUrl}/signals`

  let status: CallSignalPollerStatus = 'idle'
  let timer: unknown = null
  let registrationAttempts = 0
  // True once one attach-mode poll has succeeded end to end (E5). Register
  // mode never baselines: it stays false there, and the mode check in
  // `pollOnce` keeps it inert.
  let baselined = false

  const clearTimer = (): void => {
    if (timer === null) return
    deps.timers.clearTimeout(timer)
    timer = null
  }

  /** Never throws: a transport failure surfaces as null (logged as status 0). */
  const request = async (
    method: string,
    url: string,
    body?: string,
    timeoutMs?: number
  ): Promise<CallSignalHttpResponse | null> => {
    try {
      const headers: Record<string, string> = { ...(await deps.identityHeaders()) }
      if (body !== undefined) headers['content-type'] = 'application/json'
      return await deps.http(url, { method, headers, body, timeoutMs })
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
      if (deps.mode === 'attach' && !baselined) {
        // E5 baseline drain: this is the first poll that both completed and
        // parsed, so everything in it predates the recording. Mark seen, act
        // on nothing. Failed polls never reach this line, which is exactly
        // the retry-until-success semantics the spec asks for.
        if (signals.length > 0) machine.primeSeen(signals)
        baselined = true
        // Count only — never the signals themselves (see module doc).
        deps.log('info', '[call-signals] baseline drained', { drained: signals.length })
      } else if (signals.length > 0) {
        machine.ingest(signals)
      }
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
      JSON.stringify({ join_web_url: deps.joinWebUrl, scheduled_end_utc: deps.scheduledEndUtc }),
      CALL_SIGNAL_MUTATION_TIMEOUT_MS
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
      if (deps.mode === 'attach') {
        // The registrar owns registration; this poller only reads and (on
        // stop) deletes. Straight to polling, and the first poll runs NOW —
        // waiting an interval would widen the E5 race window for no benefit,
        // and the caller gets a settled baseline attempt out of `start()`.
        status = 'polling'
        deps.log('info', '[call-signals] attached to pre-registered call watch', {
          mode: deps.mode
        })
        await pollOnce()
        return
      }
      await register()
    },

    stop(): void {
      clearTimer()
      // Lifecycle ownership follows creation ownership. A fallback `register`
      // poller cleans up the watch it POSTed; an `attach` poller only detaches
      // from the registrar-owned watch so it remains parked for a live meeting.
      const mayHaveOwnedWatch =
        deps.mode === 'register' && status !== 'idle' && status !== 'stopped'
      status = 'stopped'
      machine.dispose()
      if (!mayHaveOwnedWatch) return
      void (async () => {
        const response = await request(
          'DELETE',
          meetingUrl,
          undefined,
          CALL_SIGNAL_MUTATION_TIMEOUT_MS
        )
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
