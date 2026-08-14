/**
 * Call-watch registrar core (per-meeting amendment, spec E1/E3/E4) — the
 * Electron-free half of the calendar-driven watch registrar.
 *
 * The registrar parks a Graph call watch for every eligible auto-record
 * meeting AT DISCOVERY (E1), because a `meetingCallEvents` subscription only
 * delivers for calls that start after it exists — a watch registered at
 * recording start silently misses any call with early joiners (root cause,
 * confirmed live 13–14 Aug 2026). This file holds the pure reconciliation
 * planner and the engine that executes its plan; `call-watch-registrar.ts`
 * adds the runtime layer (real transport via `createCallWatchTransport`,
 * `joinUrlHash`, electron-log) so Task 10 imports only that file.
 *
 * Discipline, same as `call-signals-core.ts`: nothing here may import
 * Electron, MSAL, or `electron-log`, or reach the network — HTTP, hashing,
 * clock, and logging all arrive by injection, which keeps
 * `scripts/verify-call-watch-registrar.ts` a plain-Node harness whose bundle
 * asserts those needles are absent. One deliberate extension to the sibling's
 * rule: the state-file persistence lives HERE, on `node:fs` directly, rather
 * than behind an injection seam. `node:fs` is plain-Node-safe (the poison the
 * discipline exists to keep out is the Electron runtime), and the tolerance
 * rules below — corrupt/missing file must read as empty, never throw — are
 * product behaviour the harness has to pin against the real filesystem, not
 * against a fake that cannot corrupt.
 *
 * Privacy: registrar logs carry counts, statuses, and reasons only — never
 * join URLs, join-URL hashes, tokens, emails, or OIDs (same rule as
 * `hostGateLogContext`). The hash is the server-side ADDRESS of a watch, so
 * a logged hash would let anyone with log access poll that meeting's signals.
 */

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { GraphEventDecision } from './graph/types'
import { evaluateHostGate } from './graph/host-gate'
import {
  CALL_SIGNAL_MUTATION_TIMEOUT_MS,
  readJoinWebUrl,
  type CallSignalHttp,
  type CallSignalLog
} from './call-signals-core'

// ===========================================================================
// State shapes + the pure reconciliation planner (spec E1/E3/E4)
// ===========================================================================

/**
 * At most this many watches per user, soonest-first (spec E3). Mirrors the
 * server-side invariant (POST returns 409 `watch_limit` beyond it): the
 * client-side copy is a SCHEDULING POLICY — it decides which meetings to try
 * first — while the server's is the enforcement. Keeping the two equal means
 * a healthy registrar never sees the 409 at all; if they ever drift, the 409
 * path below degrades gracefully (not stored, retried next sync).
 */
export const REGISTRAR_CAP = 5

export interface RegistrarWatch {
  joinWebUrl: string
  /** sha256 hex of `joinWebUrl` (spec E2) — the per-meeting server-side
   *  address, used for the DELETE route and for `hasActiveWatch` lookups. */
  joinUrlHash: string
  startUtc: string
  scheduledEndUtc: string
  /** From the registration response, when the server offered one. Stored for
   *  observability; nothing client-side keys off it today. */
  subscriptionExpiresUtc?: string
}

/** Keyed by the decision's `idempotencyKey ?? eventId` — the same identity
 *  the auto-record scheduler uses, so one meeting is one entry across
 *  reschedules. */
export interface RegistrarState {
  watches: Record<string, RegistrarWatch>
}

export interface RegistrarActions {
  register: Array<{ key: string; watch: RegistrarWatch }>
  remove: Array<{ key: string; joinUrlHash: string }>
}

function decisionKey(decision: GraphEventDecision): string {
  return decision.idempotencyKey ?? decision.eventId
}

