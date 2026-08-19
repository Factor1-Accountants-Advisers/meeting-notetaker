import assert from 'node:assert/strict'
import {
  ENDING_SOON_TOAST_LIFETIME_MS,
  TOAST_LIFETIME_MS,
  buildEndingSoonToastXml,
  buildJoinPromptToastXml,
  buildRecordingPausedToastXml,
  buildRecordingStartedToastXml,
  buildUpdateCountdownToastXml,
  buildUpdateReadyToastXml,
  toastActionFromArgv,
  toastUri
} from '../src/main/toast-xml'
import { JOIN_WATCH_PROMPT_LIFETIME_MS } from '../src/main/join-watch-core'

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

// "Recording paused because you left the meeting" toast (meeting-call-events,
// Task 11, spec 2026-08-12). Same protocol-activation / reminder-scenario /
// silent-audio contract as the toasts above. upload-now and resume-recording
// are new verbs introduced after the IN-483 fix, so — unlike extend/open/
// update-restart/update-defer — they have NO legacy mn-* form to accept.
const paused = buildRecordingPausedToastXml('Recording paused because you left "Q&A <sync>".')
assert.match(paused, /<toast[^>]*scenario="reminder"/, 'paused toast stays on screen until acted on')
assert.match(paused, /launch="notetaker:\/\/open"/, 'clicking the toast body still opens the app')
assert.match(paused, /<audio silent="true"\/>/, 'toast is silent — chime comes from the renderer')
assert.match(
  paused,
  /<action content="Upload now" activationType="protocol" arguments="notetaker:\/\/upload-now"\/>/,
  'Upload now button activates via protocol'
)
assert.match(
  paused,
  /<action content="Keep recording" activationType="protocol" arguments="notetaker:\/\/resume-recording"\/>/,
  'Keep recording button activates via protocol'
)
assert.match(
  paused,
  /Recording paused because you left &quot;Q&amp;A &lt;sync&gt;&quot;\./,
  'body text is XML-escaped'
)
assert.doesNotMatch(paused, /<sync>/, 'raw angle brackets never reach the toast XML')
assert.doesNotMatch(paused, /activationType="foreground"/, 'no dead foreground buttons (IN-483)')
assert.doesNotMatch(paused, /mn-upload-now/, 'upload-now has no legacy mn-* form')
assert.doesNotMatch(paused, /mn-resume-recording/, 'resume-recording has no legacy mn-* form')

assert.equal(toastActionFromArgv(['exe', toastUri('upload-now')]), 'upload-now')
assert.equal(toastActionFromArgv(['exe', 'notetaker://upload-now/']), 'upload-now')
assert.equal(toastActionFromArgv(['exe', toastUri('resume-recording')]), 'resume-recording')
assert.equal(toastActionFromArgv(['exe', 'notetaker://resume-recording/']), 'resume-recording')
assert.equal(toastActionFromArgv(['exe', 'mn-upload-now']), null, 'no legacy mn-* form for upload-now')
assert.equal(
  toastActionFromArgv(['exe', 'mn-resume-recording']),
  null,
  'no legacy mn-* form for resume-recording'
)
assert.equal(toastActionFromArgv(['exe', '--background']), null, 'unrelated argv still yields null')

// Join-trigger prompt (spec J3): shown once per meeting at start + 2 min when
// the meeting is armed and nothing is recording. Same protocol-activation /
// reminder-scenario / silent-audio contract as the toasts above.
{
  const xml = buildJoinPromptToastXml('Weekly 1:1 with Kristel')
  assert.match(xml, /Meeting Weekly 1:1 with Kristel has started/)
  assert.match(xml, /Recording will begin when you join\./)
  assert.match(xml, /arguments="notetaker:\/\/record-now"/)
  assert.match(xml, /content="Record now"/)
  assert.match(xml, /scenario="reminder"/, 'sticky so our own close() (TOAST_LIFETIME_MS) governs lifetime')
  assert.match(xml, /<audio silent="true"\/>/)
  // XML-escaping of the title, same rule as the other builders
  assert.match(buildJoinPromptToastXml('Q&A <Board>'), /Meeting Q&amp;A &lt;Board&gt; has started/)
  // No title (Graph gave none, or the watcher's fallback is ''): plain
  // wording, never "Meeting  has started" with a hole in it.
  const untitled = buildJoinPromptToastXml('')
  assert.match(untitled, /<text>Your meeting has started<\/text>/, 'empty title → generic first line')
  assert.doesNotMatch(untitled, /Meeting  has started/, 'no double-space hole for an empty title')
  assert.match(untitled, /Recording will begin when you join\./, 'body line unchanged')
  assert.match(untitled, /arguments="notetaker:\/\/record-now"/, 'Record now still wired')
  assert.equal(toastActionFromArgv(['notetaker://record-now']), 'record-now')
  assert.equal(toastActionFromArgv(['notetaker://record-now/']), 'record-now', 'trailing slash tolerated like the others')
}

// Notifications review with DA (19 Aug 2026): a "Recording started" toast on
// every auto-triggered start (join / prompt / calendar) — confirmation the
// trigger fired, and the cue to tell the room it is being recorded — and
// longer on-screen lifetimes: 2 min standard, 5 min for the ending-soon
// warning (it also goes when the recording stops or is extended).
{
  const xml = buildRecordingStartedToastXml('Weekly 1:1 with Kristel')
  assert.match(xml, /<toast[^>]*scenario="reminder"/, 'sticky; the runtime closes it after TOAST_LIFETIME_MS')
  assert.match(xml, /<text>Recording started<\/text>/, 'headline')
  assert.match(xml, /Weekly 1:1 with Kristel/, 'names the meeting')
  assert.match(xml, /being recorded/, 'privacy reminder line (DA)')
  assert.match(xml, /launch="notetaker:\/\/open"/, 'body click opens the app')
  assert.match(xml, /<audio silent="true"\/>/, 'silent — the chime comes from the renderer')
  assert.match(xml, /<action content="Dismiss" activationType="system" arguments="dismiss"\/>/, 'reminder toasts need an action')
  assert.doesNotMatch(xml, /activationType="foreground"/, 'IN-483: no dead foreground buttons')
  assert.match(buildRecordingStartedToastXml('Q&A <Board>'), /Q&amp;A &lt;Board&gt;/, 'title is XML-escaped')
  const untitled = buildRecordingStartedToastXml('')
  assert.match(untitled, /<text>Recording started<\/text>/)
  assert.doesNotMatch(untitled, /""/, 'no empty quoted title')
  assert.match(untitled, /being recorded/)

  assert.equal(TOAST_LIFETIME_MS, 2 * 60_000, 'standard toast lifetime is 2 min')
  assert.equal(ENDING_SOON_TOAST_LIFETIME_MS, 5 * 60_000, 'ending-soon warning stays 5 min')
  assert.equal(JOIN_WATCH_PROMPT_LIFETIME_MS, TOAST_LIFETIME_MS, 'join prompt follows the standard lifetime')
}

console.log('Toast XML verification passed')
