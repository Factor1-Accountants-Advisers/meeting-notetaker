import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import { SettingsScreen } from '../src/renderer/src/screens/SettingsScreen'
import {
  RecordingScreen,
  type RecordingSession
} from '../src/renderer/src/screens/RecordingScreen'

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: () => null,
    setItem: () => undefined
  }
})

const settings = renderToStaticMarkup(
  <SettingsScreen
    previewMode
    theme="system"
    onSetTheme={() => undefined}
    userName="Joseph"
    userEmail="joseph@example.com"
    isStorageAdmin={false}
    onOpenVoiceprintAdmin={() => undefined}
    onSignOut={() => undefined}
    onClose={() => undefined}
  />
)
assert.match(settings, /Follow Windows communications devices/, 'recommended follow mode is named')
assert.match(settings, /Recommended/, 'automatic communications routing is recommended')
assert.match(settings, /Always use this microphone/, 'manual pinning is explicit')
assert.match(settings, /Windows communications microphone/, 'the native microphone is visible')
assert.match(settings, /Windows communications output/, 'the native speaker is visible')
assert.match(settings, /Teams.*system default/i, 'Teams system-default guidance is visible')

const session: RecordingSession = {
  meetingId: 'meeting-routing',
  title: 'Bluetooth routing review',
  source: 'online',
  startedAt: Date.now() - 30_000,
  pausedAccum: 0,
  pausedAt: null,
  scheduledEndUtc: null
}

const active = renderToStaticMarkup(
  <RecordingScreen
    session={session}
    captureStatus={{
      mic: 'active',
      loopback: 'active',
      recording: true,
      micLevel: 0.02,
      loopbackLevel: 0.03,
      micLabel: 'Jabra Link 380 microphone',
      loopbackLabel: 'Jabra Link 380 headphones'
    }}
    onPause={() => undefined}
    onResume={() => undefined}
    onStop={() => undefined}
  />
)
assert.match(active, /Jabra Link 380 microphone/, 'the actual mic endpoint is named')
assert.match(active, /Jabra Link 380 headphones/, 'the active loopback endpoint is named')

const degraded = renderToStaticMarkup(
  <RecordingScreen
    session={session}
    captureStatus={{
      mic: 'silent',
      loopback: 'active',
      recording: true,
      micLevel: 0,
      loopbackLevel: 0.02,
      micLabel: 'Laptop microphone',
      loopbackLabel: 'Laptop speakers',
      micFallbackReason: 'pinned_device_missing',
      micRecoveryAttempted: true,
      renderMismatch: true
    }}
    onPause={() => undefined}
    onResume={() => undefined}
    onStop={() => undefined}
  />
)
assert.match(degraded, /selected microphone is unavailable/i, 'manual fallback is explicit')
assert.match(degraded, /still silent after recovery/i, 'post-recovery silence is explicit')
assert.match(degraded, /default output.*communications output/i, 'render mismatch is explicit')

const switching = renderToStaticMarkup(
  <RecordingScreen
    session={session}
    captureStatus={{
      mic: 'active',
      loopback: 'active',
      recording: true,
      micLevel: 0.01,
      loopbackLevel: 0.01,
      micLabel: 'Bluetooth microphone',
      loopbackLabel: 'Bluetooth headphones',
      micSwitching: true,
      loopbackSwitching: true
    }}
    onPause={() => undefined}
    onResume={() => undefined}
    onStop={() => undefined}
  />
)
assert.match(switching, /Switching microphone/, 'mic transitions are visible')
assert.match(switching, /Switching system audio/, 'loopback transitions are visible')

console.log('audio routing UI verification passed')
