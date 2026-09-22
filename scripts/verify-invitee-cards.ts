import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  INVITEES_NOT_SENT,
  RESURFACE_WINDOW_MS,
  canSendLater,
  emailingMessage,
  formatEmailedAt,
  interpretInviteesResponse,
  inviteeNamesLine,
  inviteeQuestion,
  parseDismissed,
  resurfaceKind,
  resurfacedSendLaterMessage,
  sendLaterLabel,
  sendingLaterMessage,
  shouldPrompt,
  withDismissed,
  type InviteeState,
  type ResurfaceMeeting
} from '../src/renderer/src/lib/inviteePrompt'

// IN-488: the in-app half of "ask before emailing invitees". Card copy, the
// rules for when to ask and when to offer "Send to N invitees", what comes
// back after a restart, and the old-backend fallback.

const five = [
  { name: 'David Ahlhaus', email: 'da@factor1.com.au' },
  { name: 'Priya Nair', email: 'priya@factor1.com.au' },
  { name: null, email: 'sam@factor1.com.au' },
  { name: 'Alex Morgan', email: 'alex@factor1.com.au' },
  { name: 'Jordan Lee', email: 'jordan@factor1.com.au' }
]
const one = five.slice(0, 1)

// ---- copy -------------------------------------------------------------------
assert.equal(inviteeQuestion(five), 'Notes are ready. Email the transcript to 5 invitees?')
assert.equal(
  inviteeQuestion(one),
  'Notes are ready. Email the transcript to David Ahlhaus?',
  'singular wording (Q6)'
)
assert.equal(
  inviteeNamesLine(five),
  'David Ahlhaus, Priya Nair, sam@factor1.com.au, Alex Morgan, Jordan Lee',
  'the card shows the FULL list (the toast only fits three); no name falls back to the address'
)
assert.equal(inviteeNamesLine(one), null, 'one invitee is already named in the question')
assert.equal(sendLaterLabel(5), 'Send to 5 invitees')
assert.equal(sendLaterLabel(1), 'Send to 1 invitee')
assert.equal(emailingMessage(true, 5), 'Saving to SharePoint and emailing to you and 5 invitees…')
assert.equal(emailingMessage(true, 1), 'Saving to SharePoint and emailing to you and 1 invitee…')
assert.equal(emailingMessage(false, 5), 'Saving to SharePoint and emailing to you…')
assert.equal(sendingLaterMessage(5), 'Sending the transcript to 5 invitees…')
assert.equal(INVITEES_NOT_SENT, "Invitees haven't received it.")

// ---- when to ask, when to offer send-later ----------------------------------
const state = (over: Partial<InviteeState> = {}): InviteeState => ({
  candidates: five,
  decision: 'pending',
  invitee_delivery_status: 'not_started',
  invitee_recipients: [],
  prompt_enabled: true,
  ...over
})
assert.equal(shouldPrompt(state()), true)
assert.equal(shouldPrompt(null), false, 'cannot ask: deliver now')
assert.equal(shouldPrompt(state({ prompt_enabled: false })), false, 'kill switch / attendees mode: never ask')
assert.equal(shouldPrompt(state({ candidates: [] })), false, 'nobody to ask about')
assert.equal(shouldPrompt(state({ decision: 'approved' })), false, 'already answered')
assert.equal(shouldPrompt(state({ decision: 'declined' })), false, 'already answered')

assert.equal(canSendLater(state({ decision: 'declined' })), true)
assert.equal(canSendLater(state({ decision: 'pending' })), true, 'an answer that failed to record can still be sent later')
assert.equal(canSendLater(state({ decision: 'approved' })), false)
assert.equal(canSendLater(state({ decision: 'declined', invitee_delivery_status: 'sent' })), false)
assert.equal(
  canSendLater(state({ decision: 'declined', prompt_enabled: false })),
  false,
  'kill switch: the leftover button must not be offered (21 Sep "B" ruling)'
)
assert.equal(canSendLater(state({ decision: 'declined', candidates: [] })), false)
assert.equal(canSendLater(null), false)

