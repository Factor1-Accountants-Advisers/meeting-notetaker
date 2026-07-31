import assert from 'node:assert/strict'
import {
  buildEndingSoonToastXml,
  buildUpdateCountdownToastXml,
  buildUpdateReadyToastXml,
  toastActionFromArgv,
  toastUri
} from '../src/main/toast-xml'

// IN-477: the 5-minute warning was easy to miss — Windows toasts auto-dismiss
// after ~5 s. The warning toast must now stay on screen until acknowledged
// (reminder scenario + explicit Dismiss action) and stay silent so the
// renderer-played chime is the only sound.
//
// IN-483: every actionable element activates via the notetaker:// protocol.
// foreground-activation arguments are silently dropped by Windows for apps
// without a COM activation callback (which Electron lacks) — a foreground
// button anywhere in this XML is a regression back to dead buttons.

const xml = buildEndingSoonToastXml('"Firmwide catchup" is scheduled to end in 5 minutes.')

assert.match(xml, /<toast[^>]*scenario="reminder"/, 'warning toast is sticky until acknowledged')
assert.match(xml, /launch="notetaker:\/\/open"/, 'clicking the toast body still opens the app')
assert.match(xml, /<audio silent="true"\/>/, 'toast is silent — the chime comes from the renderer')
assert.match(
  xml,
  /<action content="Extend 10 min" activationType="protocol" arguments="notetaker:\/\/extend"\/>/,
  'Extend button activates via protocol (IN-483)'
)
assert.match(
  xml,
  /<action content="Dismiss" activationType="system" arguments="dismiss"\/>/,
  'reminder toasts need an explicit acknowledge action'
)
assert.match(xml, /is scheduled to end in 5 minutes\./, 'body text present')
assert.doesNotMatch(
  xml,
  /activationType="foreground"/,
  'foreground activation drops arguments without a COM activator (IN-483)'
)

const escaped = buildEndingSoonToastXml('"Q&A <prep>" is scheduled to end in 5 minutes.')
assert.match(escaped, /&quot;Q&amp;A &lt;prep&gt;&quot;/, 'meeting titles are XML-escaped')
assert.doesNotMatch(escaped, /<prep>/, 'raw angle brackets never reach the toast XML')

// Update toasts (IN-469) — same protocol-activation contract.
const ready = buildUpdateReadyToastXml('2.0.11')
assert.match(
  ready,
  /<action content="Restart now" activationType="protocol" arguments="notetaker:\/\/update-restart"\/>/,
  'Restart button activates via protocol'
)
assert.match(
  ready,
  /<action content="Later" activationType="protocol" arguments="notetaker:\/\/update-defer"\/>/,
  'Later button activates via protocol'
)
assert.doesNotMatch(ready, /activationType="foreground"/, 'no dead foreground buttons')

const countdown = buildUpdateCountdownToastXml('2.0.11', 60)
assert.match(countdown, /<toast[^>]*scenario="reminder"/, 'countdown stays on screen')
assert.match(
  countdown,
  /<action content="Not now" activationType="protocol" arguments="notetaker:\/\/update-defer"\/>/,
  'Not now button activates via protocol'
)

// argv parser: protocol URIs (current), legacy mn-* (toasts shown by pre-fix
// versions can outlive the update that fixes them), trailing-slash tolerance
// (Windows can append one to protocol launches), and non-toast argv.
assert.equal(toastActionFromArgv(['exe', toastUri('extend')]), 'extend')
assert.equal(toastActionFromArgv(['exe', 'notetaker://update-restart/']), 'update-restart')
assert.equal(toastActionFromArgv(['exe', toastUri('update-defer')]), 'update-defer')
assert.equal(toastActionFromArgv(['exe', toastUri('open')]), 'open')
assert.equal(toastActionFromArgv(['exe', 'mn-extend']), 'extend')
assert.equal(toastActionFromArgv(['exe', 'mn-update-restart']), 'update-restart')
assert.equal(toastActionFromArgv(['exe', 'mn-update-defer']), 'update-defer')
assert.equal(toastActionFromArgv(['exe', 'mn-open']), 'open')
assert.equal(toastActionFromArgv(['exe', '--background']), null)
assert.equal(toastActionFromArgv([]), null)

console.log('Toast XML verification passed')
