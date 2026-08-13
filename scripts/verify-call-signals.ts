/**
 * Verify the call-signal state machine and storage poller (Task 12,
 * meeting-call-events spec D5/D6/D7/D9).
 *
 * Assert-based harness in the repo's `verify:*` idiom (see
 * scripts/verify-update-gate.ts). Everything here runs in plain Node: the
 * machine and the poller core take all their I/O (timers, HTTP, identity,
 * logging, control actions) by injection, so no Electron, MSAL, or network is
 * involved. Timers are a hand-rolled fake clock with manual tick control —
 * the 60s grace window is asserted at the millisecond, not slept through.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
// Imports the PURE CORE only. `call-signals.ts` (the runtime half) pulls in
// auth-msal/electron-log, which `require("electron")` at module scope; the
// bundle-purity check at the foot of this file fails if that ever creeps back.
import {
  CALL_SIGNAL_GRACE_MS,
  CALL_SIGNAL_POLL_INTERVAL_MS,
  CALL_SIGNAL_REGISTRATION_RETRY_MS,
  createCallSignalMachine,
  createCallSignalPoller,
  parseCallSignals,
  readJoinWebUrl,
  shouldArmCallSignals,
  type CallSignal,
  type CallSignalActions,
  type CallSignalHttpResponse,
  type CallSignalTimers
} from '../src/main/call-signals-core'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeClock {
  timers: CallSignalTimers
  tick(ms: number): void
  pendingCount(): number
  nowMs(): number
}

/** Minimal deterministic timer queue: fires due callbacks in time order and
 *  honours timers scheduled from inside a callback (the poll chain does that). */
function createFakeClock(): FakeClock {
  let now = 0
  let nextId = 1
  const scheduled = new Map<number, { at: number; fn: () => void }>()

  return {
    timers: {
      setTimeout(fn: () => void, ms: number): unknown {
        const id = nextId++
        scheduled.set(id, { at: now + ms, fn })
        return id
      },
      clearTimeout(handle: unknown): void {
        if (typeof handle === 'number') scheduled.delete(handle)
      }
    },
    nowMs: () => now,
    pendingCount: () => scheduled.size,
    tick(ms: number): void {
      const target = now + ms
      for (;;) {
        let dueId = -1
        let dueAt = Number.POSITIVE_INFINITY
        for (const [id, timer] of scheduled) {
          if (timer.at <= target && timer.at < dueAt) {
            dueAt = timer.at
            dueId = id
          }
        }
        if (dueId === -1) break
        const timer = scheduled.get(dueId)
        scheduled.delete(dueId)
        now = dueAt
        timer?.fn()
      }
      now = target
    }
  }
}

interface Recorder {
  actions: CallSignalActions
  calls: string[]
  reset(): void
  setPaused(paused: boolean): void
  isPaused(): boolean
}

/** Records only *effects*. `isPaused()` is a query, not an effect, so it is
 *  deliberately absent from the call log. */
function createRecorder(): Recorder {
  const calls: string[] = []
  let paused = false
  return {
    calls,
    actions: {
      pause(): void {
        calls.push('pause')
        paused = true
      },
      resume(): void {
        calls.push('resume')
        paused = false
      },
      stop(): void {
        calls.push('stop')
      },
      showPausedToast(): void {
        calls.push('showPausedToast')
      },
      closePausedToast(): void {
        calls.push('closePausedToast')
      },
      isPaused: () => paused
    },
    reset(): void {
      calls.length = 0
    },
    setPaused(value: boolean): void {
      paused = value
    },
    isPaused: () => paused
  }
}

interface HttpCall {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
}

interface FakeHttp {
  calls: HttpCall[]
  send: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string }
  ) => Promise<CallSignalHttpResponse>
}

type HttpHandler = (call: HttpCall, index: number) => CallSignalHttpResponse | Error

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
        body: init.body
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

function createFakeLog(): { entries: LogEntry[]; log: (level: 'info' | 'warn', message: string, context?: Record<string, unknown>) => void } {
  const entries: LogEntry[] = []
  return {
    entries,
    log(level, message, context): void {
      entries.push({ level, message, context })
    }
  }
}

/**
 * Desktop logs may carry status codes and state only. Applied to every poller
 * scenario's log, not just the dedicated privacy one — a leak on a rarely-hit
 * branch is exactly the leak that ships.
 */
function assertNoPii(entries: LogEntry[], label: string): void {
  const serialised = JSON.stringify(entries)
  assert.ok(!serialised.includes(JOIN_URL), `${label}: join URLs must never be logged`)
  assert.ok(!serialised.includes('meetup-join'), `${label}: no join-URL fragment may be logged`)
  assert.ok(!serialised.includes(STORAGE_TOKEN), `${label}: tokens must never be logged`)
  assert.ok(!serialised.includes(USER_EMAIL), `${label}: emails must never be logged`)
  assert.ok(!serialised.includes(USER_OID), `${label}: OIDs must never be logged`)
  assert.ok(!serialised.includes('detail'), `${label}: response bodies must never be logged`)
}

/** Let queued microtasks/promise chains settle between fake-clock ticks. */
async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

// ---------------------------------------------------------------------------
// Signal fixtures
// ---------------------------------------------------------------------------

const JOIN_URL = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_SECRET%40thread.v2/0'
const STORAGE_TOKEN = 'eyJ-fake-storage-token'
const USER_EMAIL = 'recorder@factor1.com.au'
const USER_OID = '00000000-1111-2222-3333-444444444444'

