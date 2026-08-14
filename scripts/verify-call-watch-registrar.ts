/**
 * Verify the call-watch registrar (Task 9, per-meeting amendment spec
 * E1/E3/E4): the pure reconciliation planner plus the registrar engine that
 * executes it against the relay and persists its watch map.
 *
 * Assert-based harness in the repo's `verify:*` idiom (see
 * scripts/verify-call-signals.ts, whose fakes this file mirrors). Everything
 * runs in plain Node: the engine takes its transport, hash, clock, and log by
 * injection, and its state file is real `node:fs` against a temp directory —
 * the persistence tolerance rules (corrupt file → empty state) are product
 * behaviour and are pinned here, not faked.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Imports the PURE CORE only. `call-watch-registrar.ts` (the runtime half)
// pulls in `call-signals.ts` → logger/auth-session, which `require("electron")`
// at module scope; the bundle-purity check at the foot of this file fails if
// that ever creeps in.
import { CALL_SIGNAL_MUTATION_TIMEOUT_MS, type CallSignalHttpResponse } from '../src/main/call-signals-core'
import {
  REGISTRAR_CAP,
  createCallWatchRegistrarEngine,
  planRegistrarActions,
  readRegistrarStateSync,
  writeRegistrarState,
  type CallWatchRegistrarEngineDeps,
  type RegistrarState,
  type RegistrarWatch
} from '../src/main/call-watch-registrar-core'
import type { GraphEventDecision } from '../src/main/graph/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-14T00:00:00Z')
const API_BASE = 'http://127.0.0.1:8787'
const STORAGE_TOKEN = 'eyJ-fake-storage-token'
const USER_EMAIL = 'recorder@factor1.com.au'
const USER_OID = '00000000-1111-2222-3333-444444444444'

/** The runtime layer's `joinUrlHash` derivation (sha256 hex, spec E2) —
 *  recomputed here so the assertions pin the derivation, not a copy. */
function sha(url: string): string {
  return createHash('sha256').update(url).digest('hex')
}

function urlFor(key: string): string {
  return `https://teams.microsoft.com/l/meetup-join/19%3ameeting_${key}%40thread.v2/0`
}

let eventSeq = 0

interface DecisionOverrides {
  key?: string
  status?: GraphEventDecision['status']
  reason?: GraphEventDecision['reason']
  autoRecordEligible?: boolean
  isOrganizer?: boolean
  joinWebUrl?: string | null
  startUtc?: string
  endUtc?: string
}

function decision(overrides: DecisionOverrides = {}): GraphEventDecision {
  const eventId = `evt-${++eventSeq}`
  const key = overrides.key ?? `key-${eventId}`
  const joinWebUrl = 'joinWebUrl' in overrides ? overrides.joinWebUrl : urlFor(key)
  const startUtc = 'startUtc' in overrides ? overrides.startUtc : '2026-08-14T01:00:00Z'
  const endUtc = 'endUtc' in overrides ? overrides.endUtc : '2026-08-14T01:30:00Z'
  return {
    eventId,
    idempotencyKey: key,
    metadata: {
      attendees: [],
      meetingId: `meeting-${eventId}`,
      ...(joinWebUrl ? { joinWebUrl } : {})
    },
    status: overrides.status ?? 'candidate',
    reason: overrides.reason ?? 'eligible',
    autoRecordEligible: overrides.autoRecordEligible ?? true,
    logContext: {
      eventIdHash: `evthash-${eventId}`,
      startUtc,
      endUtc,
      isOrganizer: overrides.isOrganizer ?? true,
      isCancelled: false,
      isAllDay: false,
      attendeeCount: 3,
      isOnlineMeeting: true
    }
  }
}

function watch(key: string, startUtc: string, scheduledEndUtc: string, joinWebUrl = urlFor(key)): RegistrarWatch {
  return { joinWebUrl, joinUrlHash: sha(joinWebUrl), startUtc, scheduledEndUtc }
}

function stateOf(entries: Record<string, RegistrarWatch>): RegistrarState {
  return { watches: { ...entries } }
}

function plan(
  state: RegistrarState,
  decisions: GraphEventDecision[],
  signedInEmail: string | undefined = USER_EMAIL
): ReturnType<typeof planRegistrarActions> {
  return planRegistrarActions(state, decisions, NOW, signedInEmail, sha)
}

// ---------------------------------------------------------------------------
// HTTP / log fakes (mirroring scripts/verify-call-signals.ts)
// ---------------------------------------------------------------------------

interface HttpCall {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
  timeoutMs?: number
}

type HttpHandler = (
  call: HttpCall,
  index: number
) => CallSignalHttpResponse | Error | Promise<CallSignalHttpResponse>

interface FakeHttp {
  calls: HttpCall[]
  send: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; timeoutMs?: number }
  ) => Promise<CallSignalHttpResponse>
}

function jsonResponse(status: number, body: unknown = {}): CallSignalHttpResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function createFakeHttp(handler: HttpHandler): FakeHttp {
  const calls: HttpCall[] = []
  return {
    calls,
    async send(url, init) {
      const call: HttpCall = {
        method: init.method,
        url,
        headers: init.headers,
        body: init.body,
        timeoutMs: init.timeoutMs
      }
      calls.push(call)
      const result = handler(call, calls.length - 1)
      if (result instanceof Error) throw result
      return result
    }
  }
}

