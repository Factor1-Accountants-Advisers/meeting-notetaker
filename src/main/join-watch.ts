/**
 * Join-triggered recording — runtime half (spec 2026-08-18 J1–J3, J6).
 *
 * Supplies the real effects to the pure engine in `join-watch-core.ts`: the
 * relay transport (the SAME `createCallWatchTransport` the registrar and the
 * attach poller use, so there is one owner of apiBase/http/identity),
 * electron-log, the "Record now" prompt toast, and persistence of "prompted
 * for meeting X" (J3: once per meeting, across restarts). Everything
 * user-facing or network-facing lives here; the core stays harness-testable
 * (`scripts/verify-join-watch.ts` bundles the core alone and asserts it never
 * requires electron).
 *
 * `index.ts` owns the wiring: it constructs the engine only when
 * `MN_AUTO_START_TRIGGER` resolves to `join` (J6), feeds it every sync's
 * decisions, routes the toast's `record-now` verb back in, and lets
 * recording-ipc's join-watch hooks report starts / discards / failed starts.
 *
 * Privacy: logs carry keys, hashes, booleans and counts only — never a join
 * URL, a meeting title, or an email (same rule as `hostGateLogContext`).
 */

import { app, Notification } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createCallWatchTransport,
  isCallSignalsPayload,
  joinUrlHash,
  parseCallSignals,
  type CallWatchTransport
} from './call-signals'
import { evaluateHostOwnership } from './graph/host-gate'
import {
  JOIN_WATCH_PROMPT_LIFETIME_MS,
  createJoinWatchEngine,
  type JoinWatchEngine,
  type JoinWatchMeeting
} from './join-watch-core'
import { logger } from './logger'
import { getRecordingStateMachine, hasPendingAutoStart, sendAutoStartRequest } from './recording-ipc'
import { buildJoinPromptToastXml } from './toast-xml'

export * from './join-watch-core'

/** Persisted-prompt cap: the file only exists to answer "did we already ask
 *  about meeting X" across a restart (J3); a working week of meetings is a
 *  few dozen keys, so 200 is comfortably more than the window it must cover. */
const PROMPTED_KEYS_CAP = 200

let engine: JoinWatchEngine | null = null
/** ONE relay transport for the watcher's lifetime, resolved lazily on the
 *  first poll (a null — not configured yet — is retried, never cached).
 *  `createCallWatchTransport` builds a fresh identity-header provider on
 *  every call, so resolving it per poll would defeat the 5-min header cache
 *  and force an Entra token refresh every 5 s tick. */
let transport: CallWatchTransport | null = null
let promptToast: Notification | null = null
let promptToastTimer: NodeJS.Timeout | null = null
/** The meeting the prompt currently ON SCREEN is about — `record-now` has no
 *  payload of its own (the toast verb is a bare protocol URI), so the accept
 *  path reads the key from here. Set by `showPrompt`, cleared by
 *  `closePrompt` (lifetime timer, accept, start, disarm, dispose), so a stale
 *  Action Center click can never start a DIFFERENT meeting than the one it
 *  was shown for. */
let promptedMeeting: JoinWatchMeeting | null = null

/**
 * "Prompted for meeting X" store: JSON `{ prompted: string[] }` under
 * userData. Best-effort on both ends — an unreadable file is an empty set
 * (the worst case is one extra prompt), and a failed write is logged and
 * ignored (this process still remembers in memory). Never a load-bearing
 * failure: the engine wraps `add` in `safe()` too.
 */
