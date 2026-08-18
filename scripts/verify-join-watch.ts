import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  deriveCallPresence,
  type CallPresence,
  decideFalseStart,
  readAutoStartTrigger,
  createJoinWatchEngine,
  JOIN_WATCH_LEAD_MS,
  JOIN_WATCH_PROMPT_OFFSET_MS,
  JOIN_WATCH_POLL_INTERVAL_MS,
  JOIN_WATCH_DISARM_AFTER_END_MS,
  type JoinWatchEngine,
  type JoinWatchDeps
} from '../src/main/join-watch-core'
import type { GraphEventDecision } from '../src/main/graph/types'
import type { CallSignal } from '../src/main/call-signals-core'

let seqCounter = 0
/** Signals in the exact shape `parseCallSignals` produces; `seq` is
 *  monotonic so ordering matches the store (chronological seq, spec E2). */
function sig(type: CallSignal['type'], receivedUtc: string): CallSignal {
  seqCounter += 1
  return { seq: `${receivedUtc.replace(/[-:.TZ]/g, '')}-${String(seqCounter).padStart(4, '0')}`, type, event_utc: receivedUtc, received_utc: receivedUtc }
}

const T = (min: number): string => new Date(Date.UTC(2026, 7, 20, 10, 0, 0) + min * 60_000).toISOString()

// ---- deriveCallPresence -----------------------------------------------------
{
  const none: CallPresence = deriveCallPresence([])
  assert.deepEqual(none, { inCall: false, endedAtOrAfterStart: false, lastSignalUtc: null })

  const early = deriveCallPresence([sig('recorder_rejoined', T(-30))])
  assert.equal(early.inCall, true, 'early joiner still in')

  const leftAgain = deriveCallPresence([sig('recorder_rejoined', T(-30)), sig('recorder_left', T(-10))])
  assert.equal(leftAgain.inCall, false)

  const rejoin = deriveCallPresence([sig('recorder_rejoined', T(-30)), sig('recorder_left', T(-10)), sig('recorder_rejoined', T(15))])
  assert.equal(rejoin.inCall, true)

  // Pre-start call_ended (camera check) → not in call, NOT "ended".
  const preEnd = deriveCallPresence([sig('recorder_rejoined', T(-25)), sig('call_ended', T(-20))], T(0))
  assert.equal(preEnd.inCall, false)
  assert.equal(preEnd.endedAtOrAfterStart, false)

  // Post-start call_ended with no later IN → ended.
  const postEnd = deriveCallPresence([sig('recorder_rejoined', T(0)), sig('call_ended', T(30))], T(0))
  assert.equal(postEnd.inCall, false)
  assert.equal(postEnd.endedAtOrAfterStart, true)

  // Boundary: call_ended AT scheduledStartUtc counts as ended (>=, not >).
  // A mutation of >= to > must make this fail.
  const atBoundary = deriveCallPresence([sig('recorder_rejoined', T(-5)), sig('call_ended', T(0))], T(0))
  assert.equal(atBoundary.endedAtOrAfterStart, true, 'call_ended exactly at scheduledStartUtc must count as ended')

  // Post-start call_ended followed by a fresh IN → back in call, not ended.
  const restarted = deriveCallPresence([sig('recorder_rejoined', T(0)), sig('call_ended', T(30)), sig('recorder_rejoined', T(35))], T(0))
  assert.equal(restarted.inCall, true)
  assert.equal(restarted.endedAtOrAfterStart, false)

  // A late-delivered recorder_left after call_ended must not reset "ended".
  const endedThenLeft = deriveCallPresence([sig('recorder_rejoined', T(0)), sig('call_ended', T(30)), sig('recorder_left', T(31))], T(0))
  assert.equal(endedThenLeft.inCall, false)
  assert.equal(endedThenLeft.endedAtOrAfterStart, true)

  // Out-of-order input is sorted by seq before walking.
  const chrono = [sig('recorder_rejoined', T(-30)), sig('recorder_left', T(-10))]
  const shuffled = deriveCallPresence([...chrono].reverse(), T(0))
  assert.equal(shuffled.inCall, false)
  assert.equal(shuffled.lastSignalUtc, T(-10), 'lastSignalUtc follows sorted order, not input order')
}

