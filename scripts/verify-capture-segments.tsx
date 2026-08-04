// IN-468 verification: segment timeline offset math (pause-aware) and the
// loopback-silent recording warning. Run via `npm run verify:capture`.
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CaptureController,
  SegmentTimeline,
  SilenceRecoveryGate
} from '../src/renderer/src/lib/capture'
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

// --- Silence recovery: one attempt per route generation plus cooldown ---

const recoveryGate = new SilenceRecoveryGate(30_000)
assert.equal(recoveryGate.tryAcquire(0, 0), true, 'the first silent stream gets one recovery')
assert.equal(
  recoveryGate.tryAcquire(0, 60_000),
  false,
  'the same route generation cannot loop recovery after the cooldown'
)
assert.equal(
  recoveryGate.tryAcquire(1, 20_000),
  false,
  'a new generation still respects the global recovery cooldown'
)
assert.equal(
  recoveryGate.tryAcquire(1, 30_000),
  true,
  'a new generation may recover after the cooldown'
)

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

class FakeTrack {
  kind = 'audio'
  id = crypto.randomUUID()
  readyState: MediaStreamTrackState = 'live'
  muted = false
  enabled = true
  onended: (() => void) | null = null
  onmute: (() => void) | null = null
  onunmute: (() => void) | null = null

  constructor(readonly label: string) {}

  clone(): FakeTrack {
    return new FakeTrack(this.label)
  }

  stop(): void {
    this.readyState = 'ended'
  }
}

class FakeStream {
  constructor(private readonly tracks: FakeTrack[]) {}

  getAudioTracks(): FakeTrack[] {
    return this.tracks
  }

  getTracks(): FakeTrack[] {
    return this.tracks
  }
}

class FakeRecorder {
  static isTypeSupported(): boolean {
    return true
  }

  state: RecordingState = 'inactive'
  mimeType = 'audio/webm'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null

  start(): void {
    this.state = 'recording'
    this.emitChunk()
  }

  requestData(): void {
    this.emitChunk()
  }

  pause(): void {
    this.state = 'paused'
  }

  resume(): void {
    this.state = 'recording'
  }

  stop(): void {
    this.state = 'inactive'
    this.onstop?.()
  }

  private emitChunk(): void {
    this.ondataavailable?.({ data: new Blob(['audio'], { type: this.mimeType }) })
  }
}

async function verifyNativeRenderChangeSegmentsLoopback(): Promise<void> {
  let endpointListener: ((snapshot: typeof snapshotA) => void) | null = null
  let endpointUnsubscribed = false

  class FakeDevices {
    private browserListeners = new Set<() => void>()
    displayCalls = 0

    getUserMedia(): Promise<FakeStream> {
      return Promise.resolve(new FakeStream([new FakeTrack('Laptop microphone')]))
    }

    getDisplayMedia(): Promise<FakeStream> {
      this.displayCalls += 1
      return Promise.resolve(
        new FakeStream([new FakeTrack(`System output ${this.displayCalls}`)])
      )
    }

    enumerateDevices(): Promise<MediaDeviceInfo[]> {
      return Promise.resolve([])
    }

    addEventListener(type: string, listener: () => void): void {
      if (type === 'devicechange') this.browserListeners.add(listener)
    }

    removeEventListener(type: string, listener: () => void): void {
      if (type === 'devicechange') this.browserListeners.delete(listener)
    }

    dispatchDeviceChange(): void {
      for (const listener of this.browserListeners) listener()
    }
  }

  const snapshotA = {
    schemaVersion: 1 as const,
    kind: 'snapshot' as const,
    generation: 1,
    endpoints: {
      captureConsole: null,
      captureCommunications: null,
      renderConsole: { id: 'render-a', label: 'Laptop speakers' },
      renderCommunications: { id: 'render-a', label: 'Laptop speakers' }
    }
  }
  const mediaDevices = new FakeDevices()
  Object.defineProperties(globalThis, {
    window: {
      configurable: true,
      value: {
        api: {
          debugLog: () => undefined,
          onAudioEndpointChanged: (listener: (snapshot: typeof snapshotA) => void) => {
            endpointListener = listener
            return () => {
              endpointUnsubscribed = true
              endpointListener = null
            }
          }
        }
      }
    },
    navigator: { configurable: true, value: { mediaDevices } },
    MediaStream: { configurable: true, value: FakeStream },
    MediaRecorder: { configurable: true, value: FakeRecorder },
    AudioContext: {
      configurable: true,
      value: class {
        constructor() {
          throw new Error('monitoring outside fixture')
        }
      }
    }
  })

  const controller = new CaptureController()
  await controller.start(
    'online',
    {
      mode: 'follow_communications',
      audioConstraints: true,
      requestedDeviceId: null,
      pinnedDeviceId: null,
      targetLabel: null,
      degradedReason: 'communications_endpoint_unavailable'
    },
    snapshotA
  )

  endpointListener?.({
    ...snapshotA,
    generation: 2,
    endpoints: {
      ...snapshotA.endpoints,
      renderConsole: { id: 'render-b', label: 'Bluetooth headphones' },
      renderCommunications: { id: 'render-c', label: 'Teams-only speakers' }
    }
  })
  mediaDevices.dispatchDeviceChange()
  await new Promise((resolve) => setTimeout(resolve, 1_700))

  assert.equal(
    mediaDevices.displayCalls,
    2,
    'native and browser render changes coalesce into one loopback replacement'
  )
  assert.equal(controller.getStatus().renderMismatch, true, 'render role mismatch is retained')

  const result = await controller.stop(2_000)
  assert.equal(result?.systemSegments?.length, 2, 'the native render change creates two segments')
  assert.equal(endpointUnsubscribed, true, 'render endpoint subscription is removed at stop')
}

void verifyNativeRenderChangeSegmentsLoopback()
  .then(() => console.log('Capture segment verification passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
