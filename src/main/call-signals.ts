/**
 * Call-signal runtime layer (meeting-call-events, spec D5/D6/D7/D9).
 *
 * While an auto-recording runs, the Storage API watches the user's Teams call
 * through Graph and reduces the raw notifications to three signals scoped to
 * that one user: `recorder_left`, `recorder_rejoined`, `call_ended`. This
 * module polls those signals through the local backend relay and turns them
 * into pause / grace / resume / stop decisions.
 *
 * The state machine and the poller core live in `./call-signals-core`, which
 * is deliberately Electron-free so the verify harness can bundle it under
 * plain Node. THIS file is the only Electron-adjacent half: it builds the real
 * dependencies (MSAL token → storage identity headers, `electron-log`,
 * `fetch`) and owns the single active poller. Everything from the core is
 * re-exported, so Task 13 imports only `./call-signals`.
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

import { createHash } from 'node:crypto'
import type { ActiveRecording } from './recording-state'
import { storageIdentityHeaders } from './storage-api-identity'
import { getCurrentUserEmail, getCurrentUserOid, getStorageApiAccessToken } from './auth-session'
import { logger } from './logger'
import {
  CALL_SIGNAL_GRACE_MS,
  CALL_SIGNAL_POLL_INTERVAL_MS,
  createCallSignalPoller,
  shouldArmCallSignals,
  type CallSignalActions,
  type CallSignalHttp,
  type CallSignalLog,
  type CallSignalMachine,
  type CallSignalPoller,
  type CallSignalTimers,
  type CallSignalToastAction
} from './call-signals-core'

// The machine, the poller core, the wire translation, and the arm gate all
// belong to the pure core; re-exported so consumers have one import surface.
export * from './call-signals-core'

const DEFAULT_API_BASE = 'http://127.0.0.1:8787'
/**
 * Default (poll) budget — kept under the poll interval so ticks can never
 * stack up. Mutating requests (register/delete) override this via
 * `init.timeoutMs` (CALL_SIGNAL_MUTATION_TIMEOUT_MS in the core): live smoke
 * 13 Aug 2026 showed registration legitimately taking >8 s end to end.
 */
const CALL_SIGNAL_REQUEST_TIMEOUT_MS = 8_000
/**
 * `getStorageApiAccessToken` forces a refresh on every call (deliberate, for
 * issuer-version correctness), so caching the minted headers keeps a 10s poll
 * from hammering Entra — and the main log — six times a minute. Only a
 * successful mint is cached: a token-less result (signed out, MSAL not
 * configured yet) is retried on the next tick rather than locking the poller
 * into five minutes of unauthenticated requests.
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
// Exactly one poller can be live, mirroring the recording state machine: it
// permits a single active recording at a time (`recording-state.ts`), and
// `armCallSignals` disarms any predecessor before creating the next one — so a
// second arm can never leave two pollers racing over the same watch (the
// Storage API keeps one watch per user OID anyway, spec D2).
let activePoller: CallSignalPoller | null = null

const defaultLog: CallSignalLog = (level, message, context) => {
  if (level === 'warn') logger().warn(message, context ?? {})
  else logger().info(message, context ?? {})
}

const defaultHttp: CallSignalHttp = async (url, init) => {
  const controller = new AbortController()
  const deadline = setTimeout(
    () => controller.abort(),
    init.timeoutMs ?? CALL_SIGNAL_REQUEST_TIMEOUT_MS
  )
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
    // Never cache a token-less mint: the relay would reject every request for
    // the whole TTL, and the sign-in that fixes it can land at any moment.
    if (token) {
      cached = headers
      cachedAtMs = nowMs
    }
    return headers
  }
}

/**
 * Register the real control actions (and any overrides). Task 13 calls this
 * once during main-process startup, before any recording can start.
 *
 * Passing `null` clears the configuration: an already-armed poller keeps
 * running (disarm it explicitly), but every later `armCallSignals` declines
 * with `reason: 'not_configured'` and the feature stays dormant. That is the
 * teardown/test path, not a kill switch — use `MN_CALL_SIGNALS_ENABLED=false`
 * for that (D8).
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
    // Task 8 wires the real mode selection (attach when the registrar already
    // parked a watch for this meeting) and hoists the hash into a shared
    // exported helper. Until then, register mode preserves today's behaviour
    // byte for byte, and the hash (sha256 hex of the joinWebUrl, spec E2)
    // targets the per-meeting relay routes that replaced the parameterless
    // ones in the local backend.
    mode: 'register',
    joinUrlHash: createHash('sha256').update(decision.joinWebUrl).digest('hex'),
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
  void activePoller.start().catch(() => {
    log('warn', '[call-signals] poller start failed', { status: 0 })
  })
}

/** Stop polling, dispose the machine, and best-effort delete the watch.
 *  Safe when never armed.
 *
 *  Task 13, two things to know:
 *
 *  1. If the recording is stopping during a grace window, close the paused
 *     toast FIRST — `getActiveCallSignalMachine()?.isPausedToastVisible()` —
 *     because `dispose()` fires no actions and the sticky toast would survive
 *     the recording otherwise.
 *  2. Disarming while a terminal transition is mid-flight (only reachable if
 *     an injected action re-enters synchronously) stands that transition's
 *     remaining effects down, so a `stop()` may never be issued. Never treat
 *     "I disarmed" as "the recording was stopped": recording-ipc's own stop
 *     path is the guard, and this module only ever adds an earlier stop. */
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