// ---- decideFalseStart (J4) ---------------------------------------------------
{
  const base = { trigger: 'join' as const, scheduledStartUtc: T(0), startedAtUtc: T(-2) }
  // Left at −1, grace expired at 0 → discard.
  assert.equal(decideFalseStart({ ...base, stopReason: 'grace_expired', nowUtc: T(0) }), 'discard')
  // Ended at +3 → deliver (after start + 2).
  assert.equal(decideFalseStart({ ...base, stopReason: 'grace_expired', nowUtc: T(3) }), 'deliver')
  // Boundary: exactly start + 2 min → deliver (rule is strictly before).
  assert.equal(decideFalseStart({ ...base, stopReason: 'grace_expired', nowUtc: T(2) }), 'deliver')
  // Ended by call_ended → deliver regardless of time.
  assert.equal(decideFalseStart({ ...base, stopReason: 'call_ended', nowUtc: T(0) }), 'deliver')
  // Scheduled end / manual → deliver.
  assert.equal(decideFalseStart({ ...base, stopReason: 'scheduled_end', nowUtc: T(0) }), 'deliver')
  assert.equal(decideFalseStart({ ...base, stopReason: 'manual', nowUtc: T(0) }), 'deliver')
  // Upload-now override → deliver (human explicitly ended it).
  assert.equal(decideFalseStart({ ...base, stopReason: 'upload_now', nowUtc: T(0) }), 'deliver')
  // Prompt- and calendar-triggered are never discarded.
  assert.equal(decideFalseStart({ ...base, trigger: 'prompt', stopReason: 'grace_expired', nowUtc: T(0) }), 'deliver')
  assert.equal(decideFalseStart({ ...base, trigger: 'calendar', stopReason: 'grace_expired', nowUtc: T(0) }), 'deliver')
  assert.equal(decideFalseStart({ ...base, trigger: undefined, stopReason: 'grace_expired', nowUtc: T(0) }), 'deliver')
  // Duration guard: started at −10 (a rescheduled meeting), 8 min long → deliver.
  assert.equal(decideFalseStart({ ...base, startedAtUtc: T(-10), stopReason: 'grace_expired', nowUtc: T(-2) }), 'deliver')
  // Duration boundary: exactly 5 min → deliver.
  assert.equal(decideFalseStart({ ...base, startedAtUtc: T(-4), stopReason: 'grace_expired', nowUtc: T(1) }), 'deliver')
  // Missing / unparseable times → cannot prove short → deliver.
  assert.equal(decideFalseStart({ ...base, startedAtUtc: undefined, stopReason: 'grace_expired', nowUtc: T(0) }), 'deliver')
  assert.equal(decideFalseStart({ ...base, scheduledStartUtc: 'garbage', stopReason: 'grace_expired', nowUtc: T(0) }), 'deliver')
  assert.equal(decideFalseStart({ ...base, stopReason: 'grace_expired', nowUtc: 'garbage' }), 'deliver')
}

// ---- readAutoStartTrigger (J6) -----------------------------------------------
{
  assert.equal(readAutoStartTrigger({}, {}), 'join')
  assert.equal(readAutoStartTrigger({}, { MN_AUTO_START_TRIGGER: 'calendar' }), 'calendar')
  assert.equal(readAutoStartTrigger({}, { MN_AUTO_START_TRIGGER: ' Calendar ' }), 'calendar')
  assert.equal(readAutoStartTrigger({}, { MN_AUTO_START_TRIGGER: 'nonsense' }), 'join', 'unknown → join (fail closed)')
  assert.equal(readAutoStartTrigger({}, { MN_AUTO_START_TRIGGER: '' }), 'join')
  // Layers win over process env (they are the %PROGRAMDATA%/bundled files).
  assert.equal(readAutoStartTrigger({ MN_AUTO_START_TRIGGER: 'join' }, { MN_AUTO_START_TRIGGER: 'calendar' }), 'join')
  assert.equal(readAutoStartTrigger({ MN_AUTO_START_TRIGGER: 'calendar' }, {}), 'calendar')
  // An EMPTY layer value must not mask a process-env value.
  assert.equal(readAutoStartTrigger({ MN_AUTO_START_TRIGGER: '' }, { MN_AUTO_START_TRIGGER: 'calendar' }), 'calendar')
  assert.equal(readAutoStartTrigger({ MN_AUTO_START_TRIGGER: '   ' }, { MN_AUTO_START_TRIGGER: 'calendar' }), 'calendar')
}

