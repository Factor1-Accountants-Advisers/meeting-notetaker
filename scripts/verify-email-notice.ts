import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deliveryOutcomeNotice, emailFailureMessage } from '../src/renderer/src/lib/deliveryNotice'

// IN-478: when a send attempt ends `unconfirmed` (transport error or backend
// restart mid-send), the post-capture notice must warn the user the email may
// already have been delivered — never claim "email was not sent", which
// invited the duplicate resend.

const fallback = 'Transcript saved to SharePoint, but email was not sent. Sign in to Outlook, then retry email.'

assert.equal(
  emailFailureMessage('unconfirmed', 'Backend says check your inbox first.', fallback),
  'Backend says check your inbox first.',
  'unconfirmed uses the backend explanation when present'
)

const warning = emailFailureMessage('unconfirmed', null, fallback)
assert.match(warning, /may already have been delivered/, 'unconfirmed warns about possible delivery')
assert.match(warning, /inbox/, 'unconfirmed points the user at their inbox')

assert.equal(
  emailFailureMessage('failed', 'definitive failure detail', fallback),
  fallback,
  'a definitive failure keeps the actionable fallback message'
)
assert.equal(emailFailureMessage(undefined, null, fallback), fallback, 'unknown state keeps the fallback')
assert.equal(emailFailureMessage('not_started', null, fallback), fallback, 'not_started keeps the fallback')

// One delivery pass, one place that turns its result into a card. The strings
// are the ones watchProcessing ('first') and retryTranscriptEmail ('retry')
// have always shown; this pins the extraction as behaviour-preserving.
const base = { emailRecipients: null, sharePointSaved: false } as const

assert.deepEqual(
  deliveryOutcomeNotice({
    attempt: 'first',
    emailRecipients: ['joseph@factor1.com.au', 'da@factor1.com.au'],
    sharePointSaved: true
  }),
  {
    state: 'ready',
    message: 'Transcript saved to SharePoint and emailed to joseph@factor1.com.au, da@factor1.com.au.'
  },
  'ready lists the actual addresses (deliberate since 7 Aug) and carries no errorCode'
)
assert.equal(
  deliveryOutcomeNotice({
    attempt: 'retry',
    emailRecipients: ['joseph@factor1.com.au'],
    sharePointSaved: true,
    grantWarning: 'View access could not be granted to: x@factor1.com.au.'
  }).message,
  'Transcript saved to SharePoint and emailed to joseph@factor1.com.au. View access could not be granted to: x@factor1.com.au.',
  'Option A (IN-398): the grant warning is appended, not hidden'
)

for (const [attempt, sharePointFailed, emailFailed, bothFailed] of [
  [
    'first',
    'Transcript email was sent, but SharePoint save failed. Sign in again, then retry delivery.',
    'Transcript saved to SharePoint, but email was not sent. Sign in to Outlook, then retry email.',
    'Notes are ready, but SharePoint save and transcript email failed. Sign in to Microsoft, then retry delivery.'
  ],
  [
    'retry',
    'Transcript email was sent, but SharePoint save still failed.',
    'Transcript saved to SharePoint, but email still failed.',
    'SharePoint save and email still failed. The notes are ready and the recording is safe.'
  ]
] as const) {
  assert.deepEqual(
    deliveryOutcomeNotice({ attempt, emailRecipients: ['j@factor1.com.au'], sharePointSaved: false }),
    { state: 'email_failed', message: sharePointFailed, errorCode: null },
    `${attempt}: email sent, SharePoint failed → fallback "Processing error" label`
  )
  assert.deepEqual(
    deliveryOutcomeNotice({
      ...base,
      attempt,
      sharePointSaved: true,
      deliveryStatus: 'failed',
      deliveryErrorCode: 'azure_signin'
    }),
    { state: 'email_failed', message: emailFailed, errorCode: 'azure_signin' },
    `${attempt}: SharePoint saved, email failed`
  )
  assert.deepEqual(
    deliveryOutcomeNotice({ ...base, attempt, deliveryStatus: 'failed' }),
    { state: 'email_failed', message: bothFailed, errorCode: null },
    `${attempt}: both failed, no classified code → null`
  )
}