function promptedKeysStore(path: string): { has: (key: string) => boolean; add: (key: string) => void } {
  let keys = new Set<string>()
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { prompted?: unknown }
      keys = new Set(Array.isArray(raw.prompted) ? raw.prompted.filter((k): k is string => typeof k === 'string') : [])
    }
  } catch {
    keys = new Set()
  }
  const persist = (): void => {
    try {
      // Keep the most recent keys only, so the file cannot grow forever.
      const list = [...keys].slice(-PROMPTED_KEYS_CAP)
      keys = new Set(list)
      writeFileSync(path, JSON.stringify({ prompted: list }), 'utf8')
    } catch (err) {
      logger().warn('[join-watch] failed to persist prompted keys', {
        path,
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return {
    has: (key) => keys.has(key),
    add: (key) => {
      keys.add(key)
      persist()
    }
  }
}

/** Dismiss the prompt if one is showing. Safe when none is: called on start,
 *  disarm, accept, dispose, and by the lifetime timer. */
function closePrompt(): void {
  if (promptToastTimer) {
    clearTimeout(promptToastTimer)
    promptToastTimer = null
  }
  const toast = promptToast
  promptToast = null
  promptedMeeting = null
  try {
    toast?.close()
  } catch {
    // Already gone (dismissed by the user or by Windows) — nothing to do.
  }
}

/**
 * J3 prompt: "Meeting X has started — Recording will begin when you join.
 * [Record now]". Same win32-toast / other-platform-notification split as the
 * paused toast in recording-ipc; auto-dismissed after
 * JOIN_WATCH_PROMPT_LIFETIME_MS because `scenario="reminder"` toasts are
 * sticky. `promptedMeeting` is bound only while the toast is on screen: a
 * toast that failed to render has no Action Center entry, so there is
 * nothing a later `record-now` could legitimately refer to.
 */
function showPrompt(meeting: JoinWatchMeeting): void {
  closePrompt()
  if (!Notification?.isSupported?.()) {
    logger().warn('[join-watch] prompt toast unsupported by Electron', { key: meeting.idempotencyKey })
    return
  }
  try {
    promptToast =
      process.platform === 'win32'
        ? new Notification({ toastXml: buildJoinPromptToastXml(meeting.title) })
        : new Notification({
            title: 'Meeting Notetaker',
            body: 'Your meeting has started. Recording will begin when you join.',
            silent: true
          })
    promptToast.show()
    promptedMeeting = meeting
    logger().info('[join-watch] prompt toast requested', { key: meeting.idempotencyKey })
  } catch (err) {
    promptToast = null
    promptedMeeting = null
    logger().warn('[join-watch] prompt toast failed', {
      key: meeting.idempotencyKey,
      message: err instanceof Error ? err.message : String(err)
    })
    return
  }
  promptToastTimer = setTimeout(closePrompt, JOIN_WATCH_PROMPT_LIFETIME_MS)
}

/**
 * Build the engine and start listening. Called once from index.ts, after the
 * registrar exists (its `hasActiveWatch` is truthful from process start) and
 * only when the trigger mode is `join` (J6) — under `calendar` the watcher is
 * never constructed.
 */
export function configureJoinWatch(opts: { hasActiveWatch: (hash: string) => boolean }): void {
  disposeJoinWatch()
  const store = promptedKeysStore(join(app.getPath('userData'), 'join-watch.json'))
  engine = createJoinWatchEngine({
    hasActiveWatch: opts.hasActiveWatch,
    joinUrlHash,
    // Hold one transport (see the module-level note): the identity-header
    // cache inside it is what keeps a 5 s poll from minting a token per tick.
    fetchSignals: async (hash) => {
      const t = (transport ??= createCallWatchTransport())
      if (!t) return null
      try {
        const res = await t.http(`${t.apiBase}/api/v1/call-watch/${hash}/signals`, {
          method: 'GET',
          headers: await t.identityHeaders()
        })
        if (!res.ok) return null
        const payload = await res.json()
        return isCallSignalsPayload(payload) ? parseCallSignals(payload) : null
      } catch {
        return null // unknown, and unknown is never in-call (J2)
      }
    },
    // J2 "already recording something" guard: any state but idle, or an
    // auto-start already handed to the renderer and awaiting its ack.
    isRecordingActive: () => getRecordingStateMachine().getState() !== 'idle' || hasPendingAutoStart(),
    startRecording: (m, trigger) => {
      // The same request the calendar issues (J1), tagged with what started
      // it so the J4 false-start rule can tell a join from a prompt.
      const accepted = sendAutoStartRequest({
        eventId: m.eventId,
        idempotencyKey: m.idempotencyKey,
        startTimeUtc: m.startUtc,
        endTimeUtc: m.endUtc,
        source: 'auto',
        trigger,
        metadata: m.metadata
      })
      // Only an ACCEPTED start retires the prompt: the toast is once-only
      // (J3), so a refused start (renderer busy / not ready) must leave it
      // up for the user to try again.
      if (accepted) closePrompt()
      return accepted
    },
    showPrompt,
    onDisarm: (m) => {
      // A prompt for a meeting that just ended / was cancelled must not
      // linger and start a recording of nothing.
      if (promptedMeeting?.idempotencyKey === m.idempotencyKey) closePrompt()
    },
    promptedKeys: store,
    timers: { setTimeout, clearTimeout },
    now: () => Date.now(),
    log: (level, message, context) =>
      level === 'warn' ? logger().warn(message, context ?? {}) : logger().info(message, context ?? {}),
    isHostOwned: (d, email) => evaluateHostOwnership(d, email).allowed
  })
  logger().info('[join-watch] configured')
}

/** Every calendar sync's unfiltered decisions (the registrar's feed). */
export function handleJoinWatchSyncDecisions(
  decisions: Parameters<JoinWatchEngine['handleSyncDecisions']>[0],
  signedInEmail?: string
): void {
  engine?.handleSyncDecisions(decisions, signedInEmail)
}

/** The prompt's "Record now" (J3), routed from the argv toast handler. */
export function joinWatchPromptAccepted(): void {
  const m = promptedMeeting
  closePrompt()
  if (!m) {
    logger().info('[join-watch] record-now with no prompted meeting; ignored')
    return
  }
  engine?.acceptPrompt(m.idempotencyKey)
}

/** A discarded false start (J4): the meeting goes back to armed. */
export function joinWatchRecordingDiscarded(key: string): void {
  engine?.rearm(key)
}

/** An accepted start that never became a recording (renderer ack timed out,
 *  or errored before acking): the engine believed `recording`, so re-arm and
 *  let the next poll / prompt decide again. */
export function joinWatchRecordingStartFailed(key: string): void {
  // The engine's own rearm line says "discarded false start"; say what
  // actually happened here so the field log is truthful.
  logger().info('[join-watch] start failed before ack; re-arming', { key })
  engine?.rearm(key)
}

/** The renderer acked a start for `key` (ours or manual): step aside. */
export function joinWatchRecordingStarted(key: string): void {
  engine?.noteRecordingStarted(key)
}

export function disposeJoinWatch(): void {
  closePrompt()
  engine?.dispose()
  engine = null
  transport = null
}
