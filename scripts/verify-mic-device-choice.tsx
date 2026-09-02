import assert from 'node:assert/strict'
import { chooseMicDeviceId, type MicDeviceChoiceInput } from '../src/renderer/src/lib/micDeviceChoice'
import type { AudioEndpointSnapshot } from '../src/shared/audio-endpoints'

function snapshot(commsId: string | null, consoleId: string | null): AudioEndpointSnapshot {
  const ep = (id: string | null, label: string) => (id ? { id, label } : null)
  return {
    schemaVersion: 1,
    kind: 'snapshot',
    generation: 1,
    endpoints: {
      captureCommunications: ep(commsId, 'Headset (AirPods Pro - Find My)'),
      captureConsole: ep(consoleId, 'Microphone (Rapoo Camera)'),
      renderCommunications: null,
      renderConsole: null
    }
  }
}

const COMMS_INPUT = { deviceId: 'communications', kind: 'audioinput', label: 'Communications' }
const DEFAULT_INPUT = { deviceId: 'default', kind: 'audioinput', label: 'Default' }
const RAPOO = { deviceId: 'rapoo-hash', kind: 'audioinput', label: 'Microphone (Rapoo Camera)' }

function base(overrides: Partial<MicDeviceChoiceInput> = {}): MicDeviceChoiceInput {
  return {
    enabled: true,
    explicitMicDeviceId: '',
    snapshot: snapshot('comms-airpods', 'console-rapoo'),
    devices: [COMMS_INPUT, DEFAULT_INPUT, RAPOO],
    ...overrides
  }
}

// --- The AirPods signature: comms endpoint (AirPods) != console endpoint (Rapoo),
// the `communications` alias is enumerable, no explicit user choice, flag on ->
// capture must follow the communications device (where Teams sends the voice). ---
const airpods = chooseMicDeviceId(base())
assert.equal(airpods.deviceId, 'communications', 'device split -> follow the communications endpoint')
assert.equal(airpods.reason, 'follow-communications')

// --- An explicit user-selected mic is always honoured, even with the flag on. ---
assert.equal(
  chooseMicDeviceId(base({ explicitMicDeviceId: 'rapoo-hash' })).deviceId,
  'rapoo-hash',
  'explicit user choice wins'
)

// --- Flag off -> current behaviour (default input), regardless of the split. ---
assert.equal(chooseMicDeviceId(base({ enabled: false })).deviceId, '', 'disabled -> default input')

// --- No split (comms and console are the SAME endpoint, e.g. only the built-in
// mic) -> default input is already correct; do not force the alias. ---
assert.equal(
  chooseMicDeviceId(base({ snapshot: snapshot('same-dev', 'same-dev') })).deviceId,
  '',
  'no device split -> leave default'
)

// --- Split exists but the platform does not enumerate a `communications` input
// (non-Windows, or permission-gated list) -> fall back to default safely. ---
assert.equal(
  chooseMicDeviceId(base({ devices: [DEFAULT_INPUT, RAPOO] })).deviceId,
  '',
  'no communications alias -> safe fallback to default'
)

// --- No native snapshot at all -> cannot reason about roles -> default. ---
assert.equal(chooseMicDeviceId(base({ snapshot: null })).deviceId, '', 'no snapshot -> default')

// --- Comms endpoint missing (only console known) -> no split to act on. ---
assert.equal(
  chooseMicDeviceId(base({ snapshot: snapshot(null, 'console-rapoo') })).deviceId,
  '',
  'missing comms endpoint -> default'
)

console.log('verify-mic-device-choice: all assertions passed')