const unconfirmed = deliveryOutcomeNotice({
  ...base,
  attempt: 'first',
  sharePointSaved: true,
  deliveryStatus: 'unconfirmed',
  deliveryErrorMessage: 'Backend says check your inbox first.',
  deliveryErrorCode: 'network'
})
assert.equal(unconfirmed.message, 'Backend says check your inbox first.')
assert.equal(
  unconfirmed.errorCode,
  undefined,
  "IN-478: 'unconfirmed' is not a failure, so HomeScreen must never render a Failed: label for it"
)

// IN-488 outcomes.
assert.equal(
  deliveryOutcomeNotice({
    attempt: 'first',
    emailRecipients: ['joseph@factor1.com.au'],
    sentNow: ['joseph@factor1.com.au'],
    sharePointSaved: true,
    sendLaterOffered: true
  }).message,
  "Transcript saved to SharePoint and emailed to joseph@factor1.com.au. Invitees haven't received it.",
  'after "Just me" or a timeout the card must not read as if delivery is finished'
)
assert.equal(
  deliveryOutcomeNotice({
    attempt: 'retry',
    emailRecipients: ['joseph@factor1.com.au', 'da@factor1.com.au', 'mel@factor1.com.au'],
    sentNow: ['da@factor1.com.au', 'mel@factor1.com.au'],
    sharePointSaved: true
  }).message,
  'Sent to da@factor1.com.au, mel@factor1.com.au.',
  'a later send names only the people THIS send reached'
)
assert.equal(
  deliveryOutcomeNotice({
    attempt: 'retry',
    emailRecipients: ['joseph@factor1.com.au', 'da@factor1.com.au'],
    sentNow: [],
    sharePointSaved: true
  }).message,
  'Transcript saved to SharePoint and emailed to joseph@factor1.com.au, da@factor1.com.au.',
  'a replay (nothing sent now) lists everyone who has it'
)
assert.deepEqual(
  deliveryOutcomeNotice({
    ...base,
    attempt: 'retry',
    sharePointSaved: true,
    deliveryStatus: 'emailed',
    inviteeDeliveryStatus: 'failed',
    inviteeErrorMessage: 'Outlook sign-in is required before the transcript can be sent to invitees',
    inviteeErrorCode: 'azure_signin'
  }),
  {
    state: 'email_failed',
    message:
      'Outlook sign-in is required before the transcript can be sent to invitees. ' +
      'Nothing was sent to invitees; your own copy was already delivered.',
    errorCode: 'azure_signin'
  },
  'a failed later send reassures the owner about their own copy (mock-up 4)'
)
const inviteeUnconfirmed = deliveryOutcomeNotice({
  ...base,
  attempt: 'retry',
  sharePointSaved: true,
  deliveryStatus: 'emailed',
  inviteeDeliveryStatus: 'unconfirmed',
  inviteeErrorMessage: 'It may already have been delivered. Check with an invitee before resending.'
})
assert.equal(inviteeUnconfirmed.message, 'It may already have been delivered. Check with an invitee before resending.')
assert.equal(inviteeUnconfirmed.errorCode, undefined, 'unconfirmed is never a Failed: label')

// Fix round 1: a lost response after a completed (or never-started) invitee
// send is not a failure either — the 90s proxy budget can abort just after
// Graph finishes, or before an invitee send even begins.
const inviteeAlreadySent = deliveryOutcomeNotice({
  ...base,
  attempt: 'retry',
  sharePointSaved: true,
  deliveryStatus: 'emailed',
  inviteeDeliveryStatus: 'sent'
})
assert.match(
  inviteeAlreadySent.message,
  /already sent to the invitees/,
  'a lost response after a completed invitee send must not read as a failure'
)
assert.equal(inviteeAlreadySent.errorCode, undefined, 'sent is never a Failed: label')

const inviteeNotStarted = deliveryOutcomeNotice({
  ...base,
  attempt: 'retry',
  sharePointSaved: true,
  deliveryStatus: 'emailed',
  inviteeDeliveryStatus: 'not_started'
})
assert.match(
  inviteeNotStarted.message,
  /nothing was sent to invitees/,
  'not_started must not claim an invitee send was attempted'
)
assert.equal(inviteeNotStarted.errorCode, undefined, 'not_started is never a Failed: label')

// Every delivery goes through the one pass.
{
  const app = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'App.tsx'), 'utf8')
  assert.equal((app.match(/saveTranscriptToSharePoint\(/g) ?? []).length, 1, 'one SharePoint call site')
  assert.equal((app.match(/emailNotes\(/g) ?? []).length, 1, 'one email call site')
}

console.log('Email notice verification passed')
