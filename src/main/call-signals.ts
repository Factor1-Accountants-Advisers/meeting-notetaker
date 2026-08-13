/**
 * Call-signal state machine + storage poller (meeting-call-events, spec
 * D5/D6/D7/D9).
 *
 * While an auto-recording runs, the Storage API watches the user's Teams call
 * through Graph and reduces the raw notifications to three signals scoped to
 * that one user: `recorder_left`, `recorder_rejoined`, `call_ended`. This
 * module polls those signals through the local backend relay and turns them
 * into pause / grace / resume / stop decisions.
 *
 * The file has three layers, deliberately separated:
 *
 *   1. PURE CORE — the state machine, the wire translation, and the arm gate.
 *      No Electron, no auth, no network, no ambient clock: every effect is
 *      injected. `scripts/verify-call-signals.ts` exercises this layer under
 *      plain Node with a fake timer queue.
 *   2. POLLER CORE — `createCallSignalPoller`, which owns registration,
 *      polling, and teardown but takes its HTTP, identity, timers, and logger
 *      by injection. Also covered by the harness, with fakes.
 *   3. RUNTIME LAYER — `armCallSignals` / `disarmCallSignals`, which build the
 *      real dependencies (MSAL token, storage identity headers, electron-log,
 *      `fetch`) and hold the single active poller. Only this layer imports
 *      Electron-adjacent modules.
 *
 * Task 13 owns the wiring: it registers the control actions
 * (`sendTrayRecordingControl`, `sendAutoStopRequest`, `isRecordingPaused`, the
 * paused toast) via `configureCallSignals`, arms on auto-start, disarms on
 * stop/error, and routes the toast verbs and manual-resume hook back in
 * through `callSignalsToastAction` / `callSignalsManualResume`.
 *
 * Privacy: desktop logs carry status codes and state only — never join URLs,
 * tokens, emails, OIDs, or response bodies (same rule as `hostGateLogContext`).
 */

// ---------------------------------------------------------------------------
// Imports — layer 1/2 (pure core) may only use Electron-free helpers.
// `storage-api-identity` is pure header/flag logic; `recording-state` is a
// type-only import. Everything below the "RUNTIME LAYER" banner is layer 3.
// ---------------------------------------------------------------------------
import type { ActiveRecording } from './recording-state'
import { isStorageApiEnabled, storageIdentityHeaders } from './storage-api-identity'
// Layer 3 only (Electron-adjacent):
import { getCurrentUserEmail, getCurrentUserOid, getStorageApiAccessToken } from './auth-session'
import { logger } from './logger'

// ===========================================================================
// LAYER 1 — PURE CORE
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

/** Control surfaces the machine drives. Task 13 supplies the real ones. */
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
  /** Teardown: cancel the grace timer, fire nothing. */
  dispose(): void
  getState(): CallSignalState
  /** True while the machine believes its paused toast is on screen. Task 13's
   *  disarm path can use this to close a toast left over from a grace window
   *  that ended for some other reason (`dispose()` fires no actions by design,
   *  because it also runs on teardown paths where the window may be gone). */
  isPausedToastVisible(): boolean
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

  const cancelGrace = (): void => {
    if (graceTimer === null) return
    timers.clearTimeout(graceTimer)
    graceTimer = null
  }

  const closeToast = (): void => {
    toastVisible = false
    actions.closePausedToast()
  }

  /** Terminal transition: grace expiry, `call_ended`, or "Upload now". */
  const finish = (): void => {
    cancelGrace()
    closeToast()
    signalInitiatedPause = false
    state = 'done'
    actions.stop()
  }

  /** Leave grace and keep recording. `resume` is false when the pause was the
   *  user's own (D6) or when the user has already resumed by hand. */
  const backToWatching = (resume: boolean): void => {
    cancelGrace()
    closeToast()
    state = 'watching'
    signalInitiatedPause = false
    if (resume) actions.resume()
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
        if (!actions.isPaused()) {
          actions.pause()
          signalInitiatedPause = true
        }
        state = 'grace'
        graceTimer = timers.setTimeout(onGraceExpired, graceMs)
        toastVisible = true
        actions.showPausedToast()
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
    },

    getState: () => state,
    isPausedToastVisible: () => toastVisible
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
// LAYER 2 — POLLER CORE (I/O injected; still Electron-free)
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
      void pollOnce()
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
    if (signals.length > 0) machine.ingest(signals)
    // Polling continues until disarm even once the machine is done: the stop
    // it just requested comes back through the renderer, and Task 13 disarms
    // on `recording:stopped` / error. Extra ticks are cheap and idempotent.
    schedulePoll()
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
      void register()
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

// ===========================================================================
// LAYER 3 — RUNTIME (Electron-adjacent: MSAL identity, electron-log, fetch)
// ===========================================================================