interface LogEntry {
  level: string
  message: string
  context?: Record<string, unknown>
}

function createFakeLog(): {
  entries: LogEntry[]
  log: (level: 'info' | 'warn', message: string, context?: Record<string, unknown>) => void
} {
  const entries: LogEntry[] = []
  return {
    entries,
    log(level, message, context): void {
      entries.push({ level, message, context })
    }
  }
}

/**
 * Registrar logs may carry counts, statuses, and eventIds only — never join
 * URLs, hashes, tokens, emails, OIDs, or response bodies. Applied to every
 * engine scenario's log, not just a dedicated privacy one.
 */
function assertNoPii(entries: LogEntry[], label: string, hashes: string[] = []): void {
  const serialised = JSON.stringify(entries)
  assert.ok(!serialised.includes('meetup-join'), `${label}: no join-URL fragment may be logged`)
  assert.ok(!serialised.includes(STORAGE_TOKEN), `${label}: tokens must never be logged`)
  assert.ok(!serialised.includes(USER_EMAIL), `${label}: emails must never be logged`)
  assert.ok(!serialised.includes(USER_OID), `${label}: OIDs must never be logged`)
  assert.ok(!serialised.includes('detail'), `${label}: response bodies must never be logged`)
  for (const hash of hashes) {
    assert.ok(!serialised.includes(hash), `${label}: join-URL hashes must never be logged`)
  }
}

// ---------------------------------------------------------------------------
// Planner scenarios (pure, spec E1/E3/E4)
// ---------------------------------------------------------------------------

function scenarioCapAdmissionSoonestFirst(): void {
  assert.equal(REGISTRAR_CAP, 5, 'the client-side cap must mirror the server invariant (E3)')

  // Seven eligible candidates, deliberately shuffled so the admission order
  // can only come from sorting by startUtc, never from input order.
  const hours = [4, 1, 7, 3, 6, 2, 5]
  const candidates = hours.map((h) =>
    decision({
      key: `cap-${h}`,
      startUtc: `2026-08-14T0${h}:00:00Z`,
      endUtc: `2026-08-14T0${h}:30:00Z`
    })
  )
  const actions = plan(stateOf({}), candidates)
  assert.deepEqual(actions.remove, [], 'a fresh state with live candidates removes nothing')
  assert.equal(actions.register.length, 5, 'exactly REGISTRAR_CAP watches admit from 7 candidates')
  assert.deepEqual(
    actions.register.map((entry) => entry.key),
    ['cap-1', 'cap-2', 'cap-3', 'cap-4', 'cap-5'],
    'the five soonest by startUtc admit, in startUtc order (E3 soonest-first)'
  )
  const first = actions.register[0].watch
  assert.deepEqual(
    first,
    {
      joinWebUrl: urlFor('cap-1'),
      joinUrlHash: sha(urlFor('cap-1')),
      startUtc: '2026-08-14T01:00:00Z',
      scheduledEndUtc: '2026-08-14T01:30:00Z'
    },
    'a planned watch carries the join URL, its sha256 hash, and the decision times'
  )

  // With three slots already occupied, only two of four new candidates admit.
  const occupied = stateOf({
    'held-1': watch('held-1', '2026-08-14T09:00:00Z', '2026-08-14T09:30:00Z'),
    'held-2': watch('held-2', '2026-08-14T10:00:00Z', '2026-08-14T10:30:00Z'),
    'held-3': watch('held-3', '2026-08-14T11:00:00Z', '2026-08-14T11:30:00Z')
  })
  const partial = plan(
    occupied,
    candidates.filter((c) => ['cap-1', 'cap-2', 'cap-3', 'cap-4'].includes(c.idempotencyKey ?? ''))
  )
  assert.deepEqual(
    partial.register.map((entry) => entry.key),
    ['cap-1', 'cap-2'],
    'occupied slots count against the cap; the soonest waiting candidates admit first'
  )
  assert.deepEqual(partial.remove, [], 'live tracked watches are untouched by admission')
}

function scenarioCancelledAndEndedRemove(): void {
  const state = stateOf({
    'gone-cancelled': watch('gone-cancelled', '2026-08-14T02:00:00Z', '2026-08-14T02:30:00Z'),
    'gone-ended': watch('gone-ended', '2026-08-13T22:00:00Z', '2026-08-13T22:30:00Z'),
    'still-live': watch('still-live', '2026-08-14T03:00:00Z', '2026-08-14T03:30:00Z')
  })
  const actions = plan(state, [
    decision({ key: 'gone-cancelled', status: 'excluded', reason: 'cancelled' }),
    // An excluded decision for an untracked meeting must not fabricate a remove.
    decision({ key: 'never-tracked', status: 'excluded', reason: 'declined' })
  ])
  assert.deepEqual(
    actions.remove
      .map((entry) => entry.key)
      .sort(),
    ['gone-cancelled', 'gone-ended'],
    'a tracked watch removes when its decision turns excluded OR its stored end passes'
  )
  const cancelled = actions.remove.find((entry) => entry.key === 'gone-cancelled')
  assert.equal(
    cancelled?.joinUrlHash,
    sha(urlFor('gone-cancelled')),
    'a remove carries the STORED hash — that is the server-side address of the watch'
  )
  assert.deepEqual(actions.register, [], 'removals alone plan no registrations')
}