// ---- bundle purity ---------------------------------------------------------
{
  const bundle = join(process.cwd(), 'out', 'verify-join-watch.cjs')
  if (existsSync(bundle)) {
    const src = readFileSync(bundle, 'utf8')
    assert.ok(!/require\(["']electron["']\)/.test(src), 'join-watch-core must not import electron')
  }
}

// ---- engine (J1–J3, J5) ------------------------------------------------------

/** Production-shaped decision (host-owned online meeting). Fields that
 *  `filter.ts` couples are DERIVED here exactly as production does: a
 *  candidate before start−lead is `not_due_yet` AND `autoRecordEligible:false`. */
function decisionAt(opts: {
  key: string
  startUtc: string
  endUtc: string
  nowUtc: string
  joinWebUrl?: string
  organizer?: boolean
  title?: string
}): GraphEventDecision {
  const nowMs = Date.parse(opts.nowUtc)
  const due = Date.parse(opts.startUtc) - JOIN_WATCH_LEAD_MS <= nowMs
  const organizer = opts.organizer ?? true
  return {
    eventId: `evt-${opts.key}`,
    idempotencyKey: opts.key,
    status: 'candidate',
    reason: !organizer ? 'not_organizer' : due ? 'eligible' : 'not_due_yet',
    autoRecordEligible: organizer && due,
    metadata: {
      title: opts.title ?? `Meeting ${opts.key}`,
      attendees: [],
      meetingId: `m-${opts.key}`,
      joinWebUrl: opts.joinWebUrl ?? `https://teams.microsoft.com/l/meetup-join/${opts.key}`,
      organizerEmail: 'joseph@factor1.com.au',
      scheduledStartUtc: opts.startUtc
    },
    logContext: {
      eventIdHash: `h-${opts.key}`,
      startUtc: opts.startUtc,
      endUtc: opts.endUtc,
      isOrganizer: organizer,
      isCancelled: false,
      isAllDay: false,
      attendeeCount: 2,
      isOnlineMeeting: true
    }
  }
}

interface Fake {
  engine: JoinWatchEngine
  now: () => number
  advance: (ms: number) => Promise<void>
  /** `latencyMs > 0` resolves fetches via a FAKE timer instead of a microtask,
   *  so "the first poll has not answered yet" is a reachable state. */
  http: { history: Record<string, CallSignal[]>; fail: boolean; throws: boolean; latencyMs: number; calls: number }
  started: Array<{ key: string; trigger: string }>
  prompted: string[]
  disarmed: string[]
  recordingActive: { value: boolean }
  promptedStore: Set<string>
  /** Effects that throw when set — the engine must survive every one (safe()).
   *  `rejectNextStart` makes the next `startRecording` return false once. */
  effects: { throwStart: boolean; throwPrompt: boolean; throwDisarm: boolean; rejectNextStart: boolean }
  /** Every log call, serialised — asserted free of URLs and emails. */
  logs: string[]
  /** Timers still scheduled — asserted zero after disarm/dispose (no leaks). */
  pending: () => number
}

/** Drain microtasks so async poll ticks settle inside the fake clock. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function makeFake(nowUtc: string, hasWatch: (hash: string) => boolean = () => true): Fake {
  let nowMs = Date.parse(nowUtc)
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let nextId = 1
  const http = { history: {} as Record<string, CallSignal[]>, fail: false, throws: false, latencyMs: 0, calls: 0 }
  const started: Fake['started'] = []
  const prompted: string[] = []
  const disarmed: string[] = []
  const recordingActive = { value: false }
  const promptedStore = new Set<string>()
  const effects = { throwStart: false, throwPrompt: false, throwDisarm: false, rejectNextStart: false }
  const logs: string[] = []
  const timerHost: JoinWatchDeps['timers'] = {
    setTimeout: (fn, ms) => { const id = nextId++; timers.push({ at: nowMs + ms, fn, id }); return id },
    clearTimeout: (h) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1) }
  }
  const answer = (hash: string): CallSignal[] | null => {
    if (http.throws) throw new Error('relay exploded')
    if (http.fail) return null
    return http.history[hash] ?? []
  }
  const deps: JoinWatchDeps = {
    hasActiveWatch: hasWatch,
    joinUrlHash: (url) => `hash(${url})`,
    fetchSignals: (hash) => {
      http.calls += 1
      if (http.latencyMs <= 0) return Promise.resolve().then(() => answer(hash))
      return new Promise((resolve, reject) => {
        timerHost.setTimeout(() => {
          try { resolve(answer(hash)) } catch (e) { reject(e) }
        }, http.latencyMs)
      })
    },
    isRecordingActive: () => recordingActive.value,
    startRecording: (m, trigger) => {
      started.push({ key: m.idempotencyKey, trigger })
      if (effects.throwStart) throw new Error('start effect threw')
      if (effects.rejectNextStart) { effects.rejectNextStart = false; return false }
      return true
    },
    showPrompt: (m) => {
      prompted.push(m.idempotencyKey)
      if (effects.throwPrompt) throw new Error('prompt effect threw')
    },
    onDisarm: (m) => {
      disarmed.push(m.idempotencyKey)
      if (effects.throwDisarm) throw new Error('disarm effect threw')
    },
    promptedKeys: { has: (k) => promptedStore.has(k), add: (k) => { promptedStore.add(k) } },
    timers: timerHost,
    now: () => nowMs,
    log: (level, message, context) => { logs.push(`${level} ${message} ${JSON.stringify(context ?? {})}`) }
  }
  const engine = createJoinWatchEngine(deps)
  /** Advance the fake clock, firing due timers in order and settling async
   *  work before the loop and after each fired timer, so a poll kicked by a
   *  sync-time arm (or by a fired timer) can reschedule and itself fire. */
  const advance = async (ms: number): Promise<void> => {
    const target = nowMs + ms
    await settle()
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const next = timers[0]
      if (!next || next.at > target) break
      timers.shift()
      nowMs = next.at
      next.fn()
      await settle()
    }
    nowMs = target
    await settle()
  }
  return {
    engine, now: () => nowMs, advance, http, started, prompted, disarmed, recordingActive, promptedStore,
    effects, logs, pending: () => timers.length
  }
}

const H = (key: string): string => `hash(https://teams.microsoft.com/l/meetup-join/${key})`
const MIN = 60_000
const POLL = JOIN_WATCH_POLL_INTERVAL_MS + 1

/** Sync one host-owned meeting `key` (start T(startMin), end T(endMin)) at the fake's current time. */
function syncOne(f: Fake, key: string, startMin: number, endMin: number, extra: Partial<Parameters<typeof decisionAt>[0]> = {}): void {
  f.engine.handleSyncDecisions([decisionAt({ key, startUtc: T(startMin), endUtc: T(endMin), nowUtc: new Date(f.now()).toISOString(), ...extra })])
}

function assertNoPii(f: Fake): void {
  for (const line of f.logs) {
    assert.ok(!/https?:\/\//.test(line), `log must not carry a URL: ${line}`)
    assert.ok(!/@/.test(line), `log must not carry an email: ${line}`)
    assert.ok(!/meetup-join/.test(line), `log must not carry a join URL fragment: ${line}`)
    assert.ok(!/Meeting \w/.test(line), `log must not carry a title: ${line}`)
  }
}

/** s1 — early join, still in at −3 → start at exactly −3 (J1). */
async function scenario1_earlyJoinStillIn(): Promise<void> {
  const f = makeFake(T(-30))
  f.http.history[H('a')] = [sig('recorder_rejoined', T(-30))]
  syncOne(f, 'a', 0, 60)
  assert.equal(f.engine.getPhase('a'), 'tracked')
  await f.advance(26 * MIN)
  assert.deepEqual(f.started, [], 'nothing before −3 even though the recorder is in the call')
  assert.equal(f.http.calls, 0, 'no polling before the arm')
  await f.advance(1 * MIN + 1)
  assert.deepEqual(f.started, [{ key: 'a', trigger: 'join' }])
  assert.equal(f.engine.getPhase('a'), 'recording')
  // Once recording, polling stops: the attach poller owns the rest (J2).
  const callsAtStart = f.http.calls
  await f.advance(5 * MIN)
  assert.equal(f.http.calls, callsAtStart, 'no polls once recording')
  assert.deepEqual(f.prompted, [], 'no prompt for a meeting that is recording')
  assertNoPii(f)
}

/** s2 — early join, left at −10, no return → nothing; prompt at +2, once (J3). */
async function scenario2_leftEarlyNoReturn(): Promise<void> {
  const f = makeFake(T(-30))
  f.http.history[H('b')] = [sig('recorder_rejoined', T(-30)), sig('recorder_left', T(-10))]
  syncOne(f, 'b', 0, 60)
  await f.advance(32 * MIN - 1)
  assert.deepEqual(f.prompted, [], 'no prompt before +2')
  await f.advance(2)
  assert.deepEqual(f.started, [])
  assert.deepEqual(f.prompted, ['b'], 'prompt at exactly +2')
  assert.ok(f.promptedStore.has('b'), 'prompted key persisted')
  await f.advance(30 * MIN)
  assert.deepEqual(f.prompted, ['b'], 'prompt fires once')
  assert.equal(f.engine.getPhase('b'), 'armed', 'still armed after the prompt — a later join still starts')
  assertNoPii(f)
}

/** s3 — left at −10, rejoin at +15 → start on the +15 signal (J1). */
async function scenario3_rejoinLate(): Promise<void> {
  const f = makeFake(T(-30))
  f.http.history[H('c')] = [sig('recorder_rejoined', T(-30)), sig('recorder_left', T(-10))]
  syncOne(f, 'c', 0, 60)
  await f.advance(45 * MIN)
  assert.deepEqual(f.started, [])
  assert.deepEqual(f.prompted, ['c'], 'prompted at +2 while idle')
  f.http.history[H('c')].push(sig('recorder_rejoined', T(15)))
  await f.advance(POLL)
  assert.deepEqual(f.started, [{ key: 'c', trigger: 'join' }])
  assertNoPii(f)
}

/** s4 — join at +0:30 → start on signal (J1). */
async function scenario4_joinAfterStart(): Promise<void> {
  const f = makeFake(T(-3))
  syncOne(f, 'd', 0, 60)
  assert.equal(f.engine.getPhase('d'), 'armed', 'sync at exactly −3 arms immediately')
  await f.advance(3.5 * MIN)
  assert.deepEqual(f.started, [])
  assert.ok(f.http.calls > 5, 'polling every 5 s while armed')
  f.http.history[H('d')] = [sig('recorder_rejoined', T(0.5))]
  await f.advance(POLL)
  assert.deepEqual(f.started, [{ key: 'd', trigger: 'join' }])
  assertNoPii(f)
}

/** s5 — call_ended at/after start with no later IN → disarm, no start, no prompt (J2). */
async function scenario5_callEndedAfterStart(): Promise<void> {
  const f = makeFake(T(-5))
  f.http.history[H('e')] = [sig('recorder_rejoined', T(-4)), sig('recorder_left', T(-3)), sig('call_ended', T(1))]
  syncOne(f, 'e', 0, 60)
  await f.advance(7 * MIN)
  assert.deepEqual(f.started, [])
  assert.deepEqual(f.disarmed, ['e'])
  assert.deepEqual(f.prompted, [], 'no prompt for a meeting that left armed before +2')
  assert.equal(f.engine.getPhase('e'), undefined, 'disarmed meetings are forgotten')
  assert.equal(f.pending(), 0, 'no timers leak after disarm')
  assertNoPii(f)
}

/** s5b — call_ended BEFORE start (camera check) does not disarm; a later IN starts (J2). */
async function scenario5b_callEndedBeforeStart(): Promise<void> {
  const f = makeFake(T(-30))
  f.http.history[H('e2')] = [sig('recorder_rejoined', T(-25)), sig('call_ended', T(-20))]
  syncOne(f, 'e2', 0, 60)
  await f.advance(29 * MIN)
  assert.deepEqual(f.disarmed, [])
  assert.equal(f.engine.getPhase('e2'), 'armed')
  f.http.history[H('e2')].push(sig('recorder_rejoined', T(-1)))
  await f.advance(2 * MIN)
  assert.deepEqual(f.started, [{ key: 'e2', trigger: 'join' }])
  assertNoPii(f)
}

/** s6 — no active watch → never starts by signal, never polls; prompt at +2; Record now starts with 'prompt' (J2/J3). */
async function scenario6_noWatchPromptOnly(): Promise<void> {
  const f = makeFake(T(-5), () => false)
  f.http.history[H('f')] = [sig('recorder_rejoined', T(-4))]
  syncOne(f, 'f', 0, 60)
  await f.advance(8 * MIN)
  assert.deepEqual(f.started, [])
  assert.deepEqual(f.prompted, ['f'])
  assert.equal(f.http.calls, 0, 'never polls without a watch')
  f.engine.acceptPrompt('f')
  assert.deepEqual(f.started, [{ key: 'f', trigger: 'prompt' }])
  assert.equal(f.engine.getPhase('f'), 'recording')
  f.engine.acceptPrompt('f')
  assert.equal(f.started.length, 1, 'accepting twice does not start twice')
  f.engine.acceptPrompt('nope')
  assert.equal(f.started.length, 1, 'unknown key is a no-op')
  assertNoPii(f)
}

/** s7 — prompt (and join start) suppressed while another recording is live;
 *  persisted "prompted" survives a rebuild; a first-time arm after +2 prompts at once (J3). */
async function scenario7_promptSuppressionAndPersistence(): Promise<void> {
  const f = makeFake(T(-3))
  f.recordingActive.value = true
  f.http.history[H('g')] = [sig('recorder_rejoined', T(-4))]
  syncOne(f, 'g', 0, 60)
  await f.advance(8 * MIN)
  assert.deepEqual(f.started, [], 'a join never interrupts an active recording')
  assert.deepEqual(f.prompted, [], 'prompt suppressed while a recording is active')
  assert.equal(f.engine.getPhase('g'), 'armed', 'still armed: polling continues')
  assert.equal(f.logs.filter((l) => /start refused/.test(l)).length, 1, 'refusal logged once per streak, not per poll')
  // The other recording ends while the recorder is still in the call → start on the next poll.
  f.recordingActive.value = false
  await f.advance(POLL)
  assert.deepEqual(f.started, [{ key: 'g', trigger: 'join' }])

  // Restart at +3 with "prompted" persisted → no second toast.
  const g2 = makeFake(T(3))
  g2.promptedStore.add('g2')
  syncOne(g2, 'g2', 0, 60)
  await g2.advance(5 * MIN)
  assert.deepEqual(g2.prompted, [], 'persisted prompted key suppresses the toast across restart')

  // First-time arm after +2 (app started mid-meeting, never prompted) → prompt
  // once — but a WATCHED meeting waits one poll interval so an in-call
  // recorder starts instead of seeing a flash toast (s20 pins the in-call case).
  const g3 = makeFake(T(3))
  syncOne(g3, 'g3', 0, 60)
  await g3.advance(1)
  assert.deepEqual(g3.prompted, [], 'watched late arm defers the prompt past the first poll')
  await g3.advance(POLL)
  assert.deepEqual(g3.prompted, ['g3'], 'late arm past +2 prompts after the first poll')
  await g3.advance(10 * MIN)
  assert.deepEqual(g3.prompted, ['g3'])
  assertNoPii(f)
  assertNoPii(g2)
  assertNoPii(g3)
}

/** s8 — rearm after a discarded false start → later IN starts a fresh recording (J4). */
async function scenario8_rearmAfterFalseStart(): Promise<void> {
  const f = makeFake(T(-3))
  f.http.history[H('h')] = [sig('recorder_rejoined', T(-2))]
  syncOne(f, 'h', 0, 60)
  await f.advance(2 * MIN)
  assert.deepEqual(f.started, [{ key: 'h', trigger: 'join' }])
  f.http.history[H('h')].push(sig('recorder_left', T(-1)))
  f.engine.rearm('h')
  assert.equal(f.engine.getPhase('h'), 'armed')
  await f.advance(6 * MIN)
  assert.equal(f.started.length, 1, 'no second start while the recorder is out')
  // Re-armed and idle at +2 → the J3 prompt applies to the fresh arm.
  assert.deepEqual(f.prompted, ['h'])
  f.http.history[H('h')].push(sig('recorder_rejoined', T(5)))
  await f.advance(POLL)
  assert.deepEqual(f.started, [{ key: 'h', trigger: 'join' }, { key: 'h', trigger: 'join' }])
  f.engine.rearm('h')
  await f.advance(POLL)
  assert.equal(f.started.length, 3, 'rearm from recording resumes polling; still-in-call restarts')
  f.engine.rearm('h')
  f.engine.rearm('h')
  await f.advance(POLL)
  assert.equal(f.started.length, 4, 'double rearm does not double-poll or double-start')
  assertNoPii(f)
}

/** s12 — two overlapping armed meetings: a join starts THAT one; the other's prompt is suppressed (J2). */
async function scenario12_overlappingMeetings(): Promise<void> {
  const f = makeFake(T(-3))
  f.http.history[H('x')] = [sig('recorder_rejoined', T(-1))]
  f.engine.handleSyncDecisions([
    decisionAt({ key: 'x', startUtc: T(0), endUtc: T(60), nowUtc: T(-3) }),
    decisionAt({ key: 'y', startUtc: T(0), endUtc: T(60), nowUtc: T(-3) })
  ])
  await f.advance(2 * MIN)
  assert.deepEqual(f.started, [{ key: 'x', trigger: 'join' }])
  assert.equal(f.engine.getPhase('y'), 'armed')
  f.recordingActive.value = true
  await f.advance(4 * MIN)
  assert.deepEqual(f.prompted, [], 'y prompt suppressed while x records')
  assert.equal(f.started.length, 1)
  // Suppression is final for this process but does not consume the once-only
  // key: y stays armed, un-prompted, and a restart inside the window would ask.
  f.recordingActive.value = false
  await f.advance(10 * MIN)
  assert.deepEqual(f.prompted, [], 'a suppressed prompt is not re-fired later')
  assert.equal(f.engine.getPhase('y'), 'armed')
  assert.ok(!f.promptedStore.has('y'), 'suppression does not consume the once-only key')
  assertNoPii(f)
}

/** s13 — fetch failing (null) or throwing → unknown → no start; polling continues; prompt still fires (J2). */
async function scenario13_fetchFailureIsUnknown(): Promise<void> {
  const f = makeFake(T(-3))
  f.http.fail = true
  f.http.history[H('z')] = [sig('recorder_rejoined', T(-4))]
  syncOne(f, 'z', 0, 60)
  await f.advance(6 * MIN)
  assert.deepEqual(f.started, [])
  assert.deepEqual(f.prompted, ['z'])
  assert.ok(f.http.calls > 10, 'keeps polling through failures')
  const before = f.http.calls
  f.http.fail = false
  f.http.throws = true
  await f.advance(3 * POLL)
  assert.ok(f.http.calls >= before + 3, 'a throwing fetch does not kill the loop')
  assert.deepEqual(f.started, [])
  f.http.throws = false
  await f.advance(POLL)
  assert.deepEqual(f.started, [{ key: 'z', trigger: 'join' }], 'recovers once the relay answers')
  assertNoPii(f)
}

/** s14 — non-organizer meetings are ignored entirely (host gate). */
async function scenario14_nonOrganizerIgnored(): Promise<void> {
  const f = makeFake(T(-3))
  f.http.history[H('n')] = [sig('recorder_rejoined', T(-4))]
  syncOne(f, 'n', 0, 60, { organizer: false })
  await f.advance(6 * MIN)
  assert.deepEqual(f.started, [])
  assert.deepEqual(f.prompted, [])
  assert.equal(f.engine.getPhase('n'), undefined)
  assert.equal(f.http.calls, 0)
  // Missing joinWebUrl / times → not tracked either.
  const g = makeFake(T(-3))
  const d = decisionAt({ key: 'q', startUtc: T(0), endUtc: T(60), nowUtc: T(-3) })
  d.metadata.joinWebUrl = undefined
  g.engine.handleSyncDecisions([d])
  assert.equal(g.engine.getPhase('q'), undefined, 'no join URL → nothing to watch')
  const d2 = decisionAt({ key: 'q2', startUtc: T(0), endUtc: T(60), nowUtc: T(-3) })
  d2.logContext.endUtc = undefined
  g.engine.handleSyncDecisions([d2])
  assert.equal(g.engine.getPhase('q2'), undefined, 'no end time → not tracked')
  // Excluded decisions (status) are ignored even when isOrganizer is true.
  const d3 = decisionAt({ key: 'q3', startUtc: T(0), endUtc: T(60), nowUtc: T(-3) })
  d3.status = 'excluded'
  d3.reason = 'cancelled'
  g.engine.handleSyncDecisions([d3])
  assert.equal(g.engine.getPhase('q3'), undefined)
  // Key falls back to eventId when idempotencyKey is absent.
  const d4 = decisionAt({ key: 'q4', startUtc: T(0), endUtc: T(60), nowUtc: T(-3) })
  d4.idempotencyKey = undefined
  g.engine.handleSyncDecisions([d4])
  assert.equal(g.engine.getPhase('evt-q4'), 'armed')
  assertNoPii(f)
  assertNoPii(g)
}

/** s15 — disarm at end + 10 min; a vanished decision (cancelled) disarms; a past-end vanish waits for the window (J2). */
async function scenario15_windowCloseAndVanish(): Promise<void> {
  const f = makeFake(T(-3))
  syncOne(f, 'd', 0, 60)
  await f.advance(72 * MIN)
  assert.deepEqual(f.disarmed, [], 'still armed at end + 9')
  await f.advance(2 * MIN)
  assert.deepEqual(f.disarmed, ['d'])
  assert.equal(f.pending(), 0, 'no timers leak after the window closes')
  const calls = f.http.calls
  await f.advance(5 * MIN)
  assert.equal(f.http.calls, calls, 'no polls after disarm')

  const g = makeFake(T(-3))
  syncOne(g, 'd2', 0, 60)
  g.engine.handleSyncDecisions([])
  assert.deepEqual(g.disarmed, ['d2'], 'vanished before end = cancelled → disarm')
  assert.equal(g.pending(), 0)

  // Already-tracked and past scheduled end: Graph's window no longer returns
  // it, so absence is not cancellation — the end+10 timer owns that disarm.
  const h = makeFake(T(-3))
  syncOne(h, 'd3', 0, 60)
  await h.advance(64 * MIN)
  h.engine.handleSyncDecisions([])
  assert.deepEqual(h.disarmed, [], 'past-end absence keeps the arm window open')
  h.http.history[H('d3')] = [sig('recorder_rejoined', T(62))]
  await h.advance(POLL)
  assert.deepEqual(h.started, [{ key: 'd3', trigger: 'join' }], 'late join inside end+10 still starts')

  // A meeting whose window is already closed at sync time is never tracked.
  const i = makeFake(T(75))
  syncOne(i, 'd4', 0, 60)
  assert.equal(i.engine.getPhase('d4'), undefined)
  assert.equal(i.pending(), 0)

  // A RECORDING meeting that vanishes is left alone (the stop machine owns it).
  const j = makeFake(T(-3))
  j.http.history[H('d5')] = [sig('recorder_rejoined', T(-2))]
  syncOne(j, 'd5', 0, 60)
  await j.advance(1)
  assert.equal(j.engine.getPhase('d5'), 'recording')
  j.engine.handleSyncDecisions([])
  assert.equal(j.engine.getPhase('d5'), 'recording')
  assert.deepEqual(j.disarmed, [])
  for (const fake of [f, g, h, i, j]) assertNoPii(fake)
}

/** s16 — reschedule re-tracks from scratch; a same-time re-sync is a no-op (E4-style). */
async function scenario16_rescheduleRetracks(): Promise<void> {
  const f = makeFake(T(-30))
  syncOne(f, 'k', 0, 60)
  syncOne(f, 'k', 0, 60)
  assert.deepEqual(f.disarmed, [], 'same times → same tracking')
  syncOne(f, 'k', 30, 90)
  assert.deepEqual(f.disarmed, ['k'], 'old tracking disarmed once')
  assert.equal(f.engine.getPhase('k'), 'tracked')
  await f.advance(27 * MIN + 1)
  assert.equal(f.engine.getPhase('k'), 'tracked', 'the old −3 arm timer was cleared')
  await f.advance(30 * MIN)
  assert.equal(f.engine.getPhase('k'), 'armed', 'armed at the NEW start − 3')
  f.http.history[H('k')] = [sig('recorder_rejoined', T(28))]
  await f.advance(POLL)
  assert.deepEqual(f.started, [{ key: 'k', trigger: 'join' }])
  assertNoPii(f)
}

/** s16b — a same-key reschedule while RECORDING (organiser extends the meeting
 *  mid-call) must not disarm or re-arm: refresh the payload and re-point only
 *  the end + 10 GC timer. */
async function scenario16b_rescheduleWhileRecording(): Promise<void> {
  const f = makeFake(T(-3))
  f.http.history[H('k')] = [sig('recorder_rejoined', T(-2))]
  syncOne(f, 'k', 0, 60)
  await f.advance(1)
  assert.equal(f.engine.getPhase('k'), 'recording')
  syncOne(f, 'k', 0, 75)
  assert.deepEqual(f.disarmed, [], 'extending a recording meeting never disarms')
  assert.equal(f.started.length, 1, 'never re-armed / re-started')
  assert.equal(f.engine.getPhase('k'), 'recording')
  await f.advance(74 * MIN)
  assert.equal(f.engine.getPhase('k'), 'recording', 'still tracked at OLD end + 11')
  assert.deepEqual(f.disarmed, [])
  await f.advance(15 * MIN)
  assert.equal(f.engine.getPhase('k'), undefined, 'GC fired at the NEW end + 10')
  assert.deepEqual(f.disarmed, ['k'])
  assert.equal(f.pending(), 0)
  assertNoPii(f)
}

/** s17 — noteRecordingStarted (a manual recording of the same meeting) stops polling and prompting (J2). */
async function scenario17_noteRecordingStarted(): Promise<void> {
  const f = makeFake(T(-3))
  syncOne(f, 'm', 0, 60)
  f.engine.noteRecordingStarted('m')
  assert.equal(f.engine.getPhase('m'), 'recording')
  const calls = f.http.calls
  await f.advance(6 * MIN)
  assert.deepEqual(f.prompted, [])
  assert.deepEqual(f.started, [])
  assert.equal(f.http.calls, calls, 'no polls once a recording is noted')
  // Before the arm: the pending arm must not revive polling.
  const g = makeFake(T(-30))
  syncOne(g, 'm2', 0, 60)
  g.engine.noteRecordingStarted('m2')
  await g.advance(40 * MIN)
  assert.equal(g.http.calls, 0)
  assert.deepEqual(g.prompted, [])
  g.engine.noteRecordingStarted('unknown')
  assertNoPii(f)
  assertNoPii(g)
}

/** s18 — dispose clears everything: no timers, no effects afterwards. */
async function scenario18_dispose(): Promise<void> {
  const f = makeFake(T(-3))
  f.http.history[H('p')] = [sig('recorder_rejoined', T(-2))]
  f.engine.handleSyncDecisions([
    decisionAt({ key: 'p', startUtc: T(0), endUtc: T(60), nowUtc: T(-3) }),
    decisionAt({ key: 'p2', startUtc: T(30), endUtc: T(90), nowUtc: T(-3) })
  ])
  f.engine.dispose()
  assert.equal(f.pending(), 0, 'dispose clears every timer')
  const calls = f.http.calls
  await f.advance(60 * MIN)
  assert.deepEqual(f.started, [], 'the in-flight poll at dispose time must not start anything')
  assert.deepEqual(f.prompted, [])
  assert.equal(f.http.calls, calls)
  assert.equal(f.engine.getPhase('p'), undefined)
  syncOne(f, 'p3', 60, 120)
  assert.equal(f.engine.getPhase('p3'), undefined, 'disposed engine ignores syncs')
  assert.equal(f.pending(), 0)
}

/** s19 — throwing effects never escape the engine; lifecycle continues (house rule).
 *  A start effect that throws was never accepted: the meeting stays armed and
 *  the next poll retries. Logs name the effect and the error class only. */
async function scenario19_effectsNeverThrow(): Promise<void> {
  const f = makeFake(T(-3))
  f.effects.throwStart = true
  f.effects.throwPrompt = true
  f.effects.throwDisarm = true
  f.http.history[H('t')] = [sig('recorder_rejoined', T(-2))]
  f.engine.handleSyncDecisions([
    decisionAt({ key: 't', startUtc: T(0), endUtc: T(60), nowUtc: T(-3) }),
    decisionAt({ key: 't2', startUtc: T(0), endUtc: T(60), nowUtc: T(-3) })
  ])
  await f.advance(1)
  assert.deepEqual(f.started, [{ key: 't', trigger: 'join' }])
  assert.equal(f.engine.getPhase('t'), 'armed', 'a throwing start was not accepted: stays armed')
  f.effects.throwStart = false
  await f.advance(POLL)
  assert.deepEqual(f.started, [{ key: 't', trigger: 'join' }, { key: 't', trigger: 'join' }], 'next poll retries')
  assert.equal(f.engine.getPhase('t'), 'recording')
  await f.advance(5 * MIN)
  assert.deepEqual(f.prompted, ['t2'])
  assert.equal(f.engine.getPhase('t2'), 'armed')
  f.engine.handleSyncDecisions([])
  assert.deepEqual(f.disarmed, ['t2'])
  assert.equal(f.engine.getPhase('t2'), undefined, 'forgotten even though onDisarm threw')
  const threw = f.logs.filter((l) => l.startsWith('warn') && /effect threw/.test(l))
  for (const label of ['startRecording', 'showPrompt', 'onDisarm']) {
    assert.ok(threw.some((l) => l.includes(`"effect":"${label}"`) && l.includes('"name":"Error"')), `${label} throw logged with effect + name`)
  }
  assert.ok(!f.logs.some((l) => /start effect threw|prompt effect threw|disarm effect threw/.test(l)), 'exception messages never reach the log')
  assertNoPii(f)
}

/** s20 — late arm past +2 while ALREADY in call: the first poll must win, not a
 *  flash prompt. With a watch the prompt waits one poll interval. */
async function scenario20_lateArmInCallNoFlashPrompt(): Promise<void> {
  const f = makeFake(T(3))
  f.http.latencyMs = 500
  f.http.history[H('l')] = [sig('recorder_rejoined', T(0))]
  syncOne(f, 'l', 0, 60)
  await f.advance(1000)
  assert.deepEqual(f.prompted, [], 'no flash prompt before the first poll answers')
  assert.deepEqual(f.started, [{ key: 'l', trigger: 'join' }])
  await f.advance(POLL)
  assert.deepEqual(f.prompted, [], 'prompt timer was cleared by the start')
  assertNoPii(f)

  // s20b — UNWATCHED late arm keeps the immediate prompt (there is no poll to wait for).
  const g = makeFake(T(3), () => false)
  syncOne(g, 'l2', 0, 60)
  await g.advance(1)
  assert.deepEqual(g.prompted, ['l2'], 'unwatched late arm prompts immediately')
  assert.equal(g.http.calls, 0)
  assertNoPii(g)
}

/** s21 — a watch registered AFTER arming is picked up on the next same-times sync. */
async function scenario21_lateWatchPickup(): Promise<void> {
  let watch = false
  const f = makeFake(T(-3), () => watch)
  syncOne(f, 'w', 0, 60)
  await f.advance(1 * MIN)
  assert.equal(f.engine.getPhase('w'), 'armed')
  assert.equal(f.http.calls, 0, 'prompt-only while unwatched')
  watch = true
  syncOne(f, 'w', 0, 60)
  await f.advance(1)
  assert.equal(f.http.calls, 1, 'same-times re-sync starts polling once a watch exists')
  await f.advance(3 * POLL)
  assert.ok(f.http.calls >= 3, 'and keeps polling')
  syncOne(f, 'w', 0, 60)
  await f.advance(1)
  const calls = f.http.calls
  await f.advance(POLL)
  assert.ok(f.http.calls - calls <= 2, 're-sync while already polling does not double the loop')
  f.http.history[H('w')] = [sig('recorder_rejoined', T(-1))]
  await f.advance(POLL)
  assert.deepEqual(f.started, [{ key: 'w', trigger: 'join' }])
  assertNoPii(f)
}

/** s22 — startRecording returning false = not accepted: stay armed, next poll retries. */
async function scenario22_startNotAccepted(): Promise<void> {
  const f = makeFake(T(-3))
  f.effects.rejectNextStart = true
  f.http.history[H('r')] = [sig('recorder_rejoined', T(-2))]
  syncOne(f, 'r', 0, 60)
  await f.advance(1)
  assert.deepEqual(f.started, [{ key: 'r', trigger: 'join' }])
  assert.equal(f.engine.getPhase('r'), 'armed', 'a refused start does not flip to recording')
  assert.ok(f.logs.some((l) => /start not accepted/.test(l)))
  await f.advance(POLL)
  assert.deepEqual(f.started, [{ key: 'r', trigger: 'join' }, { key: 'r', trigger: 'join' }], 'next poll retried')
  assert.equal(f.engine.getPhase('r'), 'recording')
  // Prompt path too: Record now not accepted → still armed, can be accepted again.
  const g = makeFake(T(-5), () => false)
  g.effects.rejectNextStart = true
  syncOne(g, 'r2', 0, 60)
  await g.advance(8 * MIN)
  g.engine.acceptPrompt('r2')
  assert.equal(g.engine.getPhase('r2'), 'armed')
  g.engine.acceptPrompt('r2')
  assert.equal(g.engine.getPhase('r2'), 'recording')
  assert.equal(g.started.length, 2)
  assertNoPii(f)
  assertNoPii(g)
}

void (async () => {
  await scenario1_earlyJoinStillIn()
  await scenario2_leftEarlyNoReturn()
  await scenario3_rejoinLate()
  await scenario4_joinAfterStart()
  await scenario5_callEndedAfterStart()
  await scenario5b_callEndedBeforeStart()
  await scenario6_noWatchPromptOnly()
  await scenario7_promptSuppressionAndPersistence()
  await scenario8_rearmAfterFalseStart()
  await scenario12_overlappingMeetings()
  await scenario13_fetchFailureIsUnknown()
  await scenario14_nonOrganizerIgnored()
  await scenario15_windowCloseAndVanish()
  await scenario16_rescheduleRetracks()
  await scenario16b_rescheduleWhileRecording()
  await scenario17_noteRecordingStarted()
  await scenario18_dispose()
  await scenario19_effectsNeverThrow()
  await scenario20_lateArmInCallNoFlashPrompt()
  await scenario21_lateWatchPickup()
  await scenario22_startNotAccepted()

  // Pin the constants the live-smoke expectations (L1–L7) are written against.
  assert.equal(JOIN_WATCH_LEAD_MS, 3 * MIN)
  assert.equal(JOIN_WATCH_PROMPT_OFFSET_MS, 2 * MIN)
  assert.equal(JOIN_WATCH_POLL_INTERVAL_MS, 5_000)
  assert.equal(JOIN_WATCH_DISARM_AFTER_END_MS, 10 * MIN)

  console.log('join-watch verification passed')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