// ---- 404 means "no prompt support" ------------------------------------------
assert.equal(
  interpretInviteesResponse({ ok: false, status: 404, body: { detail: 'Not Found' } }),
  null,
  'an older backend has no /invitees route: deliver now, which there means organiser only'
)
assert.equal(interpretInviteesResponse({ ok: false, status: 0, body: null }), null, 'backend unreachable')
assert.equal(interpretInviteesResponse({ ok: false, status: 403, body: null }), null, 'not the owner')
assert.equal(interpretInviteesResponse({ ok: true, status: 200, body: { nonsense: true } }), null, 'unrecognised body')
assert.deepEqual(
  interpretInviteesResponse({
    ok: true,
    status: 200,
    body: {
      candidates: [{ name: '  ', email: 'da@factor1.com.au' }, { junk: 1 }],
      decision: 'pending',
      invitee_delivery_status: 'not_started',
      invitee_recipients: [],
      prompt_enabled: true
    }
  }),
  state({ candidates: [{ name: null, email: 'da@factor1.com.au' }] }),
  'blank names normalise to null; malformed candidates are dropped'
)

// ---- restart resurfacing ----------------------------------------------------
const NOW = Date.parse('2026-09-21T02:00:00Z')
const none = new Set<string>()
const meeting = (over: Partial<ResurfaceMeeting> = {}): ResurfaceMeeting => ({
  id: 'm1',
  created_at: '2026-09-20T02:00:00Z',
  pipeline_status: 'ready',
  delivery_status: 'not_started',
  invitee_decision: 'pending',
  invitee_delivery_status: 'not_started',
  ...over
})
assert.equal(resurfaceKind(meeting(), NOW, none), 'pending', 'the app closed during the hold')
assert.equal(
  resurfaceKind(meeting({ delivery_status: 'emailed' }), NOW, none),
  null,
  'EVERY pre-IN-488 meeting loads as pending + emailed: widening this floods Home on the first launch after the update'
)
assert.equal(
  resurfaceKind(meeting({ invitee_decision: 'declined', delivery_status: 'emailed' }), NOW, none),
  'send_later'
)
assert.equal(
  resurfaceKind(
    meeting({ invitee_decision: 'approved', delivery_status: 'emailed', invitee_delivery_status: 'failed' }),
    NOW,
    none
  ),
  'send_later',
  'the owner said yes and the send never completed: do not lose it silently'
)
assert.equal(
  resurfaceKind(
    meeting({ invitee_decision: 'approved', delivery_status: 'emailed', invitee_delivery_status: 'sent' }),
    NOW,
    none
  ),
  null
)
assert.equal(
  resurfaceKind(meeting({ invitee_decision: 'declined', delivery_status: 'failed' }), NOW, none),
  null,
  'the send-later card says "Emailed to you on…", which would be false here'
)
assert.equal(
  resurfaceKind(meeting({ invitee_decision: 'declined', delivery_status: 'emailed' }), NOW, new Set(['m1'])),
  null,
  'dismissed send-later cards stay dismissed'
)
assert.equal(resurfaceKind(meeting(), NOW, new Set(['m1'])), 'pending', 'a pending question cannot be dismissed')
assert.equal(resurfaceKind(meeting({ pipeline_status: 'processing' }), NOW, none), null)
assert.equal(
  resurfaceKind(meeting({ created_at: new Date(NOW - RESURFACE_WINDOW_MS - 1).toISOString() }), NOW, none),
  null,
  'older than 7 days'
)
assert.equal(RESURFACE_WINDOW_MS, 7 * 24 * 60 * 60_000)
assert.equal(
  resurfaceKind(meeting({ invitee_decision: undefined, invitee_delivery_status: undefined }), NOW, none),
  null,
  'a backend from before IN-488 sends no invitee fields'
)

