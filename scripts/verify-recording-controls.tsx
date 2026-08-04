import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { CaptureController } from '../src/renderer/src/lib/capture'
import { createSingleFlight } from '../src/renderer/src/lib/singleFlight'
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

function renderScheduled(endTimeMs: number): string {
  return renderToStaticMarkup(
    <RecordingScreen
      session={{ ...baseSession, scheduledEndUtc: new Date(endTimeMs).toISOString() }}
      captureStatus={{ mic: 'active', loopback: 'active', recording: true }}
      onPause={() => undefined}
      onResume={() => undefined}
      onStop={() => undefined}
      onExtend={() => undefined}
    />
  )
}

const scheduleNow = Date.now()
const scheduled = renderScheduled(scheduleNow + 10 * 60_000)
assert.match(scheduled, /Extend 10 min/, 'scheduled recordings retain Extend')
assert.match(scheduled, /Scheduled end/, 'scheduled recordings expose the exact scheduled end')
assert.match(scheduled, /10 min remaining/, 'scheduled recordings expose remaining time')
assert.match(scheduled, /aria-label="Stop recording"/, 'scheduled recordings share Stop')

const extended = renderScheduled(scheduleNow + 20 * 60_000)
assert.match(
  extended,
  /20 min remaining/,
  'an extended scheduled end immediately produces the new remaining time'
)
assert.notEqual(
  extended,
  scheduled,
  'an extended scheduled end produces updated recording-screen markup'
)

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

async function verifyMicFollowsDeviceChange(): Promise<void> {
  // 3 Aug field incident: after switching to a Bluetooth headset the mic kept
  // recording the old (now silent) device. The mic recorder must consume the
  // Web Audio bridge stream and swap its upstream source on devicechange
  // WITHOUT restarting the recorder.
  let micRecorders = 0
  let micSettings = { deviceId: 'device-a', groupId: 'group-a' }
  const logs: string[] = []

  class SettingsTrack extends FakeTrack {
    constructor(private readonly settings: { deviceId: string; groupId: string }) {
      super()
    }

    getSettings(): { deviceId: string; groupId: string } {
      return this.settings
    }
  }

  class MicFakeMediaDevices {
    private deviceChangeListeners = new Set<() => void>()
    micStreams: FakeMediaStream[] = []

    getUserMedia(): Promise<FakeMediaStream> {
      const stream = new FakeMediaStream([new SettingsTrack({ ...micSettings })])
      this.micStreams.push(stream)
      return Promise.resolve(stream)
    }

    getDisplayMedia(): Promise<FakeMediaStream> {
      return Promise.reject(new Error('mic-only fixture'))
    }

    enumerateDevices(): Promise<Array<{ kind: string; deviceId: string }>> {
      return Promise.resolve([])
    }

    addEventListener(type: string, listener: () => void): void {
      if (type === 'devicechange') this.deviceChangeListeners.add(listener)
    }

    removeEventListener(type: string, listener: () => void): void {
      if (type === 'devicechange') this.deviceChangeListeners.delete(listener)
    }

    dispatchDeviceChange(): void {
      for (const listener of this.deviceChangeListeners) listener()
    }
  }

  class BridgeAudioContext {
    createMediaStreamDestination(): { stream: FakeMediaStream } {
      return { stream: new FakeMediaStream([new FakeTrack()]) }
    }

    createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
      return { connect: () => undefined, disconnect: () => undefined }
    }

    close(): Promise<void> {
      return Promise.resolve()
    }
    // No createAnalyser: the silence monitor fails closed (returns null),
    // which is out of scope for this fixture.
  }

  class CountingMediaRecorder extends FakeMediaRecorder {
    constructor(stream: FakeMediaStream) {
      super(stream)
      micRecorders += 1
    }
  }

  const mediaDevices = new MicFakeMediaDevices()
  Object.defineProperties(globalThis, {
    window: {
      configurable: true,
      value: {
        api: {
          debugLog: (message: string) => {
            logs.push(message)
          }
        }
      }
    },
    navigator: { configurable: true, value: { mediaDevices } },
    MediaStream: { configurable: true, value: FakeMediaStream },
    MediaRecorder: { configurable: true, value: CountingMediaRecorder },
    AudioContext: { configurable: true, value: BridgeAudioContext }
  })

  const controller = new CaptureController()
  const status = await controller.start('in_person')
  assert.equal(status.mic, 'active', 'mic-only capture starts')
  assert.equal(micRecorders, 1, 'one mic recorder for the session')
  const originalStream = mediaDevices.micStreams[0]

  // Default input changes to a different physical device → swap expected.
  micSettings = { deviceId: 'device-b', groupId: 'group-b' }
  mediaDevices.dispatchDeviceChange()
  await new Promise((resolve) => setTimeout(resolve, 1_700))

  assert.equal(micRecorders, 1, 'device swap must NOT restart the mic recorder')
  assert.equal(mediaDevices.micStreams.length, 2, 'a new default mic stream was acquired')
  assert.ok(
    logs.includes('mic re-acquired after device change'),
    'swap is observable in the log'
  )
  assert.equal(
    originalStream.getAudioTracks()[0].readyState,
    'ended',
    'the old mic stream is released after the swap'
  )

  // Same device again → no churn: candidate acquired for comparison but no swap.
  const swapsBefore = logs.filter((m) => m === 'mic re-acquired after device change').length
  mediaDevices.dispatchDeviceChange()
  await new Promise((resolve) => setTimeout(resolve, 1_700))
  const swapsAfter = logs.filter((m) => m === 'mic re-acquired after device change').length
  assert.equal(swapsAfter, swapsBefore, 'an unchanged default device does not cause a swap')
  const comparisonStream = mediaDevices.micStreams[2]
  assert.equal(
    comparisonStream.getAudioTracks()[0].readyState,
    'ended',
    'the comparison-only candidate stream is released'
  )

  // A silence-triggered replacement has not proven recovery yet. Keep the
  // warning visible until the stable analyser actually observes signal.
  Object.assign((controller as unknown as { status: { mic: string } }).status, {
    mic: 'silent'
  })
  await (
    controller as unknown as {
      reacquireMic: (forceReplace: boolean, reason: string) => Promise<void>
    }
  ).reacquireMic(true, 'silence recovery')
  assert.equal(
    controller.getStatus().mic,
    'silent',
    'silence recovery keeps the warning until the analyser observes real signal'
  )

  const result = await controller.stop(1_000)
  assert.ok(result?.blob.size, 'mic audio survives to stop after a device swap')
}

