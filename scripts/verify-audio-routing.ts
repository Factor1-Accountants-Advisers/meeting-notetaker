import assert from 'node:assert/strict'

import { chooseAvailablePinnedMic, resolveMicRoute } from '../src/renderer/src/lib/audioRouting'
import { migratePrefs } from '../src/renderer/src/lib/prefs'
import type { AudioEndpointSnapshot } from '../src/shared/audio-endpoints'

const legacyDefault = migratePrefs({ micDeviceId: '', language: 'en-AU' })
assert.deepEqual(legacyDefault, {
  version: 2,
  micRoutingMode: 'follow_communications',
  pinnedMicDeviceId: '',
  language: 'en-AU'
})

const legacyPinned = migratePrefs({ micDeviceId: 'old-bluetooth-id', language: 'auto' })
assert.equal(legacyPinned.micRoutingMode, 'follow_communications')
assert.equal(
  legacyPinned.pinnedMicDeviceId,
  'old-bluetooth-id',
  'migration should retain the prior manual choice without keeping it active'
)

const pinnedPrefs = migratePrefs({
  version: 2,
  micRoutingMode: 'pinned',
  pinnedMicDeviceId: 'usb-id',
  language: 'auto'
})
assert.equal(pinnedPrefs.micRoutingMode, 'pinned')

const snapshot: AudioEndpointSnapshot = {
  schemaVersion: 1,
  kind: 'snapshot',
  generation: 4,
  endpoints: {
    captureConsole: { id: 'win-laptop', label: 'Laptop microphone' },
    captureCommunications: { id: 'win-headset', label: '  Jabra   Link 380  ' },
    renderConsole: { id: 'win-speakers', label: 'Laptop speakers' },
    renderCommunications: { id: 'win-headphones', label: 'Jabra Link 380' }
  }
}

const devices = [
  { kind: 'audioinput', deviceId: 'default', label: 'Default - Laptop microphone' },
  { kind: 'audioinput', deviceId: 'jabra-browser-id', label: 'jabra link 380' },
  { kind: 'audioinput', deviceId: 'usb-id', label: 'USB desk microphone' },
  { kind: 'audiooutput', deviceId: 'speaker-id', label: 'Jabra Link 380' }
] as MediaDeviceInfo[]

assert.equal(
  chooseAvailablePinnedMic('usb-id', devices.map((device) => device.deviceId)),
  'usb-id',
  'an available retained manual choice stays selected'
)
assert.equal(
  chooseAvailablePinnedMic('stale-id', devices.map((device) => device.deviceId)),
  'jabra-browser-id',
  'entering manual mode cannot display one device while retaining a stale ID'
)

const communicationsRoute = resolveMicRoute(legacyDefault, snapshot, devices)
assert.deepEqual(communicationsRoute.audioConstraints, {
  deviceId: { exact: 'jabra-browser-id' }
})
assert.equal(communicationsRoute.targetLabel, 'jabra link 380')
assert.equal(communicationsRoute.degradedReason, null)

const ambiguousRoute = resolveMicRoute(legacyDefault, snapshot, [
  ...devices,
  { kind: 'audioinput', deviceId: 'jabra-browser-id-2', label: 'JABRA LINK 380' } as MediaDeviceInfo
])
assert.equal(ambiguousRoute.audioConstraints, true)
assert.equal(ambiguousRoute.degradedReason, 'communications_match_ambiguous')

const missingNativeRoute = resolveMicRoute(legacyDefault, null, devices)
assert.equal(missingNativeRoute.audioConstraints, true)
assert.equal(missingNativeRoute.degradedReason, 'native_snapshot_unavailable')

const pinnedRoute = resolveMicRoute(pinnedPrefs, snapshot, devices)
assert.deepEqual(pinnedRoute.audioConstraints, { deviceId: { exact: 'usb-id' } })
assert.equal(pinnedRoute.targetLabel, 'USB desk microphone')
assert.equal(pinnedRoute.degradedReason, null)

const missingPinnedRoute = resolveMicRoute(
  { ...pinnedPrefs, pinnedMicDeviceId: 'missing-id' },
  snapshot,
  devices
)
assert.equal(missingPinnedRoute.audioConstraints, true)
assert.equal(missingPinnedRoute.degradedReason, 'pinned_device_missing')

console.log('audio routing verification passed')