function scenarioRescheduleReRegisters(): void {
  const state = stateOf({
    moved: watch('moved', '2026-08-14T02:00:00Z', '2026-08-14T02:30:00Z'),
    steady: watch('steady', '2026-08-14T03:00:00Z', '2026-08-14T03:30:00Z')
  })
  // The meeting moved +2h: the subscription's expiry derives from
  // scheduled_end_utc, so the watch must be deleted and re-created (E4).
  const actions = plan(state, [
    decision({ key: 'moved', startUtc: '2026-08-14T04:00:00Z', endUtc: '2026-08-14T04:30:00Z' }),
    decision({ key: 'steady', startUtc: '2026-08-14T03:00:00Z', endUtc: '2026-08-14T03:30:00Z' })
  ])
  assert.deepEqual(
    actions.remove,
    [{ key: 'moved', joinUrlHash: sha(urlFor('moved')) }],
    'a changed start/end must remove the stale watch (E4)'
  )
  assert.deepEqual(
    actions.register.map((entry) => entry.key),
    ['moved'],
    'the same key re-registers in the same pass'
  )
  assert.equal(
    actions.register[0].watch.scheduledEndUtc,
    '2026-08-14T04:30:00Z',
    'the re-registered watch carries the new scheduled end'
  )

  // A changed join URL also re-registers, and the pair addresses two different
  // server-side watches: remove by the OLD hash, register with the NEW one.
  const newUrl = urlFor('moved-regenerated')
  const urlChange = plan(state, [
    decision({
      key: 'moved',
      joinWebUrl: newUrl,
      startUtc: '2026-08-14T02:00:00Z',
      endUtc: '2026-08-14T02:30:00Z'
    }),
    decision({ key: 'steady', startUtc: '2026-08-14T03:00:00Z', endUtc: '2026-08-14T03:30:00Z' })
  ])
  assert.deepEqual(
    urlChange.remove,
    [{ key: 'moved', joinUrlHash: sha(urlFor('moved')) }],
    'a regenerated join URL removes the watch stored under the OLD hash'
  )
  assert.equal(
    urlChange.register[0]?.watch.joinUrlHash,
    sha(newUrl),
    'the replacement watch is keyed by the NEW hash'
  )

  // A re-register at a full cap still fits: its own removal frees the slot.
  const full = stateOf({
    'f-1': watch('f-1', '2026-08-14T01:00:00Z', '2026-08-14T01:30:00Z'),
    'f-2': watch('f-2', '2026-08-14T02:00:00Z', '2026-08-14T02:30:00Z'),
    'f-3': watch('f-3', '2026-08-14T03:00:00Z', '2026-08-14T03:30:00Z'),
    'f-4': watch('f-4', '2026-08-14T04:00:00Z', '2026-08-14T04:30:00Z'),
    'f-5': watch('f-5', '2026-08-14T05:00:00Z', '2026-08-14T05:30:00Z')
  })
  const fullActions = plan(full, [
    decision({ key: 'f-3', startUtc: '2026-08-14T06:00:00Z', endUtc: '2026-08-14T06:30:00Z' })
  ])
  assert.deepEqual(fullActions.remove.map((entry) => entry.key), ['f-3'])
  assert.deepEqual(
    fullActions.register.map((entry) => entry.key),
    ['f-3'],
    'a re-register at the cap admits — its own removal freed the slot'
  )
}

function scenarioAbsentFromDeltaIsNotRemoved(): void {
  const state = stateOf({
    quiet: watch('quiet', '2026-08-14T05:00:00Z', '2026-08-14T05:30:00Z')
  })
  // Delta syncs only carry CHANGED events: an unchanged tracked meeting is
  // simply absent from the decisions, which must never read as "cancelled".
  const empty = plan(state, [])
  assert.deepEqual(empty.remove, [], 'absence from a delta sync must not remove a live watch')
  assert.deepEqual(empty.register, [], 'an empty sync plans nothing')

  const unrelated = plan(state, [
    decision({ key: 'newcomer', startUtc: '2026-08-14T06:00:00Z', endUtc: '2026-08-14T06:30:00Z' })
  ])
  assert.deepEqual(unrelated.remove, [], 'an unrelated delta must not disturb tracked watches')
  assert.deepEqual(
    unrelated.register.map((entry) => entry.key),
    ['newcomer'],
    'new candidates still admit alongside the untouched tracked watch'
  )
}