function signal(
  seq: string,
  type: CallSignal['type'],
  eventUtc: string | null = '2026-08-13T01:00:00Z'
): CallSignal {
  return { seq, type, event_utc: eventUtc, received_utc: '2026-08-13T01:00:02Z' }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function scenarioLeaveThenGraceExpiry(): void {
  const clock = createFakeClock()
  const recorder = createRecorder()
  const machine = createCallSignalMachine(recorder.actions, CALL_SIGNAL_GRACE_MS, clock.timers)

  machine.ingest([signal('001', 'recorder_left')])
  assert.deepEqual(
    recorder.calls,
    ['pause', 'showPausedToast'],
    'recorder_left while recording must pause and raise the sticky toast'
  )
  assert.equal(machine.getState(), 'grace', 'recorder_left must move the machine into grace')
  assert.equal(machine.isPausedToastVisible(), true, 'the paused toast must be marked visible')
  assert.equal(clock.pendingCount(), 1, 'exactly one grace timer must be armed')

  recorder.reset()
  clock.tick(CALL_SIGNAL_GRACE_MS - 1)
  assert.deepEqual(recorder.calls, [], 'nothing may fire one millisecond before the grace expires')

  clock.tick(1)
  assert.deepEqual(
    recorder.calls,
    ['closePausedToast', 'stop'],
    'grace expiry must close the toast and stop the recording'
  )
  assert.equal(machine.getState(), 'done', 'grace expiry ends the machine')
  assert.equal(clock.pendingCount(), 0, 'no timer may survive the grace expiry')
  assert.equal(machine.isPausedToastVisible(), false, 'the toast flag must clear on expiry')
  assert.equal(machine.getActionErrorCount(), 0, 'a healthy run must swallow nothing')
}

function scenarioRejoinDuringGrace(): void {
  const clock = createFakeClock()
  const recorder = createRecorder()
  const machine = createCallSignalMachine(recorder.actions, CALL_SIGNAL_GRACE_MS, clock.timers)

  machine.ingest([signal('001', 'recorder_left')])
  recorder.reset()

  clock.tick(26_000)
  machine.ingest([signal('002', 'recorder_rejoined')])
  assert.deepEqual(
    recorder.calls,
    ['closePausedToast', 'resume'],
    'a rejoin inside grace must close the toast and resume the signal-initiated pause'
  )
  assert.equal(machine.getState(), 'watching', 'a rejoin returns the machine to watching')
  assert.equal(clock.pendingCount(), 0, 'the grace timer must be cancelled by the rejoin')
  assert.equal(recorder.isPaused(), false, 'the resume must have unpaused the recording')

  recorder.reset()
  clock.tick(CALL_SIGNAL_GRACE_MS * 2)
  assert.deepEqual(recorder.calls, [], 'the cancelled grace timer must never fire')

  // A second leave after the rejoin must arm a fresh grace window.
  machine.ingest([signal('003', 'recorder_left')])
  assert.deepEqual(
    recorder.calls,
    ['pause', 'showPausedToast'],
    'a later leave must arm a fresh pause + grace'
  )
  assert.equal(machine.getState(), 'grace', 'the second leave re-enters grace')
}

function scenarioManualPauseThenLeave(): void {
  const clock = createFakeClock()
  const recorder = createRecorder()
  const machine = createCallSignalMachine(recorder.actions, CALL_SIGNAL_GRACE_MS, clock.timers)

  recorder.setPaused(true) // user paused from the tray before leaving the call.
  machine.ingest([signal('001', 'recorder_left')])
  assert.deepEqual(
    recorder.calls,
    ['showPausedToast'],
    'an already-paused recording must not be paused again (D6)'
  )
  assert.equal(machine.getState(), 'grace', 'grace still arms on a manual pause')
  assert.equal(clock.pendingCount(), 1, 'the grace timer arms regardless of who paused')

  recorder.reset()
  machine.ingest([signal('002', 'recorder_rejoined')])
  assert.deepEqual(
    recorder.calls,
    ['closePausedToast'],
    'auto-resume must only ever undo a signal-initiated pause (D6)'
  )
  assert.equal(recorder.isPaused(), true, 'the manual pause must survive the rejoin')
  assert.equal(machine.getState(), 'watching', 'the rejoin still leaves grace')
}

function scenarioManualResumeDuringGrace(): void {
  const clock = createFakeClock()
  const recorder = createRecorder()
  const machine = createCallSignalMachine(recorder.actions, CALL_SIGNAL_GRACE_MS, clock.timers)

  machine.ingest([signal('001', 'recorder_left')])
  recorder.reset()

  // The renderer resumes first; main mirrors it via `recording:paused-changed`
  // (setRecordingPaused(false)) and only then calls the hook.
  recorder.setPaused(false)
  machine.onManualResume()
  assert.deepEqual(
    recorder.calls,
    ['closePausedToast'],
    'a manual resume during grace closes the toast and issues no resume of its own'
  )
  assert.equal(machine.getState(), 'watching', 'manual resume cancels grace (D6: user intent wins)')
  assert.equal(clock.pendingCount(), 0, 'the grace timer must be cancelled by the manual resume')

  clock.tick(CALL_SIGNAL_GRACE_MS * 2)
  assert.deepEqual(recorder.calls, ['closePausedToast'], 'no auto-stop may follow a manual resume')

  // Outside grace the hook is inert (the user pausing/resuming at will while
  // still in the call must not disturb the machine).
  recorder.reset()
  machine.onManualResume()
  assert.deepEqual(recorder.calls, [], 'a manual resume outside grace must be a no-op')
  assert.equal(machine.getState(), 'watching', 'an inert manual resume changes no state')

  // A leave after a manual resume re-arms cleanly, and its pause is signal-initiated again.
  machine.ingest([signal('002', 'recorder_left')])
  recorder.reset()
  machine.ingest([signal('003', 'recorder_rejoined')])
  assert.deepEqual(
    recorder.calls,
    ['closePausedToast', 'resume'],
    'the signal-initiated flag must reset correctly across cycles'
  )
}

function scenarioCallEnded(): void {
  // From watching.
  const clockA = createFakeClock()
  const recorderA = createRecorder()
  const machineA = createCallSignalMachine(recorderA.actions, CALL_SIGNAL_GRACE_MS, clockA.timers)
  machineA.ingest([signal('001', 'call_ended')])
  assert.deepEqual(
    recorderA.calls,
    ['closePausedToast', 'stop'],
    'call_ended from watching must stop the recording immediately'
  )
  assert.equal(machineA.getState(), 'done', 'call_ended ends the machine')
  assert.equal(clockA.pendingCount(), 0, 'call_ended leaves no timers behind')

  // From grace.
  const clockB = createFakeClock()
  const recorderB = createRecorder()
  const machineB = createCallSignalMachine(recorderB.actions, CALL_SIGNAL_GRACE_MS, clockB.timers)
  machineB.ingest([signal('001', 'recorder_left')])
  recorderB.reset()
  machineB.ingest([signal('002', 'call_ended')])
  assert.deepEqual(
    recorderB.calls,
    ['closePausedToast', 'stop'],
    'call_ended during grace must cancel the timer and stop once'
  )
  assert.equal(clockB.pendingCount(), 0, 'the grace timer must be cancelled by call_ended')
  clockB.tick(CALL_SIGNAL_GRACE_MS * 2)
  assert.deepEqual(recorderB.calls, ['closePausedToast', 'stop'], 'stop must not fire twice')

  // Two terminal signals inside one poll response must still stop once.
  const clockC = createFakeClock()
  const recorderC = createRecorder()
  const machineC = createCallSignalMachine(recorderC.actions, CALL_SIGNAL_GRACE_MS, clockC.timers)
  machineC.ingest([signal('001', 'call_ended'), signal('002', 'call_ended')])
  assert.deepEqual(
    recorderC.calls,
    ['closePausedToast', 'stop'],
    'a batch carrying two call_ended signals must stop exactly once'
  )
}

function scenarioDedupeAndOrdering(): void {
  const clock = createFakeClock()
  const recorder = createRecorder()
  const machine = createCallSignalMachine(recorder.actions, CALL_SIGNAL_GRACE_MS, clock.timers)

  // Duplicates inside one batch.
  machine.ingest([signal('001', 'recorder_left'), signal('001', 'recorder_left')])
  assert.deepEqual(
    recorder.calls,
    ['pause', 'showPausedToast'],
    'a duplicate seq inside one batch must be ignored'
  )

  // Duplicates across batches — the GET returns ALL signals every poll.
  recorder.reset()
  machine.ingest([signal('001', 'recorder_left')])
  assert.deepEqual(recorder.calls, [], 're-delivery of a seen seq must be ignored')

  // Out-of-order batch: the rejoin arrives first in the array but sorts second.
  recorder.reset()
  recorder.setPaused(false) // the user resumed by hand, then main told the machine
  machine.onManualResume() // back to watching, grace cancelled
  recorder.reset()
  machine.ingest([signal('012', 'recorder_rejoined'), signal('011', 'recorder_left')])
  assert.deepEqual(
    recorder.calls,
    ['pause', 'showPausedToast', 'closePausedToast', 'resume'],
    'an unordered batch must be processed in seq order (leave before rejoin)'
  )
  assert.equal(machine.getState(), 'watching', 'the sorted batch ends back in watching')
  assert.equal(clock.pendingCount(), 0, 'the rejoin cancelled the grace armed earlier in the batch')

  // The hazard the seen-set actually exists for: every poll returns ALL
  // signals, and after a completed leave/rejoin cycle the machine is back in
  // `watching` — so the state guards alone would happily pause all over again.
  recorder.reset()
  machine.ingest([signal('011', 'recorder_left'), signal('012', 'recorder_rejoined')])
  assert.deepEqual(recorder.calls, [], 'a replayed leave/rejoin cycle must be fully deduped')
  assert.equal(machine.getState(), 'watching', 'a replayed cycle must not re-enter grace')
  assert.equal(clock.pendingCount(), 0, 'a replayed cycle must not arm a grace timer')

  // A stale rejoin while watching is a no-op.
  recorder.reset()
  machine.ingest([signal('013', 'recorder_rejoined')])
  assert.deepEqual(recorder.calls, [], 'a rejoin while watching must be a no-op')

  // A second leave while already in grace is ignored (no second toast/timer).
  machine.ingest([signal('014', 'recorder_left')])
  recorder.reset()
  machine.ingest([signal('015', 'recorder_left')])
  assert.deepEqual(recorder.calls, [], 'a second leave during grace must be ignored')
  assert.equal(clock.pendingCount(), 1, 'a second leave must not arm a second grace timer')
}

function scenarioDoneIsTerminal(): void {
  const clock = createFakeClock()
  const recorder = createRecorder()
  const machine = createCallSignalMachine(recorder.actions, CALL_SIGNAL_GRACE_MS, clock.timers)

  machine.ingest([signal('001', 'call_ended')])
  recorder.reset()

  machine.ingest([signal('002', 'recorder_left'), signal('003', 'recorder_rejoined')])
  assert.deepEqual(recorder.calls, [], 'signals after done must be ignored')
  machine.onToastAction('upload-now')
  machine.onToastAction('resume-recording')
  machine.onManualResume()
  assert.deepEqual(recorder.calls, [], 'stale toast clicks after done must be no-ops')
  assert.equal(clock.pendingCount(), 0, 'a done machine holds no timers')

  // dispose() cancels the grace timer and fires nothing.
  const clock2 = createFakeClock()
  const recorder2 = createRecorder()
  const machine2 = createCallSignalMachine(recorder2.actions, CALL_SIGNAL_GRACE_MS, clock2.timers)
  machine2.ingest([signal('001', 'recorder_left')])
  recorder2.reset()
  machine2.dispose()
  assert.deepEqual(recorder2.calls, [], 'dispose must fire no actions')
  assert.equal(machine2.getState(), 'done', 'dispose ends the machine')
  assert.equal(clock2.pendingCount(), 0, 'dispose must cancel the grace timer')
  clock2.tick(CALL_SIGNAL_GRACE_MS * 2)
  assert.deepEqual(recorder2.calls, [], 'a disposed machine must never auto-stop')
}

function scenarioToastActions(): void {
  // Upload now during grace behaves exactly like grace expiry.
  const clockA = createFakeClock()
  const recorderA = createRecorder()
  const machineA = createCallSignalMachine(recorderA.actions, CALL_SIGNAL_GRACE_MS, clockA.timers)
  machineA.ingest([signal('001', 'recorder_left')])
  recorderA.reset()
  machineA.onToastAction('upload-now')
  assert.deepEqual(
    recorderA.calls,
    ['closePausedToast', 'stop'],
    'Upload now must stop the recording immediately'
  )
  assert.equal(machineA.getState(), 'done', 'Upload now ends the machine')
  assert.equal(clockA.pendingCount(), 0, 'Upload now cancels the grace timer')

  // Keep recording during grace resumes and returns to watching.
  const clockB = createFakeClock()
  const recorderB = createRecorder()
  const machineB = createCallSignalMachine(recorderB.actions, CALL_SIGNAL_GRACE_MS, clockB.timers)
  machineB.ingest([signal('001', 'recorder_left')])
  recorderB.reset()
  machineB.onToastAction('resume-recording')
  assert.deepEqual(
    recorderB.calls,
    ['closePausedToast', 'resume'],
    'Keep recording must resume and close the toast'
  )
  assert.equal(machineB.getState(), 'watching', 'Keep recording returns to watching')
  assert.equal(clockB.pendingCount(), 0, 'Keep recording cancels the grace timer')

  // Keep recording after a manual pause still calls resume() — explicit user
  // choice; the renderer guards the no-op case (session.pausedAt === null).
  const clockC = createFakeClock()
  const recorderC = createRecorder()
  const machineC = createCallSignalMachine(recorderC.actions, CALL_SIGNAL_GRACE_MS, clockC.timers)
  recorderC.setPaused(true)
  machineC.ingest([signal('001', 'recorder_left')])
  recorderC.reset()
  machineC.onToastAction('resume-recording')
  assert.deepEqual(
    recorderC.calls,
    ['closePausedToast', 'resume'],
    'Keep recording is an explicit user choice and always resumes'
  )

  // Stale clicks outside grace are inert.
  const clockD = createFakeClock()
  const recorderD = createRecorder()
  const machineD = createCallSignalMachine(recorderD.actions, CALL_SIGNAL_GRACE_MS, clockD.timers)
  machineD.onToastAction('upload-now')
  machineD.onToastAction('resume-recording')
  assert.deepEqual(recorderD.calls, [], 'toast clicks while watching must be no-ops')
  assert.equal(machineD.getState(), 'watching', 'stale toast clicks do not change state')
}

function scenarioNullEventUtc(): void {
  const clock = createFakeClock()
  const recorder = createRecorder()
  const machine = createCallSignalMachine(recorder.actions, CALL_SIGNAL_GRACE_MS, clock.timers)

  // Graph's eventDateTime is optional, so event_utc is nullable on the wire.
  machine.ingest([signal('001', 'recorder_left', null)])
  assert.deepEqual(
    recorder.calls,
    ['pause', 'showPausedToast'],
    'a null event_utc must behave identically (grace is anchored on receipt time)'
  )
  clock.tick(CALL_SIGNAL_GRACE_MS)
  assert.deepEqual(
    recorder.calls,
    ['pause', 'showPausedToast', 'closePausedToast', 'stop'],
    'a null event_utc must not disturb grace timing'
  )
}

type Machine = ReturnType<typeof createCallSignalMachine>

function scenarioThrowingActions(): void {
  // (a) pause() throws: the grace must still be armed and the toast requested,
  // and the rest of the cycle must keep working.
  const clock = createFakeClock()
  const recorder = createRecorder()
  const throwingPause: CallSignalActions = {
    ...recorder.actions,
    pause(): void {
      recorder.actions.pause()
      throw new Error('window destroyed')
    }
  }
  const machine = createCallSignalMachine(throwingPause, CALL_SIGNAL_GRACE_MS, clock.timers)
  machine.ingest([signal('001', 'recorder_left')])
  assert.deepEqual(
    recorder.calls,
    ['pause', 'showPausedToast'],
    'a throwing pause must not swallow the rest of the transition'
  )
  assert.equal(machine.getState(), 'grace', 'a throwing action must not corrupt the state')
  assert.equal(clock.pendingCount(), 1, 'the grace timer must be armed despite the throw')
  assert.equal(machine.getActionErrorCount(), 1, 'the throw must be counted')

  recorder.reset()
  machine.ingest([signal('002', 'recorder_rejoined')])
  assert.deepEqual(
    recorder.calls,
    ['closePausedToast', 'resume'],
    'the cycle must keep working after a throwing action'
  )

  // A throwing toast must not cost us the auto-stop.
  const clockB = createFakeClock()
  const recorderB = createRecorder()
  const throwingToast: CallSignalActions = {
    ...recorderB.actions,
    showPausedToast(): void {
      recorderB.actions.showPausedToast()
      throw new Error('notification failed')
    },
    closePausedToast(): void {
      recorderB.actions.closePausedToast()
      throw new Error('notification failed')
    }
  }
  const machineB = createCallSignalMachine(throwingToast, CALL_SIGNAL_GRACE_MS, clockB.timers)
  machineB.ingest([signal('001', 'recorder_left')])
  recorderB.reset()
  clockB.tick(CALL_SIGNAL_GRACE_MS)
  assert.deepEqual(
    recorderB.calls,
    ['closePausedToast', 'stop'],
    'a throwing toast must never cost the auto-stop'
  )
  assert.equal(machineB.getState(), 'done', 'the terminal state holds through throwing actions')
  assert.equal(machineB.getActionErrorCount(), 2, 'both toast throws are counted')

  // A throwing stop() still leaves the machine terminal (no repeat stops).
  const clockC = createFakeClock()
  const recorderC = createRecorder()
  const throwingStop: CallSignalActions = {
    ...recorderC.actions,
    stop(): void {
      recorderC.actions.stop()
      throw new Error('no window')
    }
  }
  const machineC = createCallSignalMachine(throwingStop, CALL_SIGNAL_GRACE_MS, clockC.timers)
  machineC.ingest([signal('001', 'call_ended')])
  assert.equal(machineC.getState(), 'done', 'a throwing stop must still leave the machine done')
  recorderC.reset()
  machineC.ingest([signal('002', 'call_ended')])
  assert.deepEqual(recorderC.calls, [], 'a throwing stop must not re-open the machine')

  // A throwing isPaused() must not claim pause ownership (D6): pausing is the
  // safe best effort, but auto-resuming a pause we cannot vouch for is not.
  const clockD = createFakeClock()
  const recorderD = createRecorder()
  const throwingQuery: CallSignalActions = {
    ...recorderD.actions,
    isPaused(): boolean {
      throw new Error('ipc gone')
    }
  }
  const machineD = createCallSignalMachine(throwingQuery, CALL_SIGNAL_GRACE_MS, clockD.timers)
  machineD.ingest([signal('001', 'recorder_left')])
  assert.deepEqual(
    recorderD.calls,
    ['pause', 'showPausedToast'],
    'an untrustworthy pause query still pauses (best effort)'
  )
  recorderD.reset()
  machineD.ingest([signal('002', 'recorder_rejoined')])
  assert.deepEqual(
    recorderD.calls,
    ['closePausedToast'],
    'an untrustworthy pause query must not claim ownership, so no auto-resume'
  )
}

function scenarioReentrantActions(): void {
  // (b) closePausedToast() re-enters with call_ended, then throws: exactly one
  // stop. State-first ordering is what makes the re-entrant call see `done`.
  const clock = createFakeClock()
  const recorder = createRecorder()
  let machine: Machine | null = null
  const reentrant: CallSignalActions = {
    ...recorder.actions,
    closePausedToast(): void {
      recorder.actions.closePausedToast()
      machine?.ingest([signal('009', 'call_ended')])
      throw new Error('toast handle gone')
    }
  }
  machine = createCallSignalMachine(reentrant, CALL_SIGNAL_GRACE_MS, clock.timers)
  machine.ingest([signal('001', 'recorder_left')])
  recorder.reset()
  machine.ingest([signal('002', 'call_ended')])
  assert.deepEqual(
    recorder.calls,
    ['closePausedToast', 'stop'],
    'a re-entrant call_ended inside closePausedToast must produce exactly one stop'
  )
  assert.equal(
    recorder.calls.filter((call) => call === 'stop').length,
    1,
    'stop must fire exactly once under re-entrancy'
  )
  assert.equal(machine.getState(), 'done', 're-entrancy must not disturb the terminal state')
  assert.equal(clock.pendingCount(), 0, 're-entrancy must not leave a timer behind')

  // A re-entrant leave during a rejoin's toast close must win: the outer
  // transition's resume is abandoned rather than fighting the newer state.
  const clock2 = createFakeClock()
  const recorder2 = createRecorder()
  let machine2: Machine | null = null
  let reentered = false
  const reentrantLeave: CallSignalActions = {
    ...recorder2.actions,
    closePausedToast(): void {
      recorder2.actions.closePausedToast()
      if (reentered) return
      reentered = true
      machine2?.ingest([signal('050', 'recorder_left')])
    }
  }
  machine2 = createCallSignalMachine(reentrantLeave, CALL_SIGNAL_GRACE_MS, clock2.timers)
  machine2.ingest([signal('001', 'recorder_left')])
  recorder2.reset()
  machine2.ingest([signal('002', 'recorder_rejoined')])
  assert.deepEqual(
    recorder2.calls,
    ['closePausedToast', 'showPausedToast'],
    'the stale resume must stand down once a re-entrant leave has taken over'
  )
  assert.equal(machine2.getState(), 'grace', 'the re-entrant transition owns the final state')
  assert.equal(clock2.pendingCount(), 1, 'the re-entrant leave armed its own grace timer')

  // A re-entrant call_ended from inside pause() must not be overwritten by the
  // rest of the leave transition: a machine that reached `done` may never be
  // resurrected into `grace` with a live timer (that would stop twice).
  const clock3 = createFakeClock()
  const recorder3 = createRecorder()
  let machine3: Machine | null = null
  const reentrantEnd: CallSignalActions = {
    ...recorder3.actions,
    pause(): void {
      recorder3.actions.pause()
      machine3?.ingest([signal('077', 'call_ended')])
    }
  }
  machine3 = createCallSignalMachine(reentrantEnd, CALL_SIGNAL_GRACE_MS, clock3.timers)
  machine3.ingest([signal('001', 'recorder_left')])
  assert.equal(machine3.getState(), 'done', 'a re-entrant call_ended must survive the transition')
  assert.equal(clock3.pendingCount(), 0, 'a finished machine must hold no grace timer')
  assert.deepEqual(
    recorder3.calls,
    ['pause', 'closePausedToast', 'stop'],
    'the superseded toast must stand down and the stop must fire once'
  )
  recorder3.reset()
  clock3.tick(CALL_SIGNAL_GRACE_MS * 2)
  assert.deepEqual(recorder3.calls, [], 'no resurrected grace timer may fire a second stop')

  // isPaused() is the one action that runs before the commit (it decides D6
  // ownership), so it is the one place a re-entrant signal can land while the
  // leave transition is still uncommitted. The outer transition must stand
  // down rather than resurrect the finished machine.
  const clock4 = createFakeClock()
  const recorder4 = createRecorder()
  let machine4: Machine | null = null
  const reentrantQuery: CallSignalActions = {
    ...recorder4.actions,
    isPaused(): boolean {
      machine4?.ingest([signal('077', 'call_ended')])
      return false
    }
  }
  machine4 = createCallSignalMachine(reentrantQuery, CALL_SIGNAL_GRACE_MS, clock4.timers)
  machine4.ingest([signal('001', 'recorder_left')])
  assert.equal(
    machine4.getState(),
    'done',
    'a call_ended re-entered from inside isPaused() must own the outcome'
  )
  assert.deepEqual(
    recorder4.calls,
    ['closePausedToast', 'stop'],
    'the superseded leave must not pause or raise a toast after the machine finished'
  )
  assert.equal(
    recorder4.calls.filter((call) => call === 'stop').length,
    1,
    'exactly one stop under re-entrancy from the pause query'
  )
  assert.equal(clock4.pendingCount(), 0, 'no orphan grace timer may survive the stand-down')
  recorder4.reset()
  clock4.tick(CALL_SIGNAL_GRACE_MS * 2)
  assert.deepEqual(recorder4.calls, [], 'no timer may fire a second stop afterwards')

  // dispose() re-entered mid-finish stands the remaining effects down: the
  // stop may never be issued. Task 13 must not read "disarmed" as "stopped".
  const clock5 = createFakeClock()
  const recorder5 = createRecorder()
  let machine5: Machine | null = null
  const reentrantDispose: CallSignalActions = {
    ...recorder5.actions,
    closePausedToast(): void {
      recorder5.actions.closePausedToast()
      machine5?.dispose()
    }
  }
  machine5 = createCallSignalMachine(reentrantDispose, CALL_SIGNAL_GRACE_MS, clock5.timers)
  machine5.ingest([signal('001', 'recorder_left')])
  recorder5.reset()
  machine5.ingest([signal('002', 'call_ended')])
  assert.deepEqual(
    recorder5.calls,
    ['closePausedToast'],
    'a dispose() during the terminal transition stands the pending stop down'
  )
  assert.equal(machine5.getState(), 'done', 'the machine is still terminal after dispose')
  assert.equal(clock5.pendingCount(), 0, 'dispose leaves no timer behind')

  // A re-entrant ingest carrying the SAME seq as the in-flight signal must be
  // deduped, not replayed — this pins `seen.add` running BEFORE the transition.
  // The re-entry point is `isPaused()` deliberately: it is the earliest hook,
  // so an ordering that marked the seq as seen only after the transition would
  // recurse into itself here instead of deduping.
  const clock6 = createFakeClock()
  const recorder6 = createRecorder()
  let machine6: Machine | null = null
  let reentries = 0
  const reentrantSameSeq: CallSignalActions = {
    ...recorder6.actions,
    isPaused(): boolean {
      reentries += 1
      // Depth-capped so a regression fails an assertion instead of hanging.
      if (reentries < 5) machine6?.ingest([signal('001', 'recorder_left')])
      return false
    }
  }
  machine6 = createCallSignalMachine(reentrantSameSeq, CALL_SIGNAL_GRACE_MS, clock6.timers)
  machine6.ingest([signal('001', 'recorder_left')])
  assert.deepEqual(
    recorder6.calls,
    ['pause', 'showPausedToast'],
    'a re-entrant replay of the in-flight seq must pause exactly once'
  )
  assert.equal(clock6.pendingCount(), 1, 'a re-entrant replay must not arm a second grace timer')
  assert.equal(machine6.getState(), 'grace', 'the replay leaves the transition intact')
  assert.equal(machine6.getActionErrorCount(), 0, 'no action threw in the replay case')
  assert.equal(reentries, 1, 'the replayed seq must be deduped before it can re-query the state')
}

/**
 * The sibling of the `call_ended`-from-`isPaused()` case: a SECOND
 * `recorder_left` (different seq) re-entered from inside the pause query,
 * while the first leave is still uncommitted. Dedupe cannot help — the seqs
 * differ — so only the post-query state check stops the outer transition from
 * arming a second grace timer over the live one and pausing twice. A guard
 * weakened to `state === 'done'` passes every other scenario and fails here.
 */
function scenarioReentrantLeaveFromIsPaused(): void {
  const clock = createFakeClock()
  const recorder = createRecorder()
  let machine: Machine | null = null
  let reentries = 0
  const reentrantLeave: CallSignalActions = {
    ...recorder.actions,
    isPaused(): boolean {
      reentries += 1
      // Depth-capped so a regression fails an assertion instead of hanging.
      if (reentries < 5) machine?.ingest([signal('002', 'recorder_left')])
      return false
    }
  }
  machine = createCallSignalMachine(reentrantLeave, CALL_SIGNAL_GRACE_MS, clock.timers)
  machine.ingest([signal('001', 'recorder_left')])

  assert.equal(
    clock.pendingCount(),
    1,
    'a leave re-entered from isPaused() must leave exactly one grace timer armed'
  )
  assert.deepEqual(
    recorder.calls,
    ['pause', 'showPausedToast'],
    'the superseded outer leave must not pause or toast a second time'
  )
  assert.equal(machine.getState(), 'grace', 'the inner transition owns the state')
  assert.equal(machine.getActionErrorCount(), 0, 'no action threw in this path')
  assert.equal(reentries, 2, 'the inner leave queries the pause state once more, then settles')

  // The single armed timer must still produce exactly one stop.
  recorder.reset()
  clock.tick(CALL_SIGNAL_GRACE_MS)
  assert.deepEqual(
    recorder.calls,
    ['closePausedToast', 'stop'],
    'the one surviving grace timer stops exactly once'
  )
  assert.equal(clock.pendingCount(), 0, 'no orphaned second timer may remain')
}

function scenarioParseCallSignals(): void {
  const parsed = parseCallSignals({
    signals: [
      { seq: '001', type: 'recorder_left', event_utc: null, received_utc: '2026-08-13T01:00:02Z' },
      {
        seq: '002',
        type: 'recorder_rejoined',
        event_utc: '2026-08-13T01:00:30Z',
        received_utc: '2026-08-13T01:00:32Z'
      },
      { seq: '003', type: 'call_ended', received_utc: '2026-08-13T01:05:00Z' }
    ]
  })
  assert.deepEqual(
    parsed,
    [
      { seq: '001', type: 'recorder_left', event_utc: null, received_utc: '2026-08-13T01:00:02Z' },
      {
        seq: '002',
        type: 'recorder_rejoined',
        event_utc: '2026-08-13T01:00:30Z',
        received_utc: '2026-08-13T01:00:32Z'
      },
      { seq: '003', type: 'call_ended', event_utc: null, received_utc: '2026-08-13T01:05:00Z' }
    ],
    'a well-formed payload must translate verbatim, with a missing event_utc normalised to null'
  )

  assert.deepEqual(
    parseCallSignals({
      signals: [
        { seq: '001', type: 'call_started', received_utc: 'x' },
        { seq: '', type: 'call_ended', received_utc: 'x' },
        { type: 'call_ended', received_utc: 'x' },
        { seq: '004', type: 'call_ended' },
        'nonsense',
        null
      ]
    }),
    [],
    'unknown types and malformed entries must be dropped, not crash the tick'
  )
  assert.deepEqual(parseCallSignals(null), [], 'a null payload yields no signals')
  assert.deepEqual(parseCallSignals({}), [], 'a payload without signals yields no signals')
  assert.deepEqual(parseCallSignals({ signals: 'x' }), [], 'a non-array signals field yields none')
}

function scenarioArmGate(): void {
  const recording = {
    eventId: 'evt-1',
    idempotencyKey: 'key-1',
    startTimeUtc: '2026-08-13T01:00:00Z',
    endTimeUtc: '2026-08-13T02:00:00Z',
    source: 'auto' as const,
    metadata: { joinWebUrl: JOIN_URL }
  }
  const env = {
    MN_STORAGE_API_SCOPE: 'api://storage/access_as_user'
  } as NodeJS.ProcessEnv

  assert.deepEqual(
    shouldArmCallSignals(recording, env),
    { arm: true, joinWebUrl: JOIN_URL },
    'an auto recording with a join URL and storage enabled must arm'
  )
  assert.deepEqual(
    shouldArmCallSignals(recording, { ...env, MN_CALL_SIGNALS_ENABLED: 'false' }),
    { arm: false, reason: 'feature_disabled' },
    'the desktop kill switch must keep the poller dormant (D8)'
  )
  assert.deepEqual(
    shouldArmCallSignals(recording, { ...env, MN_CALL_SIGNALS_ENABLED: 'true' }),
    { arm: true, joinWebUrl: JOIN_URL },
    'an explicit true must arm'
  )
  assert.deepEqual(
    shouldArmCallSignals({ ...recording, source: 'manual' }, env),
    { arm: false, reason: 'not_auto_recording' },
    'manual recordings are out of scope'
  )
  assert.deepEqual(
    shouldArmCallSignals({ ...recording, metadata: {} }, env),
    { arm: false, reason: 'no_join_url' },
    'no join URL means no Graph subscription is possible'
  )
  assert.deepEqual(
    shouldArmCallSignals({ ...recording, metadata: undefined }, env),
    { arm: false, reason: 'no_join_url' },
    'absent metadata must not throw'
  )
  assert.deepEqual(
    shouldArmCallSignals(recording, { ...env, MN_STORAGE_API_ENABLED: 'false' }),
    { arm: false, reason: 'storage_api_disabled' },
    'the storage kill switch must also keep the poller dormant'
  )
  assert.deepEqual(
    shouldArmCallSignals(recording, {} as NodeJS.ProcessEnv),
    { arm: false, reason: 'no_storage_scope' },
    'without a storage scope there is no token to mint (stub mode)'
  )

  assert.equal(readJoinWebUrl({ joinWebUrl: JOIN_URL }), JOIN_URL, 'metadata join URL is read')
  assert.equal(readJoinWebUrl({ joinWebUrl: '  ' }), null, 'a blank join URL counts as absent')
  assert.equal(readJoinWebUrl(null), null, 'null metadata is tolerated')
  assert.equal(readJoinWebUrl('nonsense'), null, 'non-object metadata is tolerated')
}

// ---------------------------------------------------------------------------
// Poller scenarios (core is I/O-injected; no Electron, no network)
// ---------------------------------------------------------------------------

function pollerDeps(
  clock: FakeClock,
  http: FakeHttp,
  log: ReturnType<typeof createFakeLog>,
  recorder: Recorder
): Parameters<typeof createCallSignalPoller>[0] {
  return {
    actions: recorder.actions,
    joinWebUrl: JOIN_URL,
    scheduledEndUtc: '2026-08-13T02:00:00Z',
    apiBase: 'http://127.0.0.1:8787',
    http: http.send,
    identityHeaders: async () => ({
      'X-MN-User-Email': USER_EMAIL,
      'X-MN-User-Oid': USER_OID,
      'X-MN-Storage-Token': STORAGE_TOKEN
    }),
    timers: clock.timers,
    log: log.log
  }
}

async function scenarioPollerHappyPath(): Promise<void> {
  const clock = createFakeClock()
  const recorder = createRecorder()
  const logs = createFakeLog()
  const http = createFakeHttp((call) => {
    if (call.method === 'POST') {
      return jsonResponse(200, { watch_id: 'w1', subscription_expires_utc: '2026-08-13T14:00:00Z' })
    }
    if (call.method === 'GET') return jsonResponse(200, { signals: [] })
    return jsonResponse(204)
  })
  const poller = createCallSignalPoller(pollerDeps(clock, http, logs, recorder))

  await poller.start()
  assert.equal(http.calls.length, 1, 'start must register exactly one watch')
  assert.equal(http.calls[0].method, 'POST', 'registration is a POST')
  assert.equal(
    http.calls[0].url,
    'http://127.0.0.1:8787/api/v1/call-watch',
    'registration goes to the local backend relay route'
  )
  assert.deepEqual(
    JSON.parse(http.calls[0].body ?? '{}'),
    { join_web_url: JOIN_URL, scheduled_end_utc: '2026-08-13T02:00:00Z' },
    'the registration body matches the relay contract'
  )
  assert.equal(
    http.calls[0].headers['X-MN-Storage-Token'],
    STORAGE_TOKEN,
    'the storage identity headers must ride along'
  )
  assert.equal(
    http.calls[0].headers['content-type'],
    'application/json',
    'the registration body needs a content-type'
  )
  assert.equal(poller.getStatus(), 'polling', 'a successful registration starts polling')
  poller.stop()
  await flush()

  // First poll tick delivers a leave signal; later ticks replay the whole
  // signal list (the relay has no cursor) and add the rejoin.
  const leave = signal('001', 'recorder_left')
  const rejoin = signal('002', 'recorder_rejoined')
  let getCount = 0
  const httpSignals = createFakeHttp((call) => {
    if (call.method !== 'GET') return jsonResponse(200, { watch_id: 'w1' })
    getCount += 1
    return jsonResponse(200, { signals: getCount === 1 ? [leave] : [leave, rejoin] })
  })
  const poller2 = createCallSignalPoller(pollerDeps(clock, httpSignals, logs, recorder))
  await poller2.start()
  recorder.reset()
  clock.tick(CALL_SIGNAL_POLL_INTERVAL_MS)
  await flush()
  const getCalls = httpSignals.calls.filter((call) => call.method === 'GET')
  assert.equal(getCalls.length, 1, 'one poll tick issues exactly one GET')
  assert.equal(
    getCalls[0].url,
    'http://127.0.0.1:8787/api/v1/call-watch/signals',
    'polling hits the signals relay route'
  )
  assert.equal(
    getCalls[0].headers['X-MN-Storage-Token'],
    STORAGE_TOKEN,
    'each poll carries fresh identity headers'
  )
  assert.deepEqual(
    recorder.calls,
    ['pause', 'showPausedToast'],
    'a polled recorder_left must drive the machine'
  )

  // Next tick: the replayed leave is deduped, the new rejoin is acted on.
  recorder.reset()
  clock.tick(CALL_SIGNAL_POLL_INTERVAL_MS)
  await flush()
  assert.equal(
    httpSignals.calls.filter((call) => call.method === 'GET').length,
    2,
    'polling continues on a fixed interval'
  )
  assert.deepEqual(
    recorder.calls,
    ['closePausedToast', 'resume'],
    'a re-delivered leave is deduped while the new rejoin still lands'
  )
  assert.equal(poller2.machine.getState(), 'watching', 'the polled rejoin returns to watching')

  // Tick three replays the identical, already-consumed pair: nothing may fire
  // even though the machine is back in `watching` and would otherwise re-pause.
  recorder.reset()
  clock.tick(CALL_SIGNAL_POLL_INTERVAL_MS)
  await flush()
  assert.deepEqual(recorder.calls, [], 're-delivered signals must be deduped by seq')
  assert.equal(clock.pendingCount(), 1, 'exactly one poll timer stays armed')

  // Stopping tears everything down and best-effort deletes the watch.
  poller2.stop()
  await flush()
  assert.equal(poller2.getStatus(), 'stopped', 'stop marks the poller stopped')
  assert.equal(poller2.machine.getState(), 'done', 'stop disposes the machine')
  const deleteCalls = httpSignals.calls.filter((call) => call.method === 'DELETE')
  assert.equal(deleteCalls.length, 1, 'stop deletes the watch best-effort')
  assert.equal(
    deleteCalls[0].url,
    'http://127.0.0.1:8787/api/v1/call-watch',
    'the delete hits the relay route'
  )
  assert.equal(
    deleteCalls[0].headers['X-MN-Storage-Token'],
    STORAGE_TOKEN,
    'the delete carries identity headers too'
  )

  poller2.stop()
  await flush()
  assert.equal(
    httpSignals.calls.filter((call) => call.method === 'DELETE').length,
    1,
    'a second stop() must not issue a second delete'
  )

  const callsAfterStop = httpSignals.calls.length
  clock.tick(CALL_SIGNAL_POLL_INTERVAL_MS * 5)
  await flush()
  assert.equal(httpSignals.calls.length, callsAfterStop, 'no polling may survive stop()')
  assert.equal(clock.pendingCount(), 0, 'stop leaves no timers armed')
  assertNoPii(logs.entries, 'happy path')
}

async function scenarioPollerRegistrationRetry(): Promise<void> {
  // Failure then success: exactly one retry at +30s, then normal polling.
  const clock = createFakeClock()
  const recorder = createRecorder()
  const logs = createFakeLog()
  let attempt = 0
  const http = createFakeHttp((call) => {
    if (call.method !== 'POST') return jsonResponse(200, { signals: [] })
    attempt += 1
    return attempt === 1 ? jsonResponse(503) : jsonResponse(200, { watch_id: 'w1' })
  })
  const poller = createCallSignalPoller(pollerDeps(clock, http, logs, recorder))

  await poller.start()
  assert.equal(poller.getStatus(), 'retry_pending', 'a failed registration waits to retry')
  assert.equal(clock.pendingCount(), 1, 'exactly one retry timer is armed')
  assert.equal(http.calls.length, 1, 'no polling before a watch exists')

  clock.tick(CALL_SIGNAL_REGISTRATION_RETRY_MS - 1)
  await flush()
  assert.equal(http.calls.length, 1, 'the retry must wait the full 30s')

  clock.tick(1)
  await flush()
  assert.equal(http.calls.length, 2, 'the retry fires once at +30s')
  assert.equal(poller.getStatus(), 'polling', 'a successful retry starts polling')
  clock.tick(CALL_SIGNAL_POLL_INTERVAL_MS)
  await flush()
  assert.equal(
    http.calls.filter((call) => call.method === 'GET').length,
    1,
    'polling proceeds after a retried registration'
  )
  poller.stop()

  // Failure twice: dormant for this recording, no third attempt ever.
  const clock2 = createFakeClock()
  const logs2 = createFakeLog()
  const http2 = createFakeHttp((call) => (call.method === 'POST' ? jsonResponse(502) : jsonResponse(200, { signals: [] })))
  const poller2 = createCallSignalPoller(pollerDeps(clock2, http2, logs2, createRecorder()))
  await poller2.start()
  clock2.tick(CALL_SIGNAL_REGISTRATION_RETRY_MS)
  await flush()
  assert.equal(http2.calls.length, 2, 'registration is attempted at most twice (D7)')
  assert.equal(poller2.getStatus(), 'dormant', 'two failures leave the feature dormant')
  assert.equal(clock2.pendingCount(), 0, 'a dormant poller holds no timers')
  clock2.tick(CALL_SIGNAL_REGISTRATION_RETRY_MS * 10)
  await flush()
  assert.equal(http2.calls.length, 2, 'a dormant poller never retries again')

  assert.deepEqual(
    logs2.entries.map((entry) => entry.context?.status),
    [502, 502],
    'each registration failure logs its distinct status code (503/502/422 all dormant, D7)'
  )

  // A network throw counts as a failure the same way, and never escapes.
  const clock3 = createFakeClock()
  const logs3 = createFakeLog()
  const http3 = createFakeHttp(() => new Error('ECONNREFUSED 127.0.0.1:8787'))
  const poller3 = createCallSignalPoller(pollerDeps(clock3, http3, logs3, createRecorder()))
  await poller3.start()
  assert.equal(poller3.getStatus(), 'retry_pending', 'a network failure also retries once')
  clock3.tick(CALL_SIGNAL_REGISTRATION_RETRY_MS)
  await flush()
  assert.equal(poller3.getStatus(), 'dormant', 'a second network failure goes dormant')

  // stop() on a poller that never registered is safe and issues no DELETE.
  const clock4 = createFakeClock()
  const http4 = createFakeHttp(() => jsonResponse(200))
  const poller4 = createCallSignalPoller(pollerDeps(clock4, http4, createFakeLog(), createRecorder()))
  poller4.stop()
  assert.equal(http4.calls.length, 0, 'stopping a never-started poller must issue no requests')
  assert.equal(poller4.getStatus(), 'stopped', 'stop is safe before start')

  assertNoPii(logs.entries, 'registration retry')
  assertNoPii(logs2.entries, 'registration dormant')
  assertNoPii(logs3.entries, 'registration transport failure')
}

async function scenarioPollerFailuresAreSkips(): Promise<void> {
  const clock = createFakeClock()
  const recorder = createRecorder()
  const logs = createFakeLog()
  const leave = signal('001', 'recorder_left')
  let get = 0
  const http = createFakeHttp((call) => {
    if (call.method !== 'GET') return jsonResponse(200, { watch_id: 'w1' })
    get += 1
    if (get === 1) return jsonResponse(503)
    if (get === 2) return new Error('socket hang up')
    if (get === 3) return jsonResponse(200, 'not-json-shaped')
    return jsonResponse(200, { signals: [leave] })
  })
  const poller = createCallSignalPoller(pollerDeps(clock, http, logs, recorder))
  await poller.start()

  for (let tick = 0; tick < 3; tick++) {
    clock.tick(CALL_SIGNAL_POLL_INTERVAL_MS)
    await flush()
    assert.deepEqual(recorder.calls, [], 'a failed poll tick must change nothing')
    assert.equal(poller.getStatus(), 'polling', 'poll failures never stop the poller (D7)')
  }

  clock.tick(CALL_SIGNAL_POLL_INTERVAL_MS)
  await flush()
  assert.deepEqual(
    recorder.calls,
    ['pause', 'showPausedToast'],
    'the poller recovers on the next healthy tick'
  )
  assert.equal(
    logs.entries.filter((entry) => entry.level === 'warn').length,
    3,
    'each failed tick logs exactly once'
  )
  assert.deepEqual(
    logs.entries.filter((entry) => entry.message.includes('poll')).map((entry) => entry.context?.status),
    [503, 0, 200],
    'poll failures log their status distinctly (0 = network/transport failure)'
  )
  assertNoPii(logs.entries, 'poll failures')
  poller.stop()
  await flush()
  assertNoPii(logs.entries, 'poll failures after stop')
}

async function scenarioPollerSurvivesThrowingActions(): Promise<void> {
  // (c) An action that throws inside a poll tick must not kill the poll loop.
  const clock = createFakeClock()
  const recorder = createRecorder()
  const logs = createFakeLog()
  const leave = signal('001', 'recorder_left')
  const http = createFakeHttp((call) =>
    call.method === 'GET' ? jsonResponse(200, { signals: [leave] }) : jsonResponse(200, { watch_id: 'w1' })
  )
  const throwing: CallSignalActions = {
    ...recorder.actions,
    pause(): void {
      recorder.actions.pause()
      throw new Error('renderer gone')
    },
    showPausedToast(): void {
      recorder.actions.showPausedToast()
      throw new Error('notification failed')
    }
  }
  const poller = createCallSignalPoller({
    ...pollerDeps(clock, http, logs, recorder),
    actions: throwing
  })
  await poller.start()

  clock.tick(CALL_SIGNAL_POLL_INTERVAL_MS)
  await flush()
  assert.deepEqual(
    recorder.calls,
    ['pause', 'showPausedToast'],
    'both actions are attempted even though the first throws'
  )
  assert.equal(poller.machine.getActionErrorCount(), 2, 'both throws are counted')
  assert.equal(poller.getStatus(), 'polling', 'a throwing action must not stop the poller')

  const getsAfterFirstTick = http.calls.filter((call) => call.method === 'GET').length
  clock.tick(CALL_SIGNAL_POLL_INTERVAL_MS)
  await flush()
  assert.equal(
    http.calls.filter((call) => call.method === 'GET').length,
    getsAfterFirstTick + 1,
    'the next poll tick must still be scheduled after a throwing action'
  )

  // And the grace armed on that tick still expires into a stop.
  recorder.reset()
  clock.tick(CALL_SIGNAL_GRACE_MS)
  await flush()
  assert.ok(
    recorder.calls.includes('stop'),
    'the grace armed during a throwing tick must still auto-stop'
  )
  assertNoPii(logs.entries, 'throwing actions')
  poller.stop()
  await flush()
}

async function scenarioNoPiiInLogs(): Promise<void> {
  const clock = createFakeClock()
  const recorder = createRecorder()
  const logs = createFakeLog()
  const http = createFakeHttp((call) => (call.method === 'POST' ? jsonResponse(422, { detail: JOIN_URL }) : jsonResponse(500, { detail: USER_EMAIL })))
  const poller = createCallSignalPoller(pollerDeps(clock, http, logs, recorder))
  await poller.start()
  clock.tick(CALL_SIGNAL_REGISTRATION_RETRY_MS)
  await flush()
  poller.stop()
  await flush()

  assert.ok(logs.entries.length > 0, 'the failure path must actually log something')
  assertNoPii(logs.entries, 'error bodies')
}

/**
 * The harness must bundle the pure core ONLY. `call-signals.ts` reaches
 * auth-msal / the log module, both of which require the Electron runtime at
 * module scope — bundling them here works only by accident of their having no
 * top-level side effects, which is exactly the kind of accident that breaks
 * cryptically later. Needles are assembled at runtime so this check cannot
 * match its own source text.
 */
function assertBundleIsRuntimeFree(): void {
  const bundlePath = process.argv[1]
  assert.ok(
    bundlePath && existsSync(bundlePath) && bundlePath.endsWith('.cjs'),
    'run this through `npm run verify:call-signals` so the built bundle can be inspected'
  )
  const bundle = readFileSync(bundlePath, 'utf8')
  const runtimeNeedles = [
    `require(${JSON.stringify('electron')})`,
    ['electron', 'log'].join('-'),
    ['@azure', 'msal-node'].join('/'),
    ['getStorageApi', 'AccessToken'].join('')
  ]
  for (const needle of runtimeNeedles) {
    assert.ok(
      !bundle.includes(needle),
      `the harness bundle must not contain "${needle}" — import the pure core, not the runtime layer`
    )
  }
}

async function main(): Promise<void> {
  // 1-9: the pure machine (spec D5/D6/D9).
  scenarioLeaveThenGraceExpiry()
  scenarioRejoinDuringGrace()
  scenarioManualPauseThenLeave()
  scenarioManualResumeDuringGrace()
  scenarioCallEnded()
  scenarioDedupeAndOrdering()
  scenarioDoneIsTerminal()
  scenarioToastActions()
  scenarioNullEventUtc()

  // Robustness: injected actions are untrusted (may throw, may re-enter).
  scenarioThrowingActions()
  scenarioReentrantActions()
  scenarioReentrantLeaveFromIsPaused()

  // Wire translation + arm gating (pure).
  scenarioParseCallSignals()
  scenarioArmGate()

  // Poller core with injected HTTP/timers/identity/log (spec D7).
  await scenarioPollerHappyPath()
  await scenarioPollerRegistrationRetry()
  await scenarioPollerFailuresAreSkips()
  await scenarioPollerSurvivesThrowingActions()
  await scenarioNoPiiInLogs()

  assertBundleIsRuntimeFree()

  // Pin the constants the live-smoke expectations are written against.
  assert.equal(CALL_SIGNAL_GRACE_MS, 60_000, 'the grace window must stay pinned at 60s')
  assert.equal(CALL_SIGNAL_POLL_INTERVAL_MS, 10_000, 'the poll interval must stay pinned at 10s')
  assert.equal(
    CALL_SIGNAL_REGISTRATION_RETRY_MS,
    30_000,
    'the single registration retry must stay pinned at +30s'
  )

  console.log('Call-signal machine and poller verification passed')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