function parseUtcMs(value: string | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

interface RegistrarCandidate {
  key: string
  joinWebUrl: string
  startUtc: string
  startMs: number
  scheduledEndUtc: string
}

/**
 * Reconcile the tracked-watch state against one calendar sync's decisions
 * (spec E1/E3/E4). Pure: the caller supplies the clock and the hash
 * derivation. `hash` is a parameter rather than an import so this file stays
 * free of `node:crypto` and the runtime's `joinUrlHash` remains the single
 * derivation authority (the harness pins that the two agree by recomputing).
 *
 * Rules, in evaluation order:
 *
 * 1. CANDIDATES — a decision qualifies for a watch when it is a `candidate`
 *    with reason `eligible` OR `not_due_yet` (E1: `not_due_yet` is the whole
 *    point — registration happens hours before the meeting is due), carries a
 *    join URL, has parseable start/end with the end still in the future, and
 *    passes the host gate (IN-67: only meetings the signed-in user organizes
 *    are auto-recorded, so only those deserve a subscription).
 *
 * 2. REMOVE — a tracked watch is removed when its key shows up in THIS sync
 *    as `excluded` (cancellation, decline, …) or its STORED scheduled end has
 *    passed (the meeting is over; recording stop usually deleted the watch
 *    already via `noteWatchDeleted`, this catches the never-recorded rest).
 *    A tracked meeting merely ABSENT from the decisions is NOT removed:
 *    delta syncs only carry changed events, so absence means "unchanged",
 *    never "gone". A stored end that no longer parses is treated as ended —
 *    it could never become past on its own, and dropping it is the only way
 *    that slot ever frees.
 *
 * 3. RE-REGISTER (E4) — key tracked AND a live candidate, but `startUtc`,
 *    the scheduled end, or the join URL changed: emit a remove for the OLD
 *    stored hash plus a fresh register. Delete-then-create is required
 *    because the Graph subscription's `expirationDateTime` derives from
 *    `scheduled_end_utc`, and a regenerated join URL changes the watch's
 *    server-side address entirely.
 *
 * 4. ADMIT — pending registrations (new + re-registers) sort by `startUtc`
 *    ascending and admit while `(tracked - removed + admitted) < REGISTRAR_CAP`
 *    (E3 soonest-first). The rest simply wait: they stay untracked, so a
 *    later sync pass re-plans them once a slot frees. A re-register always
 *    fits at a full cap in isolation — its own removal freed a slot — but
 *    competes on start time like everything else.
 */
export function planRegistrarActions(
  state: RegistrarState,
  decisions: GraphEventDecision[],
  now: Date,
  signedInEmail: string | undefined,
  hash: (joinWebUrl: string) => string
): RegistrarActions {
  const nowMs = now.getTime()

  // Last-wins on duplicate keys, matching how a delta feed supersedes itself.
  const decisionsByKey = new Map<string, GraphEventDecision>()
  for (const decision of decisions) decisionsByKey.set(decisionKey(decision), decision)

  const candidates = new Map<string, RegistrarCandidate>()
  for (const decision of decisionsByKey.values()) {
    if (decision.status !== 'candidate') continue
    if (decision.reason !== 'eligible' && decision.reason !== 'not_due_yet') continue
    // Same reader as the arm gate, so the registrar and the recording-start
    // path can never disagree about whether a meeting has a join URL.
    const joinWebUrl = readJoinWebUrl(decision.metadata)
    if (!joinWebUrl) continue
    const { startUtc, endUtc } = decision.logContext
    if (!startUtc || !endUtc) continue
    const startMs = parseUtcMs(startUtc)
    const endMs = parseUtcMs(endUtc)
    if (startMs === null || endMs === null || endMs <= nowMs) continue
    if (!evaluateHostGate(decision, signedInEmail).allowed) continue
    candidates.set(decisionKey(decision), {
      key: decisionKey(decision),
      joinWebUrl,
      startUtc,
      startMs,
      scheduledEndUtc: endUtc
    })
  }

  const remove: RegistrarActions['remove'] = []
  const removedKeys = new Set<string>()
  for (const [key, watch] of Object.entries(state.watches)) {
    const decision = decisionsByKey.get(key)
    const excluded = decision?.status === 'excluded'
    const endMs = parseUtcMs(watch.scheduledEndUtc)
    const ended = endMs === null || endMs <= nowMs
    if (excluded || ended) {
      remove.push({ key, joinUrlHash: watch.joinUrlHash })
      removedKeys.add(key)
    }
  }

  const pending: RegistrarCandidate[] = []
  for (const candidate of candidates.values()) {
    const tracked = state.watches[candidate.key]
    if (!tracked || removedKeys.has(candidate.key)) {
      // Untracked, or its stale entry is being removed this pass (stored end
      // in the past while the candidate's is in the future = a reschedule
      // detected via rule 2): either way it queues for a slot.
      pending.push(candidate)
      continue
    }
    const changed =
      tracked.startUtc !== candidate.startUtc ||
      tracked.scheduledEndUtc !== candidate.scheduledEndUtc ||
      tracked.joinWebUrl !== candidate.joinWebUrl
    if (changed) {
      remove.push({ key: candidate.key, joinUrlHash: tracked.joinUrlHash })
      removedKeys.add(candidate.key)
      pending.push(candidate)
    }
  }

  // Soonest-first (E3); key as the tiebreak so the plan is deterministic.
  pending.sort((a, b) => a.startMs - b.startMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  const trackedCount = Object.keys(state.watches).length
  const register: RegistrarActions['register'] = []
  for (const candidate of pending) {
    if (trackedCount - removedKeys.size + register.length >= REGISTRAR_CAP) break
    register.push({
      key: candidate.key,
      watch: {
        joinWebUrl: candidate.joinWebUrl,
        joinUrlHash: hash(candidate.joinWebUrl),
        startUtc: candidate.startUtc,
        scheduledEndUtc: candidate.scheduledEndUtc
      }
    })
  }

  return { register, remove }
}

// ===========================================================================
// Persisted state (tolerant JSON, mirroring graph/store.ts)
// ===========================================================================

export function emptyRegistrarState(): RegistrarState {
  return { watches: {} }
}

function readWatchEntry(value: unknown): RegistrarWatch | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const joinWebUrl = typeof raw.joinWebUrl === 'string' ? raw.joinWebUrl : ''
  const joinUrlHash = typeof raw.joinUrlHash === 'string' ? raw.joinUrlHash : ''
  const startUtc = typeof raw.startUtc === 'string' ? raw.startUtc : ''
  const scheduledEndUtc = typeof raw.scheduledEndUtc === 'string' ? raw.scheduledEndUtc : ''
  if (!joinWebUrl || !joinUrlHash || !startUtc || !scheduledEndUtc) return null
  const watch: RegistrarWatch = { joinWebUrl, joinUrlHash, startUtc, scheduledEndUtc }
  if (typeof raw.subscriptionExpiresUtc === 'string' && raw.subscriptionExpiresUtc) {
    watch.subscriptionExpiresUtc = raw.subscriptionExpiresUtc
  }
  return watch
}

/**
 * Read the persisted watch map. Synchronous BY DESIGN: it runs once, at
 * registrar creation, so `hasActiveWatch` is truthful from the first moment —
 * `armCallSignals` may consult it (to pick attach vs register mode) before
 * the first calendar sync ever runs, and an async load would answer "no
 * watch" for a watch that exists.
 *
 * Tolerance mirrors `readGraphSchedulerState` and goes one step further:
 * ANY failure — missing file, unreadable file, corrupt JSON, wrong shape —
 * reads as the empty state, and invalid entries are dropped individually.
 * The state is a rebuildable cache: the worst consequence of losing it is a
 * redundant POST, which the server treats as replace-in-place (E2). (The
 * whitespace-only-file corruption this tolerates was observed in the field
 * crashing the calendar sync — see graph/store.ts.)
 */
export function readRegistrarStateSync(path: string): RegistrarState {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return emptyRegistrarState()
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return emptyRegistrarState()
    }
    const rawWatches = (parsed as { watches?: unknown }).watches
    if (rawWatches === null || typeof rawWatches !== 'object' || Array.isArray(rawWatches)) {
      return emptyRegistrarState()
    }
    const watches: Record<string, RegistrarWatch> = {}
    for (const [key, value] of Object.entries(rawWatches as Record<string, unknown>)) {
      const watch = readWatchEntry(value)
      if (watch) watches[key] = watch
    }
    return { watches }
  } catch {
    return emptyRegistrarState()
  }
}

