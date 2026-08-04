// IN-468 verification: segment timeline offset math (pause-aware) and the
// loopback-silent recording warning. Run via `npm run verify:capture`.
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { SegmentTimeline } from '../src/renderer/src/lib/capture'
import { RecordingScreen, type RecordingSession } from '../src/renderer/src/screens/RecordingScreen'

// --- SegmentTimeline: device-switch segments land at mic-aligned offsets ---

let fakeNow = 0
const timeline = new SegmentTimeline(() => fakeNow)

timeline.start()
assert.equal(timeline.currentOffsetMs(), 0, 'offset is 0 at capture start')

fakeNow = 5_000
assert.equal(timeline.currentOffsetMs(), 5_000, 'offset tracks elapsed time')

timeline.pause()
fakeNow = 7_000
assert.equal(timeline.currentOffsetMs(), 5_000, 'offset freezes while paused')

timeline.resume()
fakeNow = 10_000
assert.equal(timeline.currentOffsetMs(), 8_000, 'paused time is excluded from offsets')

timeline.pause()
fakeNow = 11_000
timeline.pause() // double-pause must not double-count
timeline.resume()
timeline.resume() // double-resume must not go negative
fakeNow = 12_000
assert.equal(timeline.currentOffsetMs(), 9_000, 'pause/resume is idempotent')

timeline.reset()
assert.equal(timeline.currentOffsetMs(), 0, 'reset returns to zero')

// --- RecordingScreen: silent loopback surfaces a visible warning ---

const session: RecordingSession = {
  meetingId: 'meeting-468',
  title: 'AI Lunch & Learn',
  source: 'online',
  startedAt: Date.now() - 10 * 60 * 1000,
  pausedAccum: 0,
  pausedAt: null,
  scheduledEndUtc: null
}

const silent = renderToStaticMarkup(
  <RecordingScreen
    session={session}
    captureStatus={{ mic: 'active', loopback: 'silent', recording: true }}
    onPause={() => undefined}
    onResume={() => undefined}
    onStop={() => undefined}
  />
)
assert.match(
  silent,
  /System audio has been silent/,
  'silent loopback shows an explicit warning'
)
assert.match(silent, /output device/, 'warning points at the output device')

const active = renderToStaticMarkup(
  <RecordingScreen
    session={session}
    captureStatus={{ mic: 'active', loopback: 'active', recording: true }}
    onPause={() => undefined}
    onResume={() => undefined}
    onStop={() => undefined}
  />
)
assert.doesNotMatch(active, /System audio has been silent/, 'no warning while loopback is live')

console.log('Capture segment verification passed')
