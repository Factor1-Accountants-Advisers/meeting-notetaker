import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { RecordingScreen, type RecordingSession } from '../src/renderer/src/screens/RecordingScreen'

const startedAt = Date.now() - 75 * 60 * 1000
const baseSession: RecordingSession = {
  meetingId: 'meeting-131',
  title: 'Firmwide catchup',
  source: 'online',
  startedAt,
  pausedAccum: 0,
  pausedAt: null,
  scheduledEndUtc: null
}

function render(session: RecordingSession, saving = false): string {
  return renderToStaticMarkup(
    <RecordingScreen
      session={session}
      captureStatus={{ mic: 'active', loopback: 'active', recording: true }}
      onPause={() => undefined}
      onResume={() => undefined}
      onStop={() => undefined}
      saving={saving}
    />
  )
}

const active = render(baseSession)
assert.match(active, /aria-label="Pause recording"/, 'active recordings expose Pause')
assert.match(active, /aria-label="Stop recording"/, 'active recordings expose Stop')
assert.doesNotMatch(active, /aria-label="Resume recording"/, 'active recordings do not expose Resume')

const paused = render({ ...baseSession, pausedAt: Date.now() - 30_000 })
assert.match(paused, /aria-label="Resume recording"/, 'paused recordings expose Resume')
assert.match(paused, /aria-label="Stop recording"/, 'paused recordings expose Stop')
assert.doesNotMatch(paused, /aria-label="Pause recording"/, 'paused recordings do not expose Pause')

const saving = render(baseSession, true)
assert.match(saving, /Saving and uploading your recording/, 'saving state is explicit')
assert.doesNotMatch(saving, /aria-label="Stop recording"/, 'saving state prevents duplicate Stop')

const scheduled = renderToStaticMarkup(
  <RecordingScreen
    session={{ ...baseSession, scheduledEndUtc: new Date(Date.now() + 600_000).toISOString() }}
    captureStatus={{ mic: 'active', loopback: 'active', recording: true }}
    onPause={() => undefined}
    onResume={() => undefined}
    onStop={() => undefined}
    onExtend={() => undefined}
  />
)
assert.match(scheduled, /Extend 10 min/, 'scheduled recordings retain Extend')
assert.match(scheduled, /aria-label="Stop recording"/, 'scheduled recordings share Stop')

console.log('Recording control verification passed')