async function verifyPinnedMicReappears(): Promise<void> {
  let pinnedPresent = false
  let micRecorders = 0
  const calls: MediaStreamConstraints[] = []

  class RoutedTrack extends FakeTrack {
    constructor(
      label: string,
      private readonly settings: { deviceId: string; groupId: string }
    ) {
      super()
      this.label = label
    }

    getSettings(): { deviceId: string; groupId: string } {
      return this.settings
    }
  }

  class RoutedMediaDevices {
    private deviceChangeListeners = new Set<() => void>()
    readonly streams: FakeMediaStream[] = []

    getUserMedia(constraints: MediaStreamConstraints): Promise<FakeMediaStream> {
      calls.push(constraints)
      const requested = (constraints.audio as MediaTrackConstraints | undefined)?.deviceId
      const exact = typeof requested === 'object' && 'exact' in requested ? requested.exact : null
      const usePinned = exact === 'pinned-id' && pinnedPresent
      const stream = new FakeMediaStream([
        new RoutedTrack(usePinned ? 'Bluetooth microphone' : 'Laptop microphone', {
          deviceId: usePinned ? 'pinned-id' : 'fallback-id',
          groupId: usePinned ? 'pinned-group' : 'fallback-group'
        })
      ])
      this.streams.push(stream)
      return Promise.resolve(stream)
    }

    getDisplayMedia(): Promise<FakeMediaStream> {
      return Promise.reject(new Error('mic-only fixture'))
    }

    enumerateDevices(): Promise<MediaDeviceInfo[]> {
      return Promise.resolve(
        pinnedPresent
          ? ([
              {
                kind: 'audioinput',
                deviceId: 'pinned-id',
                groupId: 'pinned-group',
                label: 'Bluetooth microphone'
              }
            ] as MediaDeviceInfo[])
          : []
      )
    }

    addEventListener(type: string, listener: () => void): void {
      if (type === 'devicechange') this.deviceChangeListeners.add(listener)
    }

    removeEventListener(type: string, listener: () => void): void {
      if (type === 'devicechange') this.deviceChangeListeners.delete(listener)
    }

    dispatchDeviceChange(): void {
      for (const listener of this.deviceChangeListeners) listener()
    }
  }

  class BridgeAudioContext {
    createMediaStreamDestination(): { stream: FakeMediaStream } {
      return { stream: new FakeMediaStream([new FakeTrack()]) }
    }

    createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
      return { connect: () => undefined, disconnect: () => undefined }
    }

    close(): Promise<void> {
      return Promise.resolve()
    }
  }

  class CountingMediaRecorder extends FakeMediaRecorder {
    constructor(stream: FakeMediaStream) {
      super(stream)
      micRecorders += 1
    }
  }

  const mediaDevices = new RoutedMediaDevices()
  Object.defineProperties(globalThis, {
    window: {
      configurable: true,
      value: { api: { debugLog: () => undefined } }
    },
    navigator: { configurable: true, value: { mediaDevices } },
    MediaStream: { configurable: true, value: FakeMediaStream },
    MediaRecorder: { configurable: true, value: CountingMediaRecorder },
    AudioContext: { configurable: true, value: BridgeAudioContext }
  })

  const controller = new CaptureController()
  const route = {
    mode: 'pinned' as const,
    audioConstraints: true as const,
    requestedDeviceId: null,
    pinnedDeviceId: 'pinned-id',
    targetLabel: 'Bluetooth microphone',
    degradedReason: 'pinned_device_missing' as const
  }
  const status = await controller.start('in_person', route, null)
  assert.equal(status.mic, 'active', 'fallback mic starts while the pin is absent')
  const fallbackStream = mediaDevices.streams[0]

  pinnedPresent = true
  mediaDevices.dispatchDeviceChange()
  await new Promise((resolve) => setTimeout(resolve, 1_700))

  assert.deepEqual(
    calls.at(-1),
    { audio: { deviceId: { exact: 'pinned-id' } } },
    'the reappearing pin is requested exactly instead of keeping the live fallback'
  )
  assert.equal(micRecorders, 1, 'the stable mic recorder is not restarted')
  assert.equal(
    fallbackStream.getAudioTracks()[0].readyState,
    'ended',
    'the fallback stream is released after the pin returns'
  )
  await controller.stop(1_000)
}

