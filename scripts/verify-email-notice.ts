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

// Every delivery goes through the one pass.
{
  const app = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'App.tsx'), 'utf8')
  assert.equal((app.match(/saveTranscriptToSharePoint\(/g) ?? []).length, 1, 'one SharePoint call site')
  assert.equal((app.match(/emailNotes\(/g) ?? []).length, 1, 'one email call site')
}

console.log('Email notice verification passed')
