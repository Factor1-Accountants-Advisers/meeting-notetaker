import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { CaptureController } from '../src/renderer/src/lib/capture'
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

class FakeTrack {
  kind = 'audio'
  id = crypto.randomUUID()
  label = 'Fake audio'
  readyState: MediaStreamTrackState = 'live'
  muted = false
  enabled = true
  onended: (() => void) | null = null
  onmute: (() => void) | null = null
  onunmute: (() => void) | null = null

  clone(): FakeTrack {
    return new FakeTrack()
  }

  stop(): void {
    this.readyState = 'ended'
  }

  endUnexpectedly(): void {
    this.readyState = 'ended'
    this.onended?.()
  }
}

class FakeMediaStream {
  constructor(private readonly tracks: FakeTrack[] = []) {}

  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === 'audio')
  }

  getTracks(): FakeTrack[] {
    return this.tracks
  }
}

class FakeMediaRecorder {
  static isTypeSupported(): boolean {
    return true
  }

  state: RecordingState = 'inactive'
  mimeType = 'audio/webm'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null

  constructor(private readonly stream: FakeMediaStream) {}

  start(): void {
    this.state = 'recording'
    this.ondataavailable?.({ data: new Blob(['captured-audio'], { type: this.mimeType }) })
  }

  pause(): void {
    if (this.stream.getAudioTracks().some((track) => track.readyState === 'ended')) {
      throw new DOMException('Recorder track ended', 'InvalidStateError')
    }
    this.state = 'paused'
  }

  resume(): void {
    this.state = 'recording'
  }

  stop(): void {
    // Reproduces Chromium's observed post-device-swap failure: the recorder
    // still says "recording", but neither throws nor emits stop.
    if (this.stream.getAudioTracks().some((track) => track.readyState === 'ended')) return
    this.state = 'inactive'
    this.onstop?.()
  }
}

class FakeMediaDevices {
  private deviceChangeListeners = new Set<() => void>()
  readonly loopbackTrack = new FakeTrack()
  private displayCalls = 0

  getUserMedia(): Promise<FakeMediaStream> {
    return Promise.resolve(new FakeMediaStream([new FakeTrack()]))
  }

  getDisplayMedia(): Promise<FakeMediaStream> {
    this.displayCalls += 1
    if (this.displayCalls === 1) {
      return Promise.resolve(new FakeMediaStream([this.loopbackTrack]))
    }
    // A device-change reacquisition can remain unresolved inside Chromium.
    return new Promise(() => undefined)
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === 'devicechange') this.deviceChangeListeners.add(listener)
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === 'devicechange') this.deviceChangeListeners.delete(listener)
  }

  dispatchDeviceChangeBurst(): void {
    for (const listener of this.deviceChangeListeners) {
      listener()
      listener()
      listener()
    }
  }
}

async function verifyDeviceChangeStop(): Promise<void> {
  const mediaDevices = new FakeMediaDevices()
  Object.defineProperties(globalThis, {
    window: {
      configurable: true,
      value: { api: { debugLog: () => undefined } }
    },
    navigator: {
      configurable: true,
      value: { mediaDevices }
    },
    MediaStream: {
      configurable: true,
      value: FakeMediaStream
    },
    MediaRecorder: {
      configurable: true,
      value: FakeMediaRecorder
    },
    AudioContext: {
      configurable: true,
      value: class {
        constructor() {
          throw new Error('Audio monitoring is outside this fixture')
        }
      }
    }
  })

  const controller = new CaptureController()
  const status = await controller.start('online')
  assert.equal(status.recording, true, 'fixture starts an online recording')

  mediaDevices.loopbackTrack.endUnexpectedly()
  mediaDevices.dispatchDeviceChangeBurst()
  await new Promise((resolve) => setTimeout(resolve, 1_600))

  assert.doesNotThrow(
    () => controller.pause(),
    'Pause advances even when the stale loopback recorder rejects the transition'
  )
  assert.doesNotThrow(() => controller.resume(), 'Resume remains available after the partial pause')

  const result = await Promise.race([
    controller.stop(1_600),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Stop hung behind device-change reacquisition')), 2_000)
    )
  ])
  assert.ok(result?.blob.size, 'Stop salvages the mic audio captured before the device change')
}

void verifyDeviceChangeStop()
  .then(() => console.log('Recording control verification passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