function scenarioIneligibleCandidatesNeverRegister(): void {
  const actions = plan(stateOf({}), [
    decision({ key: 'ok', startUtc: '2026-08-14T01:00:00Z', endUtc: '2026-08-14T01:30:00Z' }),
    decision({ key: 'no-url', joinWebUrl: null }),
    decision({ key: 'not-organizer', isOrganizer: false }),
    decision({ key: 'not-auto-eligible', autoRecordEligible: false }),
    decision({ key: 'excluded', status: 'excluded', reason: 'declined' }),
    decision({ key: 'wrong-reason', reason: 'outside_lookahead' }),
    decision({ key: 'already-over', startUtc: '2026-08-13T22:00:00Z', endUtc: '2026-08-13T23:00:00Z' }),
    decision({ key: 'ends-now', startUtc: '2026-08-13T23:00:00Z', endUtc: '2026-08-14T00:00:00Z' }),
    decision({ key: 'no-end', endUtc: undefined })
  ])
  assert.deepEqual(
    actions.register.map((entry) => entry.key),
    ['ok'],
    'only a live, host-gate-approved candidate with a join URL may register'
  )
  assert.deepEqual(actions.remove, [], 'ineligible candidates plan no removals either')

  // `not_due_yet` is a candidate status too — registration happens at
  // discovery (E1), hours before the meeting is due.
  const notDue = plan(stateOf({}), [
    decision({ key: 'later-today', reason: 'not_due_yet', startUtc: '2026-08-14T09:00:00Z', endUtc: '2026-08-14T09:30:00Z' })
  ])
  assert.deepEqual(
    notDue.register.map((entry) => entry.key),
    ['later-today'],
    'not_due_yet candidates register at discovery — that is the whole point of E1'
  )
}

function scenarioRemovalFreesASlot(): void {
  const full = stateOf({
    'r-1': watch('r-1', '2026-08-14T01:00:00Z', '2026-08-14T01:30:00Z'),
    'r-2': watch('r-2', '2026-08-14T02:00:00Z', '2026-08-14T02:30:00Z'),
    'r-3': watch('r-3', '2026-08-14T03:00:00Z', '2026-08-14T03:30:00Z'),
    'r-4': watch('r-4', '2026-08-14T04:00:00Z', '2026-08-14T04:30:00Z'),
    'r-5': watch('r-5', '2026-08-14T05:00:00Z', '2026-08-14T05:30:00Z')
  })
  const actions = plan(full, [
    decision({ key: 'r-2', status: 'excluded', reason: 'cancelled' }),
    decision({ key: 'waiting-a', startUtc: '2026-08-14T07:00:00Z', endUtc: '2026-08-14T07:30:00Z' }),
    decision({ key: 'waiting-b', startUtc: '2026-08-14T06:00:00Z', endUtc: '2026-08-14T06:30:00Z' })
  ])
  assert.deepEqual(actions.remove.map((entry) => entry.key), ['r-2'])
  assert.deepEqual(
    actions.register.map((entry) => entry.key),
    ['waiting-b'],
    'a removal frees exactly one slot, taken by the soonest waiting candidate'
  )
}

function scenarioUnparseableStoredEndIsReaped(): void {
  // A stored end that no longer parses can never become past on its own, so
  // the planner must reap it even when the meeting is ABSENT from the sync's
  // decisions — otherwise that entry would hold a cap slot forever.
  const state = stateOf({
    'garbage-end': watch('garbage-end', '2026-08-14T01:00:00Z', 'not-a-date'),
    'still-live': watch('still-live', '2026-08-14T03:00:00Z', '2026-08-14T03:30:00Z')
  })
  const actions = plan(state, [])
  assert.deepEqual(
    actions.remove,
    [{ key: 'garbage-end', joinUrlHash: sha(urlFor('garbage-end')) }],
    'an unparseable stored scheduledEndUtc must be reaped even with the key absent from decisions'
  )
  assert.deepEqual(actions.register, [], 'the reap alone plans no registrations')

  // And the reap genuinely frees a slot: at a full cap, a garbage-end entry's
  // removal admits the soonest waiting candidate in the same pass.
  const full = stateOf({
    'g-1': watch('g-1', '2026-08-14T01:00:00Z', '2026-08-14T01:30:00Z'),
    'g-2': watch('g-2', '2026-08-14T02:00:00Z', 'not-a-date'),
    'g-3': watch('g-3', '2026-08-14T03:00:00Z', '2026-08-14T03:30:00Z'),
    'g-4': watch('g-4', '2026-08-14T04:00:00Z', '2026-08-14T04:30:00Z'),
    'g-5': watch('g-5', '2026-08-14T05:00:00Z', '2026-08-14T05:30:00Z')
  })
  const freed = plan(full, [
    decision({ key: 'waiting', startUtc: '2026-08-14T06:00:00Z', endUtc: '2026-08-14T06:30:00Z' })
  ])
  assert.deepEqual(freed.remove.map((entry) => entry.key), ['g-2'])
  assert.deepEqual(
    freed.register.map((entry) => entry.key),
    ['waiting'],
    'the reaped slot admits a waiting candidate in the same pass'
  )
}

// ---------------------------------------------------------------------------
// Engine scenarios (injected transport; real fs against a temp dir)
// ---------------------------------------------------------------------------