async function verifyNativeCommunicationsMicChange(): Promise<void> {
  let activeDevice = { id: 'mic-a', groupId: 'group-a', label: 'Laptop microphone' }
  let nativeListener: ((snapshot: unknown) => void) | null = null
  let unsubscribed = false
  let micRecorders = 0
  const calls: MediaStreamConstraints[] = []

  class NativeTrack extends FakeTrack {
    constructor(private readonly device: typeof activeDevice) {
      super()
      this.label = device.label
    }

    getSettings(): { deviceId: string; groupId: string } {
      return { deviceId: this.device.id, groupId: this.device.groupId }
    }
  }

  class NativeMediaDevices {
    private listeners = new Set<() => void>()

    getUserMedia(constraints: MediaStreamConstraints): Promise<FakeMediaStream> {
      calls.push(constraints)
      return Promise.resolve(new FakeMediaStream([new NativeTrack({ ...activeDevice })]))
    }

    getDisplayMedia(): Promise<FakeMediaStream> {
      return Promise.reject(new Error('mic-only fixture'))
    }

    enumerateDevices(): Promise<MediaDeviceInfo[]> {
      return Promise.resolve([
        {
          kind: 'audioinput',
          deviceId: activeDevice.id,
          groupId: activeDevice.groupId,
          label: activeDevice.label
        } as MediaDeviceInfo
      ])
    }

    addEventListener(type: string, listener: () => void): void {
      if (type === 'devicechange') this.listeners.add(listener)
    }

    removeEventListener(type: string, listener: () => void): void {
      if (type === 'devicechange') this.listeners.delete(listener)
    }

    dispatchDeviceChange(): void {
      for (const listener of this.listeners) listener()
    }
  }

  class BridgeAudioContext {
    createMediaStreamDestination(): { stream: FakeMediaStream } {
      return { stream: new FakeMediaStream([new FakeTrack()]) }
    }

    createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
      return { connect: () => undefined, disconnect: () => undefined }
    }

    close(): Promise<void> {
      return Promise.resolve()
    }
  }

  class CountingMediaRecorder extends FakeMediaRecorder {
    constructor(stream: FakeMediaStream) {
      super(stream)
      micRecorders += 1
    }
  }

  const mediaDevices = new NativeMediaDevices()
  Object.defineProperties(globalThis, {
    window: {
      configurable: true,
      value: {
        api: {
          debugLog: () => undefined,
          onAudioEndpointChanged: (listener: (snapshot: unknown) => void) => {
            nativeListener = listener
            return () => {
              unsubscribed = true
              nativeListener = null
            }
          }
        }
      }
    },
    navigator: { configurable: true, value: { mediaDevices } },
    MediaStream: { configurable: true, value: FakeMediaStream },
    MediaRecorder: { configurable: true, value: CountingMediaRecorder },
    AudioContext: { configurable: true, value: BridgeAudioContext }
  })

  const snapshotA = {
    schemaVersion: 1 as const,
    kind: 'snapshot' as const,
    generation: 1,
    endpoints: {
      captureConsole: { id: 'win-a', label: 'Laptop microphone' },
      captureCommunications: { id: 'win-a', label: 'Laptop microphone' },
      renderConsole: null,
      renderCommunications: null
    }
  }
  const controller = new CaptureController()
  await controller.start(
    'in_person',
    {
      mode: 'follow_communications',
      audioConstraints: { deviceId: { exact: 'mic-a' } },
      requestedDeviceId: 'mic-a',
      pinnedDeviceId: null,
      targetLabel: 'Laptop microphone',
      degradedReason: null
    },
    snapshotA
  )
  assert.ok(nativeListener, 'capture subscribes to native endpoint updates')

  activeDevice = { id: 'mic-b', groupId: 'group-b', label: 'Bluetooth microphone' }
  nativeListener?.({
    ...snapshotA,
    generation: 2,
    endpoints: {
      ...snapshotA.endpoints,
      captureCommunications: { id: 'win-b', label: 'Bluetooth microphone' }
    }
  })
  mediaDevices.dispatchDeviceChange()
  await new Promise((resolve) => setTimeout(resolve, 1_700))

  assert.deepEqual(calls.at(-1), {
    audio: { deviceId: { exact: 'mic-b' } }
  })
  assert.equal(calls.length, 2, 'native and browser signals coalesce into one acquisition')
  assert.equal(micRecorders, 1, 'native route changes keep the mic recorder stable')

  await controller.stop(1_000)
  assert.equal(unsubscribed, true, 'native endpoint subscription is removed at stop')
}

