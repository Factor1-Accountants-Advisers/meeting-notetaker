import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createInviteePromptEngine,
  inviteeDisplayNames,
  parseInviteePromptRequest,
  type InviteeDecisionMessage,
  type InviteePromptRequest
} from '../src/main/invitee-prompt-core'
import { TOAST_LIFETIME_MS } from '../src/main/toast-xml'

// IN-488: the main-process half of "ask before emailing invitees". The engine
// owns one toast + one timer per meeting. Whatever happens first (a toast
// button, the in-app card, or the timer) resolves that meeting exactly once,
// and the timer's answer is always the safe default: organiser only.

function harness(opts: { toastFails?: boolean; lifetimeMs?: number } = {}) {
  let seq = 0
  let now = 0
  const pending = new Map<number, { fn: () => void; at: number }>()
  const decisions: InviteeDecisionMessage[] = []
  const logs: string[] = []
  const shown: string[] = []
  const closed: string[] = []
  let chimes = 0
  const engine = createInviteePromptEngine({
    showToast: (request) => {
      if (opts.toastFails) return null
      shown.push(request.meetingId)
      return () => closed.push(request.meetingId)
    },
    playChime: () => {
      chimes += 1
    },
    sendDecision: (message) => decisions.push(message),
    timers: {
      setTimeout: (fn, ms) => {
        const id = ++seq
        pending.set(id, { fn, at: now + ms })
        return id
      },
      clearTimeout: (handle) => {
        pending.delete(handle as number)
      }
    },
    log: (_level, message) => logs.push(message),
    lifetimeMs: opts.lifetimeMs
  })
  const advance = (ms: number): void => {
    now += ms
    for (const [id, timer] of [...pending]) {
      if (timer.at <= now) {
        pending.delete(id)
        timer.fn()
      }
    }
  }
  return { engine, decisions, logs, shown, closed, advance, chimes: () => chimes, timers: () => pending.size }
}

// A function declaration, not `const request = (…): T => ({…})`: directly after
// harness()'s one-line object return, TypeScript 5.9 mis-parses that arrow's
// object literal as a parameter pattern (TS1003). esbuild does not, so the
// harness would run but `npm run typecheck` style checks would reject it.
function request(meetingId: string): InviteePromptRequest {
  return {
    meetingId,
    title: 'Innovations sync',
    candidates: [{ name: 'David Ahlhaus', email: 'da@factor1.com.au' }]
  }
}