const DEFAULT_API_BASE = 'http://127.0.0.1:8787'
/** Kept under the poll interval so ticks can never stack up. */
const CALL_SIGNAL_REQUEST_TIMEOUT_MS = 8_000
/**
 * `getStorageApiAccessToken` forces a refresh on every call (deliberate, for
 * issuer-version correctness), so caching the minted headers keeps a 10s poll
 * from hammering Entra — and the main log — six times a minute.
 */
const IDENTITY_HEADER_TTL_MS = 5 * 60_000

/** Dependencies Task 13 injects once at startup. */
export interface CallSignalRuntimeDeps {
  /** Required: the real control surfaces (recording-ipc + toast). */
  actions: CallSignalActions
  env?: NodeJS.ProcessEnv
  apiBase?: string
  http?: CallSignalHttp
  identityHeaders?: () => Promise<Record<string, string>>
  timers?: CallSignalTimers
  log?: CallSignalLog
}

let runtimeDeps: CallSignalRuntimeDeps | null = null
let activePoller: CallSignalPoller | null = null

const defaultLog: CallSignalLog = (level, message, context) => {
  if (level === 'warn') logger().warn(message, context ?? {})
  else logger().info(message, context ?? {})
}

const defaultHttp: CallSignalHttp = async (url, init) => {
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), CALL_SIGNAL_REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: controller.signal
    })
    return {
      ok: response.ok,
      status: response.status,
      json: async () => (await response.json()) as unknown
    }
  } finally {
    clearTimeout(deadline)
  }
}

function createIdentityHeaderProvider(scope: string): () => Promise<Record<string, string>> {
  let cached: Record<string, string> | null = null
  let cachedAtMs = 0
  return async () => {
    const nowMs = Date.now()
    if (cached && nowMs - cachedAtMs < IDENTITY_HEADER_TTL_MS) return cached
    const token = await getStorageApiAccessToken(scope)
    const headers = storageIdentityHeaders({
      email: getCurrentUserEmail(),
      oid: getCurrentUserOid(),
      accessToken: token ?? undefined
    })
    cached = headers
    cachedAtMs = nowMs
    return headers
  }
}

/**
 * Register the real control actions (and any overrides). Task 13 calls this
 * once during main-process startup, before any recording can start.
 */
export function configureCallSignals(deps: CallSignalRuntimeDeps | null): void {
  runtimeDeps = deps
}

/**
 * Arm the call-signal poller for an auto-recording. Safe to call for every
 * recording: the gate (`shouldArmCallSignals`) silently declines manual
 * recordings, recordings without a join URL, and both kill switches.
 */
export function armCallSignals(
  recording: ActiveRecording,
  deps: CallSignalRuntimeDeps | null = runtimeDeps
): void {
  disarmCallSignals()
  const log = deps?.log ?? defaultLog
  if (!deps) {
    log('warn', '[call-signals] not armed', { reason: 'not_configured' })
    return
  }
  const env = deps.env ?? process.env
  const decision = shouldArmCallSignals(recording, env)
  if (!decision.arm) {
    log('info', '[call-signals] not armed', { reason: decision.reason })
    return
  }
  const scope = (env.MN_STORAGE_API_SCOPE ?? '').trim()
  activePoller = createCallSignalPoller({
    actions: deps.actions,
    joinWebUrl: decision.joinWebUrl,
    scheduledEndUtc: recording.endTimeUtc,
    apiBase: deps.apiBase ?? env.MN_API_BASE ?? DEFAULT_API_BASE,
    http: deps.http ?? defaultHttp,
    identityHeaders: deps.identityHeaders ?? createIdentityHeaderProvider(scope),
    timers: deps.timers ?? { setTimeout, clearTimeout },
    log
  })
  log('info', '[call-signals] arming call-signal poller', {
    eventId: recording.eventId,
    graceMs: CALL_SIGNAL_GRACE_MS,
    pollIntervalMs: CALL_SIGNAL_POLL_INTERVAL_MS
  })
  void activePoller.start()
}

/** Stop polling, dispose the machine, and best-effort delete the watch.
 *  Safe when never armed. */
export function disarmCallSignals(): void {
  if (!activePoller) return
  activePoller.stop()
  activePoller = null
}

/** The machine behind the active poller, if any — Task 13 routes the toast
 *  verbs and the manual-resume hook through the helpers below. */
export function getActiveCallSignalMachine(): CallSignalMachine | null {
  return activePoller?.machine ?? null
}

/** Call when `recording:paused-changed` reports `paused === false` (D6). */
export function callSignalsManualResume(): void {
  getActiveCallSignalMachine()?.onManualResume()
}

/** Call from the `second-instance` toast-verb switch in index.ts. */
export function callSignalsToastAction(action: CallSignalToastAction): void {
  getActiveCallSignalMachine()?.onToastAction(action)
}