async function verifySequentialStops(): Promise<void> {
  // Field regression (3 Aug): the App effect's manual `stopping` flag was only
  // reset on failure, so after one successful stop every later stop request
  // (auto-stop, tray, on-screen button) was silently swallowed for the rest of
  // the session. The single-flight wrapper must re-arm after completion.
  let runs = 0
  let ignored = 0
  let release: (() => void) | null = null
  const flight = createSingleFlight(
    () =>
      new Promise<void>((resolve) => {
        runs += 1
        release = resolve
      }),
    () => {
      ignored += 1
    }
  )

  const first = flight.invoke()
  assert.equal(runs, 1, 'first stop request runs')
  assert.equal(flight.isRunning(), true, 'stop reports in-flight while pending')

  void flight.invoke()
  assert.equal(runs, 1, 'concurrent stop request is coalesced')
  assert.equal(ignored, 1, 'coalesced stop request is observable (logged)')

  release!()
  await first
  assert.equal(flight.isRunning(), false, 'flight re-arms after success')

  void flight.invoke()
  assert.equal(runs, 2, 'stop works again for the NEXT recording after a successful stop')
  release!()

  // Failure must also re-arm.
  let failures = 0
  const failing = createSingleFlight(async () => {
    failures += 1
    throw new Error('boom')
  })
  await failing.invoke().catch(() => undefined)
  assert.equal(failing.isRunning(), false, 'flight re-arms after failure')
  await failing.invoke().catch(() => undefined)
  assert.equal(failures, 2, 'stop can be retried after a failed stop')
}

void verifyDeviceChangeStop()
  .then(() => verifyMicFollowsDeviceChange())
  .then(() => verifyPinnedMicReappears())
  .then(() => verifyNativeCommunicationsMicChange())
  .then(() => verifySequentialStops())
  .then(() => console.log('Recording control verification passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
