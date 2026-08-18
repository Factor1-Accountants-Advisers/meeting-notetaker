import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deriveCallPresence, type CallPresence, decideFalseStart, readAutoStartTrigger } from '../src/main/join-watch-core'
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

console.log('join-watch verification passed')