const tempRoot = mkdtempSync(join(tmpdir(), 'verify-call-watch-registrar-'))
let stateSeq = 0
function newStatePath(): string {
  return join(tempRoot, `run-${++stateSeq}`, 'call-watch-state.json')
}

function engineDeps(
  statePath: string,
  http: FakeHttp,
  log: ReturnType<typeof createFakeLog>,
  overrides: Partial<CallWatchRegistrarEngineDeps> = {}
): CallWatchRegistrarEngineDeps {
  return {
    statePath,
    transport: () => ({
      apiBase: API_BASE,
      http: http.send,
      identityHeaders: async () => ({
        'X-MN-User-Email': USER_EMAIL,
        'X-MN-User-Oid': USER_OID,
        'X-MN-Storage-Token': STORAGE_TOKEN
      })
    }),
    dormantReason: () => 'feature_disabled',
    hash: sha,
    log: log.log,
    now: () => NOW,
    ...overrides
  }
}

async function scenarioEngineRegistersAndPersists(): Promise<void> {
  const statePath = newStatePath()
  const logs = createFakeLog()
  const http = createFakeHttp(() =>
    jsonResponse(201, { watch_id: 'w1', subscription_expires_utc: '2026-08-14T13:30:00Z' })
  )
  const engine = createCallWatchRegistrarEngine(engineDeps(statePath, http, logs))
  const joinWebUrl = urlFor('persist-me')

  await engine.handleSyncDecisions(
    [decision({ key: 'persist-me', startUtc: '2026-08-14T01:00:00Z', endUtc: '2026-08-14T01:30:00Z' })],
    USER_EMAIL
  )
  assert.equal(http.calls.length, 1, 'one candidate registers with one POST')
  assert.equal(http.calls[0].method, 'POST')
  assert.equal(
    http.calls[0].url,
    `${API_BASE}/api/v1/call-watch`,
    'registration goes to the collection relay route'
  )
  assert.deepEqual(
    JSON.parse(http.calls[0].body ?? '{}'),
    { join_web_url: joinWebUrl, scheduled_end_utc: '2026-08-14T01:30:00Z' },
    'the registration body matches the relay contract'
  )
  assert.equal(
    http.calls[0].timeoutMs,
    CALL_SIGNAL_MUTATION_TIMEOUT_MS,
    'registration traverses Graph and needs the long mutation budget'
  )
  assert.equal(
    http.calls[0].headers['content-type'],
    'application/json',
    'the registration body needs a content-type'
  )
  assert.equal(
    http.calls[0].headers['X-MN-Storage-Token'],
    STORAGE_TOKEN,
    'the storage identity headers must ride along'
  )
  assert.equal(engine.hasActiveWatch(sha(joinWebUrl)), true, 'a stored watch reports active by hash')
  assert.equal(engine.hasActiveWatch(sha(urlFor('other'))), false, 'unknown hashes report inactive')

  await engine.flushState()
  const onDisk = readRegistrarStateSync(statePath)
  assert.equal(
    onDisk.watches['persist-me']?.subscriptionExpiresUtc,
    '2026-08-14T13:30:00Z',
    'the response subscription_expires_utc persists with the watch'
  )
  assert.equal(
    onDisk.watches['persist-me']?.joinUrlHash,
    sha(joinWebUrl),
    'the persisted watch carries the derived hash'
  )

  // Re-syncing the same unchanged candidate is a no-op: no delete, no re-POST.
  await engine.handleSyncDecisions(
    [decision({ key: 'persist-me', startUtc: '2026-08-14T01:00:00Z', endUtc: '2026-08-14T01:30:00Z' })],
    USER_EMAIL
  )
  assert.equal(http.calls.length, 1, 'an unchanged tracked candidate re-registers nothing')

  assertNoPii(logs.entries, 'register + persist', [sha(joinWebUrl)])
}

async function scenario409NotStoredThenRetried(): Promise<void> {
  const statePath = newStatePath()
  const logs = createFakeLog()
  let posts = 0
  const http = createFakeHttp((call) => {
    if (call.method !== 'POST') return jsonResponse(204)
    posts += 1
    // First pass: the server cap is full (E3). Second pass: a slot freed.
    return posts === 1 ? jsonResponse(409, { detail: 'watch_limit' }) : jsonResponse(201, { watch_id: 'w2' })
  })
  const engine = createCallWatchRegistrarEngine(engineDeps(statePath, http, logs))
  const hash = sha(urlFor('capped'))
  const decisions = [
    decision({ key: 'capped', startUtc: '2026-08-14T01:00:00Z', endUtc: '2026-08-14T01:30:00Z' })
  ]

  await engine.handleSyncDecisions(decisions, USER_EMAIL)
  assert.equal(engine.hasActiveWatch(hash), false, 'a 409 must not be stored as a live watch')
  const rejected = logs.entries.find((entry) => entry.message === '[call-watch-registrar] register failed')
  assert.equal(rejected?.context?.status, 409, 'the 409 is logged status-only')
  await engine.flushState()
  assert.deepEqual(
    readRegistrarStateSync(statePath).watches,
    {},
    'nothing persists for a rejected registration'
  )

  // The candidate is still untracked, so the next sync naturally retries it.
  await engine.handleSyncDecisions(decisions, USER_EMAIL)
  assert.equal(posts, 2, 'the rejected candidate retries on the next sync pass')
  assert.equal(engine.hasActiveWatch(hash), true, 'the retry stores the watch once it succeeds')

  assertNoPii(logs.entries, '409 then retry', [hash])
}

