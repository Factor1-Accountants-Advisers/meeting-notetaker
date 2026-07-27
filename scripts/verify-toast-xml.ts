import assert from 'node:assert/strict'
import { buildEndingSoonToastXml } from '../src/main/toast-xml'

// IN-477: the 5-minute warning was easy to miss — Windows toasts auto-dismiss
// after ~5 s. The warning toast must now stay on screen until acknowledged
// (reminder scenario + explicit Dismiss action) and stay silent so the
// renderer-played chime is the only sound.

const xml = buildEndingSoonToastXml('"Firmwide catchup" is scheduled to end in 5 minutes.')

assert.match(xml, /<toast[^>]*scenario="reminder"/, 'warning toast is sticky until acknowledged')
assert.match(xml, /launch="mn-open"/, 'clicking the toast body still opens the app')
assert.match(xml, /<audio silent="true"\/>/, 'toast is silent — the chime comes from the renderer')
assert.match(
  xml,
  /<action content="Extend 10 min" activationType="foreground" arguments="mn-extend"\/>/,
  'Extend button preserved'
)
assert.match(
  xml,
  /<action content="Dismiss" activationType="system" arguments="dismiss"\/>/,
  'reminder toasts need an explicit acknowledge action'
)
assert.match(xml, /is scheduled to end in 5 minutes\./, 'body text present')

const escaped = buildEndingSoonToastXml('"Q&A <prep>" is scheduled to end in 5 minutes.')
assert.match(escaped, /&quot;Q&amp;A &lt;prep&gt;&quot;/, 'meeting titles are XML-escaped')
assert.doesNotMatch(escaped, /<prep>/, 'raw angle brackets never reach the toast XML')

console.log('Toast XML verification passed')