// ---- bundle purity ---------------------------------------------------------
{
  const bundle = join(process.cwd(), 'out', 'verify-invitee-prompt.cjs')
  if (existsSync(bundle)) {
    const src = readFileSync(bundle, 'utf8')
    assert.ok(!/require\(["']electron["']\)/.test(src), 'invitee-prompt-core must not import electron')
  }
}

// ---- show ------------------------------------------------------------------
{
  const h = harness()
  h.engine.show(request('m1'))
  assert.deepEqual(h.shown, ['m1'])
  assert.equal(h.chimes(), 1, 'the chime accompanies a toast that rendered')
  assert.equal(h.engine.openCount(), 1)
  assert.deepEqual(h.decisions, [], 'showing the prompt decides nothing')
  assert.ok(h.logs.includes('[invitee-prompt] shown'))
}

// ---- toast answer ----------------------------------------------------------
{
  const h = harness()
  h.engine.show(request('m1'))
  h.engine.answerFromToast('m1', true)
  assert.deepEqual(h.decisions, [{ meetingId: 'm1', approved: true, source: 'toast' }])
  assert.deepEqual(h.closed, ['m1'], 'the toast is closed')
  assert.equal(h.timers(), 0, 'the timer is cancelled')
  h.advance(TOAST_LIFETIME_MS * 2)
  assert.equal(h.decisions.length, 1, 'no timeout follows an answer')
  assert.ok(h.logs.includes('[invitee-prompt] answered'))
}

// ---- timeout = the safe default ---------------------------------------------
{
  const h = harness()
  h.engine.show(request('m1'))
  h.advance(TOAST_LIFETIME_MS - 1)
  assert.deepEqual(h.decisions, [], 'not before the lifetime')
  h.advance(1)
  assert.deepEqual(h.decisions, [{ meetingId: 'm1', approved: false, source: 'timeout' }])
  assert.deepEqual(h.closed, ['m1'])
  assert.equal(h.engine.openCount(), 0)
  assert.ok(h.logs.includes('[invitee-prompt] timeout'))
}

// ---- default lifetime is the app standard, not a new constant ---------------
{
  const h = harness()
  h.engine.show(request('m1'))
  h.advance(2 * 60_000)
  assert.equal(h.decisions.length, 1, 'default lifetime is TOAST_LIFETIME_MS (2 min)')
}

// ---- in-app answer cancels the timer and sends nothing ----------------------
{
  const h = harness()
  h.engine.show(request('m1'))
  h.engine.closeFromApp('m1')
  assert.deepEqual(h.closed, ['m1'])
  h.advance(TOAST_LIFETIME_MS * 2)
  assert.deepEqual(h.decisions, [], 'the renderer already has its own answer')
}

// ---- stale click ------------------------------------------------------------
{
  const h = harness()
  h.engine.show(request('m1'))
  h.advance(TOAST_LIFETIME_MS)
  h.engine.answerFromToast('m1', true)
  assert.deepEqual(
    h.decisions,
    [{ meetingId: 'm1', approved: false, source: 'timeout' }],
    'a toast that lingered in Action Center after the timer fired cannot send anything'
  )
  assert.ok(h.logs.includes('[invitee-prompt] stale-click'))
}

// ---- two meetings are independent -------------------------------------------
{
  const h = harness()
  h.engine.show(request('m1'))
  h.advance(60_000)
  h.engine.show(request('m2'))
  assert.equal(h.engine.openCount(), 2)
  h.engine.answerFromToast('m2', true)
  h.advance(60_000)
  assert.deepEqual(h.decisions, [
    { meetingId: 'm2', approved: true, source: 'toast' },
    { meetingId: 'm1', approved: false, source: 'timeout' }
  ])
}

// ---- a toast that cannot be shown still times out ---------------------------
{
  const h = harness({ toastFails: true })
  h.engine.show(request('m1'))
  assert.equal(h.chimes(), 0, 'no chime without a toast')
  assert.equal(h.engine.openCount(), 1, 'the hold still has its backstop')
  h.advance(TOAST_LIFETIME_MS)
  assert.deepEqual(h.decisions, [{ meetingId: 'm1', approved: false, source: 'timeout' }])
}

// ---- re-showing the same meeting replaces, never doubles --------------------
{
  const h = harness()
  h.engine.show(request('m1'))
  h.engine.show(request('m1'))
  assert.deepEqual(h.closed, ['m1'], 'the first toast is closed')
  assert.equal(h.timers(), 1, 'one timer')
  h.advance(TOAST_LIFETIME_MS)
  assert.equal(h.decisions.length, 1, 'one timeout')
}

// ---- dispose ----------------------------------------------------------------
{
  const h = harness()
  h.engine.show(request('m1'))
  h.engine.dispose()
  h.advance(TOAST_LIFETIME_MS * 2)
  assert.deepEqual(h.decisions, [], 'quitting decides nothing: the card resurfaces on next launch')
  assert.equal(h.engine.openCount(), 0)
}

// ---- display names and IPC payload validation -------------------------------
{
  assert.deepEqual(
    inviteeDisplayNames([
      { name: 'David Ahlhaus', email: 'da@factor1.com.au' },
      { name: null, email: 'mel@factor1.com.au' },
      { name: '  ', email: 'sam@factor1.com.au' }
    ]),
    ['David Ahlhaus', 'mel@factor1.com.au', 'sam@factor1.com.au']
  )
  assert.deepEqual(parseInviteePromptRequest(request('m1')), request('m1'))
  assert.equal(parseInviteePromptRequest(null), null)
  assert.equal(parseInviteePromptRequest({ meetingId: '', title: 't', candidates: [] }), null)
  assert.equal(
    parseInviteePromptRequest({ meetingId: 'm1', title: 't', candidates: [] }),
    null,
    'nobody to ask about: there is no prompt'
  )
  assert.equal(parseInviteePromptRequest({ meetingId: 'm1', title: 't', candidates: [{ name: 'x' }] }), null)
  assert.deepEqual(
    parseInviteePromptRequest({ meetingId: 'm1', candidates: [{ email: 'a@factor1.com.au' }] }),
    { meetingId: 'm1', title: '', candidates: [{ name: null, email: 'a@factor1.com.au' }] },
    'missing title and name are normalised, not rejected'
  )
}

console.log('Invitee prompt verification passed')
