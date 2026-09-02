import assert from 'node:assert/strict'
import {
  buildCaptureWarnings,
  type CaptureWarningInput
} from '../src/renderer/src/lib/captureWarnings'

function base(overrides: Partial<CaptureWarningInput> = {}): CaptureWarningInput {
  return {
    source: 'online',
    mic: 'active',
    loopback: 'active',
    recording: true,
    hasMeeting: true,
    ...overrides
  }
}

// --- The AirPods / Bluetooth signature: online meeting, remote audio IS being
// captured (loopback active) but the local mic is digital-silence. This is the
// high-confidence "recording the wrong microphone" case and must escalate to a
// prominent, actionable banner naming the headset-default-device fix. ---
const airpods = buildCaptureWarnings(base({ mic: 'silent', loopback: 'active' }))
const banner = airpods.find((w) => w.severity === 'banner')
assert.ok(banner, 'online + mic silent + loopback active must produce a banner')
assert.equal(banner!.id, 'mic-silent-wrong-device', 'banner has the stable id')
assert.match(
  banner!.text + ' ' + (banner!.title ?? ''),
  /headset|bluetooth|airpods|default input/i,
  'banner names the headset/default-input cause and fix'
)
assert.equal(banner!.tone, 'danger', 'banner is a danger-tone warning')
assert.equal(airpods[0]!.id, 'mic-silent-wrong-device', 'the banner is ordered first (most urgent)')

// --- In-person meeting (no loopback): mic silent is still a warning, but we
// cannot attribute it to a wrong-device split, so it stays a plain row with the
// generic (still strengthened) guidance — never the Bluetooth banner. ---
const inperson = buildCaptureWarnings(base({ source: 'in_person', mic: 'silent', loopback: 'off' }))
assert.ok(
  inperson.every((w) => w.severity !== 'banner'),
  'in-person mic silence does not raise the wrong-device banner'
)
const micRow = inperson.find((w) => w.id === 'mic-silent')
assert.ok(micRow, 'in-person mic silence still surfaces a mic warning row')
assert.match(micRow!.text, /default input|microphone/i, 'generic row points at the default input')

// --- Online, mic silent, but loopback ALSO dead: both channels down is a
// different failure (not confidently a device split), so no wrong-device banner. ---
const bothDead = buildCaptureWarnings(base({ mic: 'silent', loopback: 'error' }))
assert.ok(
  !bothDead.some((w) => w.id === 'mic-silent-wrong-device'),
  'mic silent + loopback down does not claim a wrong-device split'
)

// --- Healthy mic: no mic warning at all. ---
const healthy = buildCaptureWarnings(base())
assert.ok(!healthy.some((w) => w.id.startsWith('mic-')), 'active mic yields no mic warning')

// --- mic 'error' is unavailable (permission/device), distinct from silent. ---
const micError = buildCaptureWarnings(base({ mic: 'error' }))
assert.ok(
  micError.some((w) => w.id === 'mic-unavailable'),
  'mic error surfaces the unavailable warning'
)
assert.ok(
  !micError.some((w) => w.id === 'mic-silent-wrong-device'),
  'mic error is not the wrong-device banner'
)

// --- Existing warnings still produced: not recording, loopback issues, backend. ---
assert.ok(
  buildCaptureWarnings(base({ recording: false })).some((w) => w.id === 'not-recording'),
  'not recording still warns'
)
assert.ok(
  buildCaptureWarnings(base({ loopback: 'error' })).some((w) => w.id === 'loopback-error'),
  'online loopback error still warns'
)
assert.ok(
  buildCaptureWarnings(base({ hasMeeting: false })).some((w) => w.id === 'backend-unsaved'),
  'missing meeting id still warns'
)
// In-person never raises loopback warnings.
assert.ok(
  !buildCaptureWarnings(base({ source: 'in_person', loopback: 'error' })).some((w) =>
    w.id.startsWith('loopback')
  ),
  'in-person ignores loopback state'
)

console.log('verify-capture-warnings: all assertions passed')