async function scenarioDeleteFailureStillDrops(): Promise<void> {
  const statePath = newStatePath()
  const logs = createFakeLog()
  // Seed two tracked watches directly on disk (the engine reads at creation).
  await writeRegistrarState(statePath, stateOf({
    'doomed-500': watch('doomed-500', '2026-08-14T01:00:00Z', '2026-08-14T01:30:00Z'),
    'doomed-throw': watch('doomed-throw', '2026-08-14T02:00:00Z', '2026-08-14T02:30:00Z')
  }))
  const http = createFakeHttp((call) => {
    if (call.method !== 'DELETE') return jsonResponse(201)
    return call.url.includes(sha(urlFor('doomed-500')))
      ? jsonResponse(500, { detail: 'boom' })
      : new Error('ECONNREFUSED 127.0.0.1:8787')
  })
  const engine = createCallWatchRegistrarEngine(engineDeps(statePath, http, logs))
  assert.equal(engine.hasActiveWatch(sha(urlFor('doomed-500'))), true, 'the seeded state loads at creation')

  await engine.handleSyncDecisions(
    [
      decision({ key: 'doomed-500', status: 'excluded', reason: 'cancelled' }),
      decision({ key: 'doomed-throw', status: 'excluded', reason: 'cancelled' })
    ],
    USER_EMAIL
  )
  const deletes = http.calls.filter((call) => call.method === 'DELETE')
  assert.equal(deletes.length, 2, 'each removal issues one DELETE')
  assert.equal(
    deletes[0].url,
    `${API_BASE}/api/v1/call-watch/${sha(urlFor('doomed-500'))}`,
    'the delete hits the per-meeting relay route by hash'
  )
  assert.equal(
    deletes[0].timeoutMs,
    CALL_SIGNAL_MUTATION_TIMEOUT_MS,
    'the delete also traverses Graph and needs the long budget'
  )
  // Delete failures drop the entry anyway: an orphaned server-side watch
  // self-expires (D3), but a zombie CLIENT entry would hold a cap slot forever.
  assert.equal(engine.hasActiveWatch(sha(urlFor('doomed-500'))), false, 'a 500 delete still drops the watch')
  assert.equal(engine.hasActiveWatch(sha(urlFor('doomed-throw'))), false, 'a transport throw still drops the watch')
  assert.deepEqual(
    logs.entries
      .filter((entry) => entry.message === '[call-watch-registrar] delete failed')
      .map((entry) => entry.context?.status),
    [500, 0],
    'each delete failure logs its status (0 = the request never completed)'
  )
  await engine.flushState()
  assert.deepEqual(readRegistrarStateSync(statePath).watches, {}, 'the drops persist')

  assertNoPii(logs.entries, 'delete failure', [sha(urlFor('doomed-500')), sha(urlFor('doomed-throw'))])
}

async function scenarioRescheduleExecutesDeleteBeforePost(): Promise<void> {
  const statePath = newStatePath()
  const logs = createFakeLog()
  const joinWebUrl = urlFor('same-url-resched')
  const hash = sha(joinWebUrl)
  // Seed a tracked watch, then feed a same-key reschedule with the SAME join
  // URL (endUtc moved +1h). Same URL means same hash means the SAME
  // server-side watch address (E2) — so if the engine ever ran the batch's
  // registers before its removes, the DELETE would land on the freshly
  // replaced watch and destroy it. The executed order, not just the planned
  // pair, is what this scenario pins.
  await writeRegistrarState(
    statePath,
    stateOf({ 'same-url-resched': watch('same-url-resched', '2026-08-14T02:00:00Z', '2026-08-14T02:30:00Z') })
  )
  const http = createFakeHttp(() => jsonResponse(201, { watch_id: 'w5' }))
  const engine = createCallWatchRegistrarEngine(engineDeps(statePath, http, logs))

  await engine.handleSyncDecisions(
    [
      decision({
        key: 'same-url-resched',
        joinWebUrl,
        startUtc: '2026-08-14T02:00:00Z',
        endUtc: '2026-08-14T03:30:00Z'
      })
    ],
    USER_EMAIL
  )
  assert.deepEqual(
    http.calls.map((call) => call.method),
    ['DELETE', 'POST'],
    'a reschedule batch must execute its DELETE strictly before its POST'
  )
  assert.equal(
    http.calls[0].url,
    `${API_BASE}/api/v1/call-watch/${hash}`,
    'the DELETE addresses the tracked watch by its (unchanged) hash'
  )
  assert.equal(
    http.calls[1].url,
    `${API_BASE}/api/v1/call-watch`,
    'the replacement POST follows on the collection route'
  )
  assert.deepEqual(
    JSON.parse(http.calls[1].body ?? '{}'),
    { join_web_url: joinWebUrl, scheduled_end_utc: '2026-08-14T03:30:00Z' },
    'the replacement carries the new scheduled end'
  )
  assert.equal(engine.hasActiveWatch(hash), true, 'the rescheduled watch is tracked again')
  await engine.flushState()
  assert.equal(
    readRegistrarStateSync(statePath).watches['same-url-resched']?.scheduledEndUtc,
    '2026-08-14T03:30:00Z',
    'the persisted watch carries the new scheduled end'
  )

  assertNoPii(logs.entries, 'reschedule order', [hash])
}