/** Write-then-rename so a crash mid-write leaves the previous state intact
 *  (same pattern as `writeGraphSchedulerState`). */
export async function writeRegistrarState(path: string, state: RegistrarState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.tmp`
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(tempPath, path)
}

// ===========================================================================
// Engine (transport injected; still Electron-free)
// ===========================================================================

/** The transport triple the engine needs. Structurally identical to
 *  `CallWatchTransport` in `call-signals.ts` — the runtime layer passes
 *  `createCallWatchTransport()`'s result straight through — but declared here
 *  so this file never touches the Electron-adjacent module. */
export interface CallWatchRegistrarTransport {
  apiBase: string
  http: CallSignalHttp
  identityHeaders: () => Promise<Record<string, string>>
}

export interface CallWatchRegistrarEngineDeps {
  statePath: string
  /** Resolved fresh on every sync so a config/env change (sign-in landing,
   *  kill switch flipped for a session) takes effect without a restart.
   *  Null = the feature is dormant on this machine. */
  transport: () => CallWatchRegistrarTransport | null
  /** Why `transport()` is returning null right now — logged on the dormant
   *  line so field triage can tell a kill switch from a missing scope. */
  dormantReason: () => string
  /** sha256 hex of the join URL (spec E2) — the runtime supplies
   *  `joinUrlHash` so desktop and storage-api derive identical addresses. */
  hash: (joinWebUrl: string) => string
  log: CallSignalLog
  /** Injectable clock for the harness. */
  now?: () => Date
}

export interface CallWatchRegistrar {
  /**
   * Reconcile after a calendar sync: plan against the current decisions,
   * execute removes then registers, persist once. Never rejects — every
   * failure mode collapses to a status-only log line and a retry on a later
   * sync. Overlapping calls are no-ops (see the serialization note in
   * `createCallWatchRegistrarEngine`).
   */
  handleSyncDecisions(decisions: GraphEventDecision[], signedInEmail?: string): Promise<void>
  /** True iff a tracked watch has this join-URL hash. `armCallSignals` uses
   *  it to pick attach mode (spec E5) over the register-on-the-spot floor. */
  hasActiveWatch(joinUrlHash: string): boolean
  /** The recording poller deleted this meeting's watch on stop (today's
   *  behaviour, unchanged): drop the tracked entry so the slot frees and a
   *  later sync doesn't DELETE a watch that is already gone. Persists. */
  noteWatchDeleted(joinUrlHash: string): void
  /** Await any pending state writes (shutdown/test seam — state writes are
   *  otherwise fire-and-forget so no caller ever blocks on the disk). */
  flushState(): Promise<void>
}

/**
 * Build the registrar engine. The runtime layer (`call-watch-registrar.ts`)
 * wires the real transport/hash/log; the harness injects fakes.
 *
 * Serialization: one `handleSyncDecisions` runs at a time, and an overlapping
 * call is a LOGGED NO-OP rather than queued. The calendar poller re-syncs on
 * a short cadence, so a skipped pass is re-planned minutes later from fresher
 * decisions anyway — queueing would only ever replay stale ones. The flag
 * also means a slow HTTP call (the register chain can legitimately take tens
 * of seconds through a cold Function App) can never interleave two passes'
 * requests over the same watch.
 *
 * Failure philosophy, per request:
 * - DELETE fails → log status, DROP THE ENTRY ANYWAY. The server-side orphan
 *   self-expires (spec D3, scheduled end + 12 h); a zombie client entry, by
 *   contrast, would hold one of the five cap slots forever.
 * - POST fails (including 409 `watch_limit`, the server cap racing us) → log
 *   status, store nothing. The meeting stays untracked, so the next sync
 *   pass naturally retries it — no retry timer of our own.
 * State persists once per batch (not per request): the state file is a cache
 * of "what did I already register", and a crash between requests and the
 * write costs at most one redundant replace-in-place POST (E2).
 */
export function createCallWatchRegistrarEngine(
  deps: CallWatchRegistrarEngineDeps
): CallWatchRegistrar {
  const now = deps.now ?? ((): Date => new Date())
  const state = readRegistrarStateSync(deps.statePath)
  let inFlight = false
  // Writes chain so two batches (or a batch + noteWatchDeleted) can never
  // interleave their write-then-rename pairs over the same temp file.
  let writeChain: Promise<void> = Promise.resolve()

  const persist = (): void => {
    const snapshot: RegistrarState = { watches: { ...state.watches } }
    writeChain = writeChain
      .then(() => writeRegistrarState(deps.statePath, snapshot))
      .catch(() => {
        // A failed write is survivable for the same reason a lost file is:
        // the state is rebuildable and POST is replace-in-place (E2).
        deps.log('warn', '[call-watch-registrar] state write failed', {})
      })
  }

  /** Never throws: a transport failure surfaces as null (logged as status 0),
   *  mirroring the poller core's request helper. */
  const request = async (
    transport: CallWatchRegistrarTransport,
    method: string,
    url: string,
    body?: string
  ): Promise<Awaited<ReturnType<CallSignalHttp>> | null> => {
    try {
      const headers: Record<string, string> = { ...(await transport.identityHeaders()) }
      if (body !== undefined) headers['content-type'] = 'application/json'
      return await transport.http(url, {
        method,
        headers,
        body,
        timeoutMs: CALL_SIGNAL_MUTATION_TIMEOUT_MS
      })
    } catch {
      return null
    }
  }

  return {
    async handleSyncDecisions(decisions, signedInEmail): Promise<void> {
      if (inFlight) {
        deps.log('info', '[call-watch-registrar] sync skipped', { reason: 'in_flight' })
        return
      }
      const transport = deps.transport()
      if (!transport) {
        deps.log('info', '[call-watch-registrar] dormant', { reason: deps.dormantReason() })
        return
      }
      inFlight = true
      try {
        const plan = planRegistrarActions(state, decisions, now(), signedInEmail, deps.hash)

        // Removes first: a re-register pair must delete before it creates
        // (the old subscription's expiry is wrong, and a changed join URL
        // means a different server-side address that would otherwise orphan).
        for (const entry of plan.remove) {
          const response = await request(
            transport,
            'DELETE',
            `${transport.apiBase}/api/v1/call-watch/${entry.joinUrlHash}`
          )
          if (!response || !response.ok) {
            deps.log('warn', '[call-watch-registrar] delete failed', {
              status: response?.status ?? 0
            })
          }
          // Dropped regardless of the outcome — see the factory doc.
          delete state.watches[entry.key]
        }

        let registered = 0
        let failed = 0
        for (const entry of plan.register) {
          const response = await request(
            transport,
            'POST',
            `${transport.apiBase}/api/v1/call-watch`,
            JSON.stringify({
              join_web_url: entry.watch.joinWebUrl,
              scheduled_end_utc: entry.watch.scheduledEndUtc
            })
          )
          if (response && response.ok) {
            let subscriptionExpiresUtc: string | undefined
            try {
              const payload = (await response.json()) as { subscription_expires_utc?: unknown } | null
              if (typeof payload?.subscription_expires_utc === 'string' && payload.subscription_expires_utc) {
                subscriptionExpiresUtc = payload.subscription_expires_utc
              }
            } catch {
              // The body is informational only; a 2xx without one still counts.
            }
            state.watches[entry.key] = subscriptionExpiresUtc
              ? { ...entry.watch, subscriptionExpiresUtc }
              : { ...entry.watch }
            registered += 1
          } else {
            failed += 1
            deps.log('warn', '[call-watch-registrar] register failed', {
              status: response?.status ?? 0
            })
          }
        }

        if (plan.remove.length > 0 || registered > 0) persist()
        deps.log('info', '[call-watch-registrar] sync reconciled', {
          decisions: decisions.length,
          removed: plan.remove.length,
          registered,
          failed,
          tracked: Object.keys(state.watches).length
        })
      } finally {
        inFlight = false
      }
    },

    hasActiveWatch(joinUrlHash: string): boolean {
      return Object.values(state.watches).some((watch) => watch.joinUrlHash === joinUrlHash)
    },

    noteWatchDeleted(joinUrlHash: string): void {
      let dropped = false
      for (const [key, watch] of Object.entries(state.watches)) {
        if (watch.joinUrlHash === joinUrlHash) {
          delete state.watches[key]
          dropped = true
        }
      }
      if (dropped) persist()
    },

    flushState(): Promise<void> {
      return writeChain
    }
  }
}