// Local-time constructor, so this pin holds in any timezone.
assert.equal(formatEmailedAt(new Date(2026, 8, 15, 14, 32)), 'Tue 15 Sep, 14:32')
assert.equal(formatEmailedAt(new Date(2026, 0, 5, 9, 5)), 'Mon 5 Jan, 09:05')
assert.match(
  resurfacedSendLaterMessage(new Date(2026, 8, 15, 14, 32).toISOString()),
  /^Emailed to you on Tue 15 Sep, 14:32\. Invitees haven't received it\.$/
)
assert.equal(resurfacedSendLaterMessage(null), "Emailed to you. Invitees haven't received it.")
assert.equal(resurfacedSendLaterMessage('not a date'), "Emailed to you. Invitees haven't received it.")

// ---- dismissed set ----------------------------------------------------------
assert.deepEqual(parseDismissed(null), [])
assert.deepEqual(parseDismissed('not json'), [])
assert.deepEqual(parseDismissed('{"a":1}'), [])
assert.deepEqual(parseDismissed('["m1", 7, "m2"]'), ['m1', 'm2'])
assert.deepEqual(withDismissed(['m1'], 'm2'), ['m1', 'm2'])
assert.deepEqual(withDismissed(['m1', 'm2'], 'm1'), ['m2', 'm1'], 'no duplicates')
assert.equal(
  withDismissed(Array.from({ length: 200 }, (_, i) => `m${i}`), 'new').length,
  200,
  'capped, so localStorage cannot grow without bound'
)

// ---- wiring pins (Task 12) ---------------------------------------------------
{
  const read = (...parts: string[]): string => readFileSync(join(process.cwd(), 'src', 'renderer', 'src', ...parts), 'utf8')
  const app = read('App.tsx')
  assert.match(app, /'awaiting_invitees'/, 'the hold has its own post-capture state')
  assert.match(app, /window\.api\.promptInvitees\(/, 'the renderer asks main to show the toast')
  assert.match(app, /window\.api\.closeInviteePrompt/, "an in-app answer cancels main's timer")
  assert.match(app, /window\.api\.onInviteeDecision\(/, 'toast answers and the timeout reach the renderer')
  const hold = app.slice(app.indexOf('const deliverWithInviteeHold'))
  assert.ok(
    hold.indexOf('postInviteeDecision(') < hold.indexOf('runDeliveryPass('),
    'the decision is recorded BEFORE delivery starts, so every retry uses the same recipient list'
  )
  const activeNotice = app.slice(app.indexOf('const activePostCaptureNotice'), app.indexOf('const shellRecordingState'))
  assert.doesNotMatch(activeNotice, /awaiting_invitees/, 'waiting for an answer is not "processing" in the status bar')

  const home = read('screens', 'HomeScreen.tsx')
  assert.match(home, /sendLaterLabel\(/, 'the ready card offers Send to N invitees')
  assert.match(home, /inviteeNamesLine\(/, 'the pending card shows the full list')
}

// ---- wiring pins (Task 13) ---------------------------------------------------
{
  const read = (...parts: string[]): string => readFileSync(join(process.cwd(), 'src', 'renderer', 'src', ...parts), 'utf8')
  const app = read('App.tsx')
  assert.match(app, /resurfaceKind\(/, 'launch scan uses the pure restart filter')
  assert.match(app, /DISMISSED_INVITEE_CARDS_KEY/, 'dismissal is a per-machine UI preference in localStorage')
  const scan = app.slice(app.indexOf('resurfaceKind('))
  assert.ok(
    scan.indexOf('prompt_enabled') !== -1 && scan.indexOf('prompt_enabled') < scan.indexOf('setInviteeCards('),
    'no card is built under the kill switch'
  )
  const home = read('screens', 'HomeScreen.tsx')
  assert.match(home, /resurfacedSendLaterMessage\(/, 'send-later card shows when the owner was emailed')
  assert.doesNotMatch(
    home.slice(home.indexOf('function InviteeResurfacedNotice')),
    /promptInvitees/,
    'no toast and no timer after a restart'
  )
}

console.log('Invitee cards verification passed')