async function scenarioOverlappingSyncIsNoOp(): Promise<void> {
  const statePath = newStatePath()
  const logs = createFakeLog()
  let releasePost: ((response: CallSignalHttpResponse) => void) | null = null
  const http = createFakeHttp((call) => {
    if (call.method !== 'POST') return jsonResponse(204)
    // A hanging registration: the relay chain can legitimately take tens of
    // seconds (cold-started Function App), so a slow POST must not let the
    // next calendar sync interleave with this one.
    return new Promise<CallSignalHttpResponse>((resolve) => {
      releasePost = resolve
    })
  })
  const engine = createCallWatchRegistrarEngine(engineDeps(statePath, http, logs))
  const decisions = [
    decision({ key: 'slow-reg', startUtc: '2026-08-14T01:00:00Z', endUtc: '2026-08-14T01:30:00Z' })
  ]

  const first = engine.handleSyncDecisions(decisions, USER_EMAIL)
  // Let the first call reach its hanging POST before overlapping it.
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(http.calls.length, 1, 'the first sync is parked inside its POST')

  await engine.handleSyncDecisions(decisions, USER_EMAIL)
  assert.equal(http.calls.length, 1, 'an overlapping sync must issue no requests')
  const skipped = logs.entries.find((entry) => entry.message === '[call-watch-registrar] sync skipped')
  assert.deepEqual(
    skipped?.context,
    { reason: 'in_flight' },
    'the overlapping sync logs why it stood down'
  )

  assert.ok(releasePost, 'the hanging POST handler must have been reached')
  releasePost!(jsonResponse(201, { watch_id: 'w3' }))
  await first
  assert.equal(engine.hasActiveWatch(sha(urlFor('slow-reg'))), true, 'the released sync completes normally')

  // Once settled, the next sync runs again (and plans nothing new).
  await engine.handleSyncDecisions(decisions, USER_EMAIL)
  assert.equal(http.calls.length, 1, 'a settled registrar accepts the next sync without re-POSTing')
  assert.equal(
    logs.entries.filter((entry) => entry.message === '[call-watch-registrar] sync skipped').length,
    1,
    'only the genuinely overlapping call was skipped'
  )

  assertNoPii(logs.entries, 'overlap', [sha(urlFor('slow-reg'))])
}

async function scenarioStateRoundTripAndCorruption(): Promise<void> {
  const statePath = newStatePath()
  const logs = createFakeLog()
  const http = createFakeHttp(() => jsonResponse(201, { watch_id: 'w4' }))
  const hash = sha(urlFor('survivor'))

  const engineA = createCallWatchRegistrarEngine(engineDeps(statePath, http, logs))
  await engineA.handleSyncDecisions(
    [decision({ key: 'survivor', startUtc: '2026-08-14T01:00:00Z', endUtc: '2026-08-14T01:30:00Z' })],
    USER_EMAIL
  )
  await engineA.flushState()

  // A fresh registrar over the same path knows the watch immediately — the
  // state read is synchronous at creation so `hasActiveWatch` is truthful
  // before the first sync (armCallSignals may consult it at any moment).
  const engineB = createCallWatchRegistrarEngine(engineDeps(statePath, http, createFakeLog()))
  assert.equal(engineB.hasActiveWatch(hash), true, 'state round-trips through the JSON file')

  // noteWatchDeleted (the poller deleted the watch on recording stop) drops
  // the entry and persists the drop.
  engineB.noteWatchDeleted(hash)
  assert.equal(engineB.hasActiveWatch(hash), false, 'noteWatchDeleted drops the tracked entry')
  await engineB.flushState()
  const engineC = createCallWatchRegistrarEngine(engineDeps(statePath, http, createFakeLog()))
  assert.equal(engineC.hasActiveWatch(hash), false, 'the noteWatchDeleted drop persists')
  engineC.noteWatchDeleted(hash)
  assert.equal(engineC.hasActiveWatch(hash), false, 'a repeat noteWatchDeleted is inert')

  // Corruption tolerance: garbage, whitespace (the field incident shape), and
  // invalid entries all collapse to a working empty state — never a throw.
  const corruptPath = newStatePath()
  await writeRegistrarState(corruptPath, stateOf({}))
  writeFileSync(corruptPath, '{"watches": {"half-written', 'utf8')
  const corrupt = createCallWatchRegistrarEngine(engineDeps(corruptPath, http, createFakeLog()))
  assert.equal(corrupt.hasActiveWatch(hash), false, 'a corrupt state file reads as empty')

  writeFileSync(corruptPath, '   \n', 'utf8')
  assert.deepEqual(readRegistrarStateSync(corruptPath), { watches: {} }, 'whitespace-only reads as empty')

  writeFileSync(corruptPath, JSON.stringify({ watches: 'nonsense' }), 'utf8')
  assert.deepEqual(readRegistrarStateSync(corruptPath), { watches: {} }, 'a non-object watches map reads as empty')

  writeFileSync(
    corruptPath,
    JSON.stringify({
      watches: {
        good: watch('good', '2026-08-14T01:00:00Z', '2026-08-14T01:30:00Z'),
        'bad-shape': { joinWebUrl: 42 },
        'bad-null': null
      }
    }),
    'utf8'
  )
  const filtered = readRegistrarStateSync(corruptPath)
  assert.deepEqual(
    Object.keys(filtered.watches),
    ['good'],
    'invalid entries are dropped individually, keeping the valid ones'
  )

  // A corrupt-state engine still syncs and rewrites a healthy file.
  writeFileSync(corruptPath, 'not json at all', 'utf8')
  const recovered = createCallWatchRegistrarEngine(engineDeps(corruptPath, http, createFakeLog()))
  await recovered.handleSyncDecisions(
    [decision({ key: 'recovered', startUtc: '2026-08-14T01:00:00Z', endUtc: '2026-08-14T01:30:00Z' })],
    USER_EMAIL
  )
  await recovered.flushState()
  assert.equal(
    readRegistrarStateSync(corruptPath).watches['recovered']?.joinUrlHash,
    sha(urlFor('recovered')),
    'the first healthy sync replaces the corrupt file'
  )

  assertNoPii(logs.entries, 'round trip', [hash])
}

