import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deriveCallPresence, type CallPresence } from '../src/main/join-watch-core'
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

  // Post-start call_ended followed by a fresh IN → back in call, not ended.
  const restarted = deriveCallPresence([sig('recorder_rejoined', T(0)), sig('call_ended', T(30)), sig('recorder_rejoined', T(35))], T(0))
  assert.equal(restarted.inCall, true)
  assert.equal(restarted.endedAtOrAfterStart, false)

  // Out-of-order input is sorted by seq before walking.
  const chrono = [sig('recorder_rejoined', T(-30)), sig('recorder_left', T(-10))]
  const shuffled = deriveCallPresence([...chrono].reverse(), T(0))
  assert.equal(shuffled.inCall, false)
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
