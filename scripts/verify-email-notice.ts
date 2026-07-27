import assert from 'node:assert/strict'
import { emailFailureMessage } from '../src/renderer/src/lib/deliveryNotice'

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

console.log('Email notice verification passed')