async function scenarioDormantWhenTransportUnavailable(): Promise<void> {
  const statePath = newStatePath()
  const logs = createFakeLog()
  const http = createFakeHttp(() => jsonResponse(201))
  const engine = createCallWatchRegistrarEngine(
    engineDeps(statePath, http, logs, { transport: () => null })
  )
  await engine.handleSyncDecisions(
    [decision({ key: 'nobody-home', startUtc: '2026-08-14T01:00:00Z', endUtc: '2026-08-14T01:30:00Z' })],
    USER_EMAIL
  )
  assert.equal(http.calls.length, 0, 'a dormant registrar issues no requests')
  const dormant = logs.entries.find((entry) => entry.message === '[call-watch-registrar] dormant')
  assert.deepEqual(
    dormant?.context,
    { reason: 'feature_disabled' },
    'the dormant log carries the gate reason so field triage can tell WHY'
  )
  assert.equal(engine.hasActiveWatch(sha(urlFor('nobody-home'))), false, 'dormancy stores nothing')
  await engine.flushState()
  assert.equal(existsSync(statePath), false, 'a dormant registrar never writes state')

  assertNoPii(logs.entries, 'dormant')
}

// ---------------------------------------------------------------------------
// Bundle purity (mirrors verify-call-signals.ts)
// ---------------------------------------------------------------------------

/**
 * The harness must bundle the pure core ONLY. `call-watch-registrar.ts`
 * (the runtime layer) reaches `call-signals.ts` → logger / auth-session, which
 * `require("electron")` at module scope and would crash this plain-Node
 * bundle. Needles are assembled at runtime so this check cannot match its own
 * source text.
 */
function assertBundleIsRuntimeFree(): void {
  const bundlePath = process.argv[1]
  assert.ok(
    bundlePath && existsSync(bundlePath) && bundlePath.endsWith('.cjs'),
    'run this through `npm run verify:call-watch-registrar` so the built bundle can be inspected'
  )
  const bundle = readFileSync(bundlePath, 'utf8')
  const runtimeNeedles = [
    `require(${JSON.stringify('electron')})`,
    ['electron', 'log'].join('-'),
    ['@azure', 'msal-node'].join('/'),
    ['getStorageApi', 'AccessToken'].join(''),
    ['createCallWatch', 'Transport'].join('')
  ]
  for (const needle of runtimeNeedles) {
    assert.ok(
      !bundle.includes(needle),
      `the harness bundle must not contain "${needle}" — import the pure core, not the runtime layer`
    )
  }
}

async function main(): Promise<void> {
  try {
    // Planner (pure, spec E1/E3/E4).
    scenarioCapAdmissionSoonestFirst()
    scenarioCancelledAndEndedRemove()
    scenarioRescheduleReRegisters()
    scenarioAbsentFromDeltaIsNotRemoved()
    scenarioIneligibleCandidatesNeverRegister()
    scenarioRemovalFreesASlot()
    scenarioUnparseableStoredEndIsReaped()

    // Engine (injected transport, real fs persistence).
    await scenarioEngineRegistersAndPersists()
    await scenario409NotStoredThenRetried()
    await scenarioDeleteFailureStillDrops()
    await scenarioRescheduleExecutesDeleteBeforePost()
    await scenarioOverlappingSyncIsNoOp()
    await scenarioStateRoundTripAndCorruption()
    await scenarioDormantWhenTransportUnavailable()

    assertBundleIsRuntimeFree()
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }

  console.log('Call-watch registrar verification passed')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
