/**
 * Meeting audio capture (decision #6):
 * - online meetings: system-audio loopback (via getDisplayMedia + the main
 *   process display-media handler) plus microphone
 * - in-person meetings: microphone only
 *
 * Module-level singleton so a capture keeps running while the user navigates;
 * the recording screen only renders its status.
 *
 * Important Electron/Chromium behaviour:
 * - Web Audio can silently drop WASAPI/display audio, so do not mix loopback
 *   with AudioContext/createMediaStreamSource. (The silence watchdog therefore
 *   analyses a CLONE of the loopback track, never the recorded track itself.)
 * - MediaRecorder can collapse multiple audio tracks to one mono stream and, in
 *   practice, may only preserve the first track. To avoid losing system audio,
 *   online recordings use two MediaRecorders: one for mic and one for loopback.
 *   The backend merges the two blobs with ffmpeg before transcription.
 * - Keep display video tracks alive until cleanup; stopping/disabling them can
 *   tear down or mute the associated loopback audio on Windows.
 * - WASAPI loopback stays attached to the output device that was default when
 *   capture started; if the default changes (Bluetooth headset connects,
 *   Teams switches devices) the old device goes idle and the capture records
 *   silence with no track event at all (IN-468). MediaRecorder cannot survive
 *   a track swap, so on devicechange we re-acquire getDisplayMedia and start a
 *   new recorder segment; the backend stitches segments at their offsets.
 * - The microphone has the same stuck-to-old-device problem (getUserMedia does
 *   not follow the OS default; crbug 40199570), but unlike loopback the mic
 *   may safely pass through Web Audio. The mic recorder therefore records a
 *   stable MediaStreamAudioDestinationNode stream and on devicechange the
 *   UPSTREAM source node is swapped to the new default input — the recorder
 *   never notices, so no segmenting or backend change is needed. If the
 *   AudioContext bridge cannot be built the mic falls back to the pre-fix
 *   direct recording (device switches then mean silence until re-record).
 */

import fixWebmDuration from 'fix-webm-duration'
import { resolveMicRoute, type MicRoute, type MicRouteDegradedReason } from './audioRouting'
import type { AudioEndpointSnapshot } from '../../../shared/audio-endpoints'

export type StreamState = 'active' | 'error' | 'off' | 'silent'

// A mic stream can deliver digital silence with no error at all (observed:
// Bluetooth hands-free / exclusive-mode contention while a Teams call holds
// the device). getUserMedia succeeds, MediaRecorder records, and the file is
// -90 dB throughout — so we watch the live RMS and flip the status instead.
// Backend twin: SILENT_MAX_VOLUME_DB in backend/app/services/audio_checks.py
// (whole-file peak, different unit) — tune the two together.
const SILENCE_RMS = 0.0005 // ≈ -66 dBFS; quiet rooms with a live mic sit well above this
const SILENCE_WARN_AFTER_S = 8
// System audio legitimately idles between utterances, so the loopback
// watchdog waits much longer before warning (IN-468: 34 min of silence went
// unnoticed; a live online meeting is never quiet for a full minute).
const LOOPBACK_SILENCE_WARN_AFTER_S = 60
// Bluetooth connects fire several devicechange events in a burst (A2DP/HFP
// re-profiling); coalesce before re-acquiring.
const DEVICE_CHANGE_DEBOUNCE_MS = 1500
// Chromium can leave either promise/event pending after a Windows audio-device
// transition. Neither is allowed to hold the recording controls indefinitely.
const LOOPBACK_REACQUIRE_TIMEOUT_MS = 10_000
const RECORDER_STOP_TIMEOUT_MS = 1_500
const SILENCE_RECOVERY_COOLDOWN_MS = 30_000

export interface CaptureStatus {
  mic: StreamState
  loopback: StreamState
  recording: boolean
  /** RMS level 0–1 for the mic stream, updated ~10x/sec. null when no monitor is running. */
  micLevel: number | null
  /** RMS level 0–1 for the system-audio loopback stream. null = no loopback or no monitor. */
  loopbackLevel: number | null
  /** Actual live microphone endpoint details from the acquired Chromium track. */
  micLabel?: string | null
  micDeviceId?: string | null
  micGroupId?: string | null
  micRoutingMode?: MicRoute['mode']
  micFallbackReason?: MicRouteDegradedReason | null
  micSwitching?: boolean
  /** Actual/default render label associated with the loopback stream. */
  loopbackLabel?: string | null
  loopbackSwitching?: boolean
  renderMismatch?: boolean
  micRecoveryAttempted?: boolean
  loopbackRecoveryAttempted?: boolean
}

export interface SystemSegment {
  blob: Blob
  /** Position on the recording timeline (pause-aware), for the backend merge. */
  offsetMs: number
}

export interface CaptureResult {
  /** Microphone audio for online/in-person, or system audio if mic was unavailable. */
  blob: Blob
  /** Separate WASAPI/system-audio capture for online meetings. Backend merges this with blob. */
  systemBlob?: Blob
  /**
   * All system-audio segments with timeline offsets (IN-468). One entry for an
   * uninterrupted capture; more when a device switch forced re-acquisition.
   */
  systemSegments?: SystemSegment[]
}

const IDLE: CaptureStatus = { mic: 'off', loopback: 'off', recording: false, micLevel: null, loopbackLevel: null }

const DEFAULT_MIC_ROUTE: MicRoute = {
  mode: 'follow_communications',
  audioConstraints: true,
  requestedDeviceId: null,
  pinnedDeviceId: null,
  targetLabel: null,
  degradedReason: 'native_snapshot_unavailable'
}

/** Session details persisted alongside the spill so an interrupted recording is recoverable (IN-129). */
export interface SpillSessionMeta {
  title: string
  meetingId: string | null
  graphMetadata?: unknown
}

/**
 * Pause-aware clock for placing re-acquired loopback segments on the
 * recording timeline (IN-468). Offsets must exclude paused time because the
 * recorded media stops advancing while MediaRecorders are paused.
 */
export class SegmentTimeline {
  private startMs: number | null = null
  private pausedAccumMs = 0
  private pausedAtMs: number | null = null

  constructor(private readonly now: () => number = () => performance.now()) {}

  start(): void {
    this.startMs = this.now()
    this.pausedAccumMs = 0
    this.pausedAtMs = null
  }

  pause(): void {
    if (this.startMs !== null && this.pausedAtMs === null) this.pausedAtMs = this.now()
  }

  resume(): void {
    if (this.pausedAtMs !== null) {
      this.pausedAccumMs += this.now() - this.pausedAtMs
      this.pausedAtMs = null
    }
  }

  currentOffsetMs(): number {
    if (this.startMs === null) return 0
    const pausedNow = this.pausedAtMs !== null ? this.now() - this.pausedAtMs : 0
    return Math.max(0, Math.round(this.now() - this.startMs - this.pausedAccumMs - pausedNow))
  }

  reset(): void {
    this.startMs = null
    this.pausedAccumMs = 0
    this.pausedAtMs = null
  }
}

/** Bounded one-shot gate shared by the mic and loopback silence watchdogs. */
export class SilenceRecoveryGate {
  private lastGeneration: number | null = null
  private lastAttemptMs = Number.NEGATIVE_INFINITY

  constructor(private readonly cooldownMs = SILENCE_RECOVERY_COOLDOWN_MS) {}

  tryAcquire(generation: number, nowMs = Date.now()): boolean {
    if (this.lastGeneration === generation) return false
    if (nowMs - this.lastAttemptMs < this.cooldownMs) return false
    this.lastGeneration = generation
    this.lastAttemptMs = nowMs
    return true
  }

  reset(): void {
    this.lastGeneration = null
    this.lastAttemptMs = Number.NEGATIVE_INFINITY
  }
}

export class CaptureController {
  private micRecorder: MediaRecorder | null = null
  private systemRecorder: MediaRecorder | null = null
  private micChunks: BlobPart[] = []
  private systemChunks: BlobPart[] = []
  private streams: MediaStream[] = []
  private status: CaptureStatus = { ...IDLE }
  private micMonitorStop: (() => void) | null = null
  private loopbackMonitorStop: (() => void) | null = null
  private statusListener: ((status: CaptureStatus) => void) | null = null
  /** Optional high-frequency listener for live audio levels (IN-128). */
  private levelListener: ((micLevel: number | null, loopbackLevel: number | null) => void) | null = null
  private spillKey: string | null = null
  // Segmented system capture (IN-468): earlier segments are finalized when a
  // device switch swaps the loopback stream; the current one lives in
  // systemRecorder/systemChunks until the next swap or stop().
  private finalizedSystemSegments: { offsetMs: number; blob: Promise<Blob | null> }[] = []
  private currentSystemOffsetMs = 0
  private currentSystemStream: MediaStream | null = null
  private systemTimeline = new SegmentTimeline()
  private deviceChangeTimer: ReturnType<typeof setTimeout> | null = null
  private deviceChangeRegistered = false
  private nativeEndpointUnsubscribe: (() => void) | null = null
  private pendingMicReacquire = false
  private pendingLoopbackReacquire = false
  private routingGeneration = 0
  private micSilenceRecovery = new SilenceRecoveryGate()
  private loopbackSilenceRecovery = new SilenceRecoveryGate()
  private reacquiring = false
  private reacquireGeneration = 0
  private cancelReacquire: (() => void) | null = null
  private stopping = false
  // Mic device-follow bridge (see header): the recorder consumes micDest's
  // stable stream; micSource is the swappable upstream getUserMedia node.
  private micContext: AudioContext | null = null
  private micDest: MediaStreamAudioDestinationNode | null = null
  private micSource: MediaStreamAudioSourceNode | null = null
  private currentMicStream: MediaStream | null = null
  private micRoute: MicRoute = { ...DEFAULT_MIC_ROUTE }
  private nativeSnapshot: AudioEndpointSnapshot | null = null
  private micReacquiring = false
  private micReacquireGeneration = 0
  // Chunks must reach the main process in emission order or the spilled WebM
  // stream corrupts; blob→ArrayBuffer conversion is async, so chain per stream.
  private spillChains: Record<'mic' | 'sys', Promise<void>> = {
    mic: Promise.resolve(),
    sys: Promise.resolve()
  }
  // Spill of the last completed stop(), kept until the caller confirms the
  // audio is safe (saved locally or uploaded) — the in-memory blob is not
  // durable, so discarding at stop() would reopen the IN-129 loss window.
  private completedSpill: { key: string; chains: Record<'mic' | 'sys', Promise<void>> } | null =
    null

  getStatus(): CaptureStatus {
    return this.status
  }

  /** Receive status updates that happen mid-capture (e.g. mic falls silent). */
  setStatusListener(listener: ((status: CaptureStatus) => void) | null): void {
    this.statusListener = listener
  }

  /** Receive live RMS levels ~10x/sec for the audio input meter (IN-128). */
  setLevelListener(
    listener: ((micLevel: number | null, loopbackLevel: number | null) => void) | null
  ): void {
    this.levelListener = listener
  }

  async start(
    source: 'online' | 'in_person',
    micRoute: MicRoute = { ...DEFAULT_MIC_ROUTE },
    nativeSnapshot: AudioEndpointSnapshot | null = null,
    spillMeta?: SpillSessionMeta
  ): Promise<CaptureStatus> {
    this.releaseAll()

    const status: CaptureStatus = { mic: 'off', loopback: 'off', recording: false, micLevel: null, loopbackLevel: null }
    this.micRoute = micRoute
    this.nativeSnapshot = nativeSnapshot
    this.routingGeneration = nativeSnapshot?.generation ?? 0
    this.openSpillSession(source, spillMeta)

    try {
      let acquiredRoute = micRoute
      let mic: MediaStream
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: micRoute.audioConstraints })
      } catch (error) {
        if (micRoute.audioConstraints === true) throw error
        acquiredRoute = {
          ...micRoute,
          audioConstraints: true,
          requestedDeviceId: null,
          degradedReason:
            micRoute.mode === 'pinned'
              ? 'pinned_device_missing'
              : 'communications_match_missing'
        }
        window.api?.debugLog?.('requested microphone unavailable at capture start — using default', {
          routingMode: micRoute.mode,
          message: error instanceof Error ? error.message : String(error)
        })
        mic = await navigator.mediaDevices.getUserMedia({ audio: true })
      }
      this.streams.push(mic)
      this.currentMicStream = mic
      this.micRoute = acquiredRoute
      // Bridge the mic through Web Audio so a later device switch swaps the
      // source without restarting the recorder (see header). Falls back to
      // direct recording when the bridge cannot be built.
      let recordStream = new MediaStream(mic.getAudioTracks())
      try {
        const ctx = new AudioContext()
        const dest = ctx.createMediaStreamDestination()
        const source = ctx.createMediaStreamSource(mic)
        source.connect(dest)
        this.micContext = ctx
        this.micDest = dest
        this.micSource = source
        recordStream = dest.stream
        this.registerDeviceChangeListener()
      } catch {
        window.api?.debugLog?.('mic device-follow bridge unavailable — recording mic directly')
      }
      this.micRecorder = this.createRecorder(recordStream, this.micChunks, 'mic')
      this.micRecorder.start(1000)
      status.mic = 'active'
      Object.assign(status, this.micStatusFor(mic.getAudioTracks()[0] ?? null, acquiredRoute))
      this.micMonitorStop = this.startSilenceMonitor(
        // Monitor the bridge output when present: it survives source swaps, so
        // silence/recovery and the level meter keep working after a switch.
        this.micDest ? this.micDest.stream : mic,
        SILENCE_WARN_AFTER_S,
        (rms, silentSeconds) => {
          if (this.status.mic !== 'active') return
          this.status = { ...this.status, mic: 'silent' }
          window.api?.debugLog?.('mic capture appears silent', { silentSeconds, rms })
          this.statusListener?.({ ...this.status })
          if (this.micSilenceRecovery.tryAcquire(this.routingGeneration)) {
            this.status = { ...this.status, micSwitching: true, micRecoveryAttempted: true }
            this.statusListener?.({ ...this.status })
            window.api?.debugLog?.('mic silence recovery requested', {
              routingGeneration: this.routingGeneration
            })
            void this.reacquireMic(true, 'silence recovery')
          }
        },
        (rms) => {
          if (this.status.mic !== 'silent') return
          this.status = { ...this.status, mic: 'active' }
          window.api?.debugLog?.('mic capture recovered', { rms })
          this.statusListener?.({ ...this.status })
        },
        (rms) => {
          this.status = { ...this.status, micLevel: rms }
          this.levelListener?.(rms, this.status.loopbackLevel)
        }
      )
    } catch {
      status.mic = 'error'
    }

    if (source === 'online') {
      try {
        const sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        if (sys.getAudioTracks().length === 0) throw new Error('no loopback track')
        this.systemTimeline.start()
        this.attachSystemStream(sys, 0)
        this.registerDeviceChangeListener()
        status.loopback = 'active'
        status.loopbackLabel = this.loopbackEndpointLabel(sys.getAudioTracks()[0] ?? null)
      } catch {
        status.loopback = 'error'
      }
    }

    status.recording = Boolean(this.micRecorder || this.systemRecorder)
    status.renderMismatch = this.hasRenderMismatch()
    this.status = status
    this.registerNativeEndpointListener()
    return status
  }

  pause(): void {
    for (const [stream, recorder] of [
      ['mic', this.micRecorder],
      ['sys', this.systemRecorder]
    ] as const) {
      if (recorder?.state !== 'recording') continue
      try {
        recorder.pause()
      } catch (err) {
        // A device swap can leave a recorder reporting "recording" while its
        // track is already unusable. Pause the rest of the session anyway.
        this.logRecorderControlFailure('pause', stream, err)
      }
    }
    this.systemTimeline.pause()
  }

  resume(): void {
    for (const [stream, recorder] of [
      ['mic', this.micRecorder],
      ['sys', this.systemRecorder]
    ] as const) {
      if (recorder?.state !== 'paused') continue
      try {
        recorder.resume()
      } catch (err) {
        this.logRecorderControlFailure('resume', stream, err)
      }
    }
    this.systemTimeline.resume()
  }

  async stop(durationMs?: number): Promise<CaptureResult | null> {
    // Stop owns the capture from this point. A pending getDisplayMedia must not
    // attach another recorder after we snapshot/finalize the live recorders.
    this.stopping = true
    this.unregisterDeviceChangeListener()
    this.unregisterNativeEndpointListener()
    if (this.deviceChangeTimer) {
      clearTimeout(this.deviceChangeTimer)
      this.deviceChangeTimer = null
    }
    this.cancelLoopbackReacquisition()
    this.cancelMicReacquisition()

    // Detach the spill from the live session: it must survive stop() until the
    // caller confirms the audio is safe (discardCompletedSpill), or be dropped
    // right away when there is no audio worth keeping.
    const spill = this.spillKey ? { key: this.spillKey, chains: this.spillChains } : null
    this.spillKey = null

    const micRecorder = this.micRecorder
    const systemRecorder = this.systemRecorder
    const finalized = this.finalizedSystemSegments
    const currentOffset = this.currentSystemOffsetMs
    const stopOffset = this.systemTimeline.currentOffsetMs()
    if (
      (!micRecorder || micRecorder.state === 'inactive') &&
      (!systemRecorder || systemRecorder.state === 'inactive') &&
      finalized.length === 0
    ) {
      this.releaseAll()
      if (spill) this.discardSpill(spill)
      return null
    }

    const [micBlob, currentSystemBlob] = await Promise.all([
      this.stopRecorder(micRecorder, this.micChunks, durationMs),
      this.stopRecorder(
        systemRecorder,
        this.systemChunks,
        finalized.length > 0 ? Math.max(0, stopOffset - currentOffset) : durationMs
      )
    ])
    const finalizedBlobs = await Promise.all(
      finalized.map(async (segment) => ({ offsetMs: segment.offsetMs, blob: await segment.blob }))
    )
    this.releaseAll()

    const segments: SystemSegment[] = [
      ...finalizedBlobs,
      { offsetMs: currentOffset, blob: currentSystemBlob }
    ]
      .filter((segment): segment is SystemSegment =>
        Boolean(segment.blob && segment.blob.size > 0)
      )
      .sort((a, b) => a.offsetMs - b.offsetMs)

    const primaryBlob = micBlob ?? segments[0]?.blob ?? null
    if (!primaryBlob || primaryBlob.size === 0) {
      if (spill) this.discardSpill(spill)
      return null
    }
    this.completedSpill = spill
    const result: CaptureResult = { blob: primaryBlob }
    if (micBlob) {
      if (segments.length > 0) {
        result.systemBlob = segments[0].blob
        result.systemSegments = segments
      }
    } else if (segments.length > 1) {
      // Mic was unavailable, so the first segment became the primary track;
      // the rest keep their absolute offsets for the backend merge.
      result.systemSegments = segments.slice(1)
    }
    return result
  }

  /**
   * Drop the spill of the last stop() once its audio is durable elsewhere
   * (saved locally or uploaded). If never called, the spill stays on disk and
   * is offered for recovery on the next launch — never silently lost.
   */
  discardCompletedSpill(): void {
    const spill = this.completedSpill
    this.completedSpill = null
    if (spill) this.discardSpill(spill)
  }

  /** Wire a freshly acquired display stream as the current system segment. */
  private attachSystemStream(sys: MediaStream, offsetMs: number, startPaused = false): void {
    const sysAudioTracks = sys.getAudioTracks()
    const track = sysAudioTracks[0]

    window.api?.debugLog?.('loopback audio track acquired', {
      trackCount: sysAudioTracks.length,
      trackLabel: track.label ?? 'unknown',
      trackId: track.id,
      readyState: track.readyState,
      muted: track.muted,
      enabled: track.enabled,
      kind: track.kind,
      offsetMs
    })

    track.onended = () => {
      console.warn('loopback audio track ended unexpectedly')
      window.api?.debugLog?.('loopback audio track ended', {
        trackLabel: track.label ?? 'unknown'
      })
    }
    track.onmute = () => {
      console.warn('loopback audio track muted')
      window.api?.debugLog?.('loopback audio track muted', {
        trackLabel: track.label ?? 'unknown'
      })
    }
    track.onunmute = () => {
      window.api?.debugLog?.('loopback audio track unmuted', {
        trackLabel: track.label ?? 'unknown'
      })
    }

    // Keep the original display stream alive, including its video track.
    this.streams.push(sys)
    this.currentSystemStream = sys
    this.currentSystemOffsetMs = offsetMs
    this.systemChunks = []
    this.systemRecorder = this.createRecorder(new MediaStream(sysAudioTracks), this.systemChunks, 'sys')
    this.systemRecorder.start(1000)
    if (startPaused) this.systemRecorder.pause()
    this.loopbackMonitorStop = this.startLoopbackSilenceMonitor(track)
  }

  private registerDeviceChangeListener(): void {
    if (this.deviceChangeRegistered) return
    try {
      navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange)
      this.deviceChangeRegistered = true
    } catch {
      // Older runtimes without the event still get the silence watchdog.
    }
  }

  private unregisterDeviceChangeListener(): void {
    if (!this.deviceChangeRegistered) return
    try {
      navigator.mediaDevices.removeEventListener('devicechange', this.onDeviceChange)
    } catch {
      // best-effort
    }
    this.deviceChangeRegistered = false
  }

  private registerNativeEndpointListener(): void {
    if (
      this.nativeEndpointUnsubscribe ||
      typeof window.api?.onAudioEndpointChanged !== 'function'
    ) {
      return
    }
    this.nativeEndpointUnsubscribe = window.api.onAudioEndpointChanged((snapshot) => {
      const previous = this.nativeSnapshot
      if (previous && snapshot.generation <= previous.generation) return
      this.nativeSnapshot = snapshot

      const captureChanged = !this.sameEndpoint(
        previous?.endpoints.captureCommunications ?? null,
        snapshot.endpoints.captureCommunications
      )
      const renderChanged =
        !this.sameEndpoint(
          previous?.endpoints.renderConsole ?? null,
          snapshot.endpoints.renderConsole
        ) ||
        !this.sameEndpoint(
          previous?.endpoints.renderCommunications ?? null,
          snapshot.endpoints.renderCommunications
        )

      this.status = {
        ...this.status,
        renderMismatch: this.hasRenderMismatch(snapshot),
        loopbackLabel:
          snapshot.endpoints.renderConsole?.label ?? this.status.loopbackLabel ?? null
      }
      this.statusListener?.({ ...this.status })
      if (captureChanged || renderChanged) {
        this.queueRouteRefresh(captureChanged, renderChanged, 'windows endpoint')
      }
    })
  }

  private unregisterNativeEndpointListener(): void {
    this.nativeEndpointUnsubscribe?.()
    this.nativeEndpointUnsubscribe = null
  }

  private sameEndpoint(
    left: { id: string; label: string } | null,
    right: { id: string; label: string } | null
  ): boolean {
    return (
      left === right ||
      (left !== null &&
        right !== null &&
        left.id === right.id &&
        left.label === right.label)
    )
  }

  private micStatusFor(
    track: MediaStreamTrack | null,
    route: MicRoute
  ): Pick<
    CaptureStatus,
    | 'micLabel'
    | 'micDeviceId'
    | 'micGroupId'
    | 'micRoutingMode'
    | 'micFallbackReason'
    | 'micSwitching'
  > {
    const settings = track?.getSettings?.() ?? {}
    return {
      micLabel: track?.label || route.targetLabel || null,
      micDeviceId: settings.deviceId || null,
      micGroupId: settings.groupId || null,
      micRoutingMode: route.mode,
      micFallbackReason: route.degradedReason,
      micSwitching: false
    }
  }

  private loopbackEndpointLabel(track: MediaStreamTrack | null): string | null {
    return (
      this.nativeSnapshot?.endpoints.renderConsole?.label ??
      track?.label ??
      null
    )
  }

  private hasRenderMismatch(snapshot = this.nativeSnapshot): boolean {
    const consoleEndpoint = snapshot?.endpoints.renderConsole
    const communicationsEndpoint = snapshot?.endpoints.renderCommunications
    return Boolean(
      consoleEndpoint &&
        communicationsEndpoint &&
        consoleEndpoint.id !== communicationsEndpoint.id
    )
  }

  private async resolveCurrentMicRoute(): Promise<MicRoute> {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return resolveMicRoute(
      {
        version: 2,
        micRoutingMode: this.micRoute.mode,
        pinnedMicDeviceId: this.micRoute.pinnedDeviceId ?? '',
        language: 'auto'
      },
      this.nativeSnapshot,
      devices
    )
  }

  private onDeviceChange = (): void => {
    if (this.stopping || (!this.systemRecorder && !this.micRecorder)) return
    this.queueRouteRefresh(Boolean(this.micRecorder), Boolean(this.systemRecorder), 'browser device')
  }

  private queueRouteRefresh(mic: boolean, loopback: boolean, reason: string): void {
    if (this.stopping || (!this.systemRecorder && !this.micRecorder)) return
    this.pendingMicReacquire ||= mic && Boolean(this.micRecorder && this.micDest)
    this.pendingLoopbackReacquire ||= loopback && Boolean(this.systemRecorder)
    if (this.deviceChangeTimer) clearTimeout(this.deviceChangeTimer)
    this.deviceChangeTimer = setTimeout(() => {
      this.deviceChangeTimer = null
      const refreshMic = this.pendingMicReacquire
      const refreshLoopback = this.pendingLoopbackReacquire
      this.pendingMicReacquire = false
      this.pendingLoopbackReacquire = false
      this.routingGeneration += 1
      if (refreshMic) this.status = { ...this.status, micRecoveryAttempted: false }
      if (refreshLoopback) this.status = { ...this.status, loopbackRecoveryAttempted: false }
      if (refreshLoopback && this.systemRecorder) {
        this.status = { ...this.status, loopbackSwitching: true }
        this.statusListener?.({ ...this.status })
        window.api?.debugLog?.('audio route change detected — re-acquiring loopback', {
          reason,
          routingGeneration: this.routingGeneration,
          offsetMs: this.systemTimeline.currentOffsetMs()
        })
        void this.reacquireLoopback()
      }
      if (refreshMic && this.micRecorder && this.micDest) {
        this.status = { ...this.status, micSwitching: true }
        this.statusListener?.({ ...this.status })
        void this.reacquireMic()
      }
    }, DEVICE_CHANGE_DEBOUNCE_MS)
  }

  /**
   * Follow the OS default microphone after a device change (e.g. a Bluetooth
   * headset connecting). Chromium does not re-route an open getUserMedia
   * stream, so acquire the new default and swap it in upstream of the Web
   * Audio bridge — the recorder keeps running untouched. A pinned device
   * (explicit Settings choice) is respected while it exists; if it drops off
   * the bus the capture falls back to the default input rather than going
   * silent. On any failure the existing capture is left running.
   */
  private async reacquireMic(forceReplace = false, reason = 'route change'): Promise<void> {
    if (this.micReacquiring || this.stopping || !this.micRecorder || !this.micContext || !this.micDest) {
      return
    }
    this.micReacquiring = true
    const generation = ++this.micReacquireGeneration
    try {
      const route = await this.resolveCurrentMicRoute()
      if (generation !== this.micReacquireGeneration || this.stopping) return
      const currentTrack = this.currentMicStream?.getAudioTracks()[0] ?? null
      const currentLive = currentTrack?.readyState === 'live'
      const currentSettings = currentLive ? (currentTrack?.getSettings?.() ?? {}) : {}

      // A live stream is only proof that the pin is satisfied when its actual
      // Chromium device ID matches. A live fallback must never block a pin
      // that disappeared at start and reappeared later.
      if (
        !forceReplace &&
        route.requestedDeviceId &&
        currentLive &&
        currentSettings.deviceId === route.requestedDeviceId
      ) {
        this.micRoute = route
        this.status = { ...this.status, ...this.micStatusFor(currentTrack, route) }
        this.statusListener?.({ ...this.status })
        return
      }

      const candidate = await this.acquireMicWithTimeout(generation, {
        audio: route.audioConstraints
      })
      if (
        generation !== this.micReacquireGeneration ||
        this.stopping ||
        !this.micRecorder ||
        !this.micContext ||
        !this.micDest
      ) {
        candidate.getTracks().forEach((track) => track.stop())
        return
      }
      const candidateTrack = candidate.getAudioTracks()[0]
      if (!candidateTrack) {
        candidate.getTracks().forEach((track) => track.stop())
        this.status = { ...this.status, micSwitching: false }
        this.statusListener?.({ ...this.status })
        return
      }

      // Same physical device and the current track still works → no churn.
      // groupId is compared first because Chromium's virtual "default" id can
      // stay literally "default" across a routing change; the group follows
      // the physical device.
      const candidateSettings = candidateTrack.getSettings?.() ?? {}
      const sameDevice =
        currentLive &&
        ((Boolean(candidateSettings.groupId) &&
          candidateSettings.groupId === currentSettings.groupId) ||
          (Boolean(candidateSettings.deviceId) &&
            candidateSettings.deviceId !== 'default' &&
            candidateSettings.deviceId === currentSettings.deviceId))
      if (sameDevice && !forceReplace) {
        candidate.getTracks().forEach((track) => track.stop())
        this.micRoute = route
        this.status = { ...this.status, ...this.micStatusFor(currentTrack, route) }
        this.statusListener?.({ ...this.status })
        return
      }

      const newSource = this.micContext.createMediaStreamSource(candidate)
      newSource.connect(this.micDest)
      try {
        this.micSource?.disconnect()
      } catch {
        // best-effort — the old source may already be dead
      }
      const oldStream = this.currentMicStream
      if (oldStream) {
        this.streams = this.streams.filter((s) => s !== oldStream)
        oldStream.getTracks().forEach((track) => track.stop())
      }
      this.streams.push(candidate)
      this.micSource = newSource
      this.currentMicStream = candidate
      this.micRoute = route
      window.api?.debugLog?.('mic re-acquired after device change', {
        trackLabel: candidateTrack.label ?? 'unknown',
        routingMode: route.mode,
        fallbackReason: route.degradedReason,
        reason
      })
      this.status = {
        ...this.status,
        // A fresh stream is not proof that a silent route recovered. The
        // stable analyser owns that transition and clears the warning only
        // after it observes real signal.
        mic: reason === 'silence recovery' ? this.status.mic : 'active',
        ...this.micStatusFor(candidateTrack, route)
      }
      this.statusListener?.({ ...this.status })
    } catch (err) {
      if (generation !== this.micReacquireGeneration || this.stopping) return
      window.api?.debugLog?.('mic re-acquisition failed — keeping existing capture', {
        message: err instanceof Error ? err.message : String(err)
      })
      this.status = { ...this.status, micSwitching: false }
      this.statusListener?.({ ...this.status })
    } finally {
      if (generation === this.micReacquireGeneration) {
        this.micReacquiring = false
      }
    }
  }

  private async acquireMicWithTimeout(
    generation: number,
    constraints: MediaStreamConstraints
  ): Promise<MediaStream> {
    let timedOut = false
    let timeout: ReturnType<typeof setTimeout> | null = null

    const acquisition = navigator.mediaDevices.getUserMedia(constraints)
    // getUserMedia is not abortable; release a late-resolving orphan stream.
    void acquisition
      .then((stream) => {
        if (timedOut || generation !== this.micReacquireGeneration || this.stopping) {
          stream.getTracks().forEach((track) => track.stop())
        }
      })
      .catch(() => {})

    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true
        reject(new Error('mic re-acquisition timed out'))
      }, LOOPBACK_REACQUIRE_TIMEOUT_MS)
    })

    try {
      return await Promise.race([acquisition, deadline])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  /**
   * Swap the loopback capture onto the current default output device (IN-468).
   * MediaRecorder cannot survive a track change, so the running segment is
   * finalized and a new recorder starts at the current timeline offset. On any
   * failure the old capture is left running — a failed swap must never make
   * things worse than the pre-fix behaviour.
   */
  private async reacquireLoopback(): Promise<void> {
    if (this.reacquiring || this.stopping || !this.systemRecorder) return
    this.reacquiring = true
    const generation = ++this.reacquireGeneration
    try {
      const sys = await this.acquireLoopbackWithTimeout(generation)
      if (generation !== this.reacquireGeneration || this.stopping || !this.systemRecorder) {
        sys.getTracks().forEach((track) => track.stop())
        return
      }
      if (sys.getAudioTracks().length === 0) {
        sys.getTracks().forEach((t) => t.stop())
        throw new Error('no loopback track')
      }

      const oldRecorder = this.systemRecorder
      const oldChunks = this.systemChunks
      const oldOffset = this.currentSystemOffsetMs
      const oldStream = this.currentSystemStream
      const wasPaused = oldRecorder.state === 'paused'
      const switchOffset = this.systemTimeline.currentOffsetMs()

      this.loopbackMonitorStop?.()
      this.loopbackMonitorStop = null

      const blob = this.stopRecorder(oldRecorder, oldChunks, Math.max(0, switchOffset - oldOffset))
      this.finalizedSystemSegments.push({ offsetMs: oldOffset, blob })
      if (oldStream) {
        this.streams = this.streams.filter((s) => s !== oldStream)
        // Stop the old display tracks only after the recorder has flushed.
        void blob.finally(() => oldStream.getTracks().forEach((t) => t.stop()))
      }

      this.attachSystemStream(sys, switchOffset, wasPaused)
      this.status = {
        ...this.status,
        loopback: 'active',
        loopbackLabel: this.loopbackEndpointLabel(sys.getAudioTracks()[0] ?? null),
        loopbackSwitching: false,
        renderMismatch: this.hasRenderMismatch()
      }
      this.statusListener?.({ ...this.status })
      window.api?.debugLog?.('loopback re-acquired after device change', {
        offsetMs: switchOffset,
        segments: this.finalizedSystemSegments.length + 1
      })
    } catch (err) {
      if (generation !== this.reacquireGeneration || this.stopping) return
      window.api?.debugLog?.('loopback re-acquisition failed — keeping existing capture', {
        message: err instanceof Error ? err.message : String(err)
      })
      this.status = { ...this.status, loopbackSwitching: false }
      this.statusListener?.({ ...this.status })
    } finally {
      // A cancelled older attempt must not clear the guard/canceller belonging
      // to a newer recording session.
      if (generation === this.reacquireGeneration) {
        this.reacquiring = false
        this.cancelReacquire = null
      }
    }
  }

  private async acquireLoopbackWithTimeout(generation: number): Promise<MediaStream> {
    let timedOut = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    let rejectCancelled: ((reason: Error) => void) | null = null
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancelled = reject
    })
    this.cancelReacquire = () =>
      rejectCancelled?.(new Error('loopback re-acquisition cancelled'))

    const acquisition = navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    // getDisplayMedia itself is not abortable. If it resolves after cancellation
    // or timeout, immediately release the orphan stream instead of attaching it.
    void acquisition
      .then((stream) => {
        if (timedOut || generation !== this.reacquireGeneration || this.stopping) {
          stream.getTracks().forEach((track) => track.stop())
        }
      })
      .catch(() => {})

    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true
        reject(new Error('loopback re-acquisition timed out'))
      }, LOOPBACK_REACQUIRE_TIMEOUT_MS)
    })

    try {
      return await Promise.race([acquisition, cancelled, deadline])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private createRecorder(
    stream: MediaStream,
    chunks: BlobPart[],
    spillStream: 'mic' | 'sys'
  ): MediaRecorder {
    const mime = ['audio/webm;codecs=opus', 'audio/webm'].find((m) =>
      MediaRecorder.isTypeSupported(m)
    )
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunks.push(e.data)
        this.spillChunk(spillStream, e.data)
      }
    }
    return recorder
  }

  /** Open a crash-safe spill session so an interrupted capture is recoverable (IN-129). */
  private openSpillSession(source: 'online' | 'in_person', meta?: SpillSessionMeta): void {
    if (typeof window.api?.spillOpen !== 'function') return
    const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.spillKey = key
    this.spillChains = { mic: Promise.resolve(), sys: Promise.resolve() }
    void window.api
      .spillOpen(key, {
        title: meta?.title ?? 'Recovered recording',
        meetingId: meta?.meetingId ?? null,
        source,
        mimeType: 'audio/webm',
        startedAtUtc: new Date().toISOString(),
        graphMetadata: meta?.graphMetadata
      })
      .catch(() => {
        // Spill is a safety net; capture must work without it.
        this.spillKey = null
      })
  }

  private spillChunk(stream: 'mic' | 'sys', data: Blob): void {
    const key = this.spillKey
    if (!key || typeof window.api?.spillChunk !== 'function') return
    this.spillChains[stream] = this.spillChains[stream]
      .then(async () => {
        if (this.spillKey !== key) return // session ended while queued
        await window.api.spillChunk(key, stream, await data.arrayBuffer())
      })
      .catch(() => {
        // Best-effort: a failed append must never break the live capture.
      })
  }

  private discardSpill(spill: { key: string; chains: Record<'mic' | 'sys', Promise<void>> }): void {
    if (typeof window.api?.spillDiscard !== 'function') return
    // Let queued appends settle first so the discard isn't resurrected by a late chunk.
    void Promise.allSettled([spill.chains.mic, spill.chains.sys]).then(() =>
      window.api.spillDiscard(spill.key).catch(() => {})
    )
  }

  private async stopRecorder(
    recorder: MediaRecorder | null,
    chunks: BlobPart[],
    durationMs?: number
  ): Promise<Blob | null> {
    if (!recorder) return null
    const toBlob = (): Blob => new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
    let blob = await new Promise<Blob>((resolve) => {
      let settled = false
      let timeout: ReturnType<typeof setTimeout> | null = null
      const finish = (timedOut = false): void => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        if (timedOut) {
          window.api?.debugLog?.('media recorder stop timed out — salvaging emitted chunks', {
            state: recorder.state,
            chunks: chunks.length
          })
        }
        resolve(toBlob())
      }

      recorder.onstop = () => finish()
      if (recorder.state === 'inactive') {
        finish()
        return
      }

      timeout = setTimeout(() => finish(true), RECORDER_STOP_TIMEOUT_MS)
      try {
        // Ask for the most recent buffered data before stop. Both calls are
        // best-effort because a device-swapped recorder may reject either one.
        recorder.requestData()
      } catch {
        // Existing timeslice chunks remain salvageable.
      }
      try {
        recorder.stop()
      } catch (err) {
        this.logRecorderControlFailure('stop', 'unknown', err)
        finish()
      }
    })
    if (blob.size === 0) return null
    if (durationMs && durationMs > 0) {
      try {
        blob = await fixWebmDuration(blob, durationMs, { logger: false })
      } catch {
        // Unpatched blob still plays; only the seek bar suffers.
      }
    }
    return blob
  }

  private logRecorderControlFailure(
    action: 'pause' | 'resume' | 'stop',
    stream: 'mic' | 'sys' | 'unknown',
    err: unknown
  ): void {
    window.api?.debugLog?.(`media recorder ${action} failed — continuing control transition`, {
      stream,
      message: err instanceof Error ? err.message : String(err)
    })
  }

  /**
   * RMS silence watchdog + audio level meter (IN-128). onSilent fires once
   * when the stream has been under the silence floor for warnAfterS
   * consecutive seconds; onRecovered fires once when signal returns.
   * onLevel fires ~10×/sec with the current RMS (smoothed) for a live
   * input meter. Returns a cleanup function (or null if monitoring fails).
   *
   * The mic stream is observed directly (safe — the enrollment recorder does
   * the same). Loopback streams must go through startLoopbackSilenceMonitor,
   * which observes a clone.
   */
  private startSilenceMonitor(
    stream: MediaStream,
    warnAfterS: number,
    onSilent: (rms: number, silentSeconds: number) => void,
    onRecovered: (rms: number) => void,
    onLevel?: (rms: number) => void
  ): (() => void) | null {
    try {
      const ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      ctx.createMediaStreamSource(stream).connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      let silentSeconds = 0
      let flagged = false
      // Fast level poll ~10×/sec for the audio meter (IN-128).
      let levelTimer: ReturnType<typeof setInterval> | null = null
      if (onLevel) {
        let smoothed = 0
        levelTimer = setInterval(() => {
          analyser.getFloatTimeDomainData(samples)
          let sum = 0
          for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
          const rms = Math.sqrt(sum / samples.length)
          // Exponential smoothing to avoid jitter in the meter bar.
          smoothed = smoothed * 0.7 + rms * 0.3
          onLevel(Math.min(smoothed, 1))
        }, 100)
      }
      const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples)
        let sum = 0
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
        const rms = Math.sqrt(sum / samples.length)
        if (rms < SILENCE_RMS) {
          silentSeconds += 1
          if (silentSeconds >= warnAfterS && !flagged) {
            flagged = true
            onSilent(rms, silentSeconds)
          }
        } else {
          if (flagged) {
            flagged = false
            onRecovered(rms)
          }
          silentSeconds = 0
        }
      }, 1000)
      return () => {
        clearInterval(timer)
        if (levelTimer) clearInterval(levelTimer)
        ctx.close().catch(() => {})
      }
    } catch {
      // Monitoring is diagnostics only.
      return null
    }
  }

  /**
   * Silence watchdog for the system-audio capture (IN-468). Analyses a CLONE
   * of the loopback track: the recorded track must never touch Web Audio (see
   * header), and stopping the clone on cleanup leaves the original untouched.
   */
  private startLoopbackSilenceMonitor(track: MediaStreamTrack): (() => void) | null {
    let clone: MediaStreamTrack
    try {
      clone = track.clone()
    } catch {
      return null
    }
    const stopMonitor = this.startSilenceMonitor(
      new MediaStream([clone]),
      LOOPBACK_SILENCE_WARN_AFTER_S,
      (rms, silentSeconds) => {
        if (this.status.loopback !== 'active') return
        this.status = { ...this.status, loopback: 'silent' }
        window.api?.debugLog?.('system audio capture appears silent', { silentSeconds, rms })
        this.statusListener?.({ ...this.status })
        if (this.loopbackSilenceRecovery.tryAcquire(this.routingGeneration)) {
          this.status = {
            ...this.status,
            loopbackSwitching: true,
            loopbackRecoveryAttempted: true
          }
          this.statusListener?.({ ...this.status })
          window.api?.debugLog?.('system audio silence recovery requested', {
            routingGeneration: this.routingGeneration
          })
          void this.reacquireLoopback()
        }
      },
      (rms) => {
        if (this.status.loopback !== 'silent') return
        this.status = { ...this.status, loopback: 'active' }
        window.api?.debugLog?.('system audio capture recovered', { rms })
        this.statusListener?.({ ...this.status })
      },
      (rms) => {
        this.status = { ...this.status, loopbackLevel: rms }
        this.levelListener?.(this.status.micLevel, rms)
      }
    )
    return () => {
      stopMonitor?.()
      try {
        clone.stop()
      } catch {
        // best-effort
      }
    }
  }

  private releaseAll(): void {
    // Deliberately leaves any spill untouched: an abandoned session's spill
    // must survive to the next-launch recovery prompt, never be deleted here.
    this.micMonitorStop?.()
    this.micMonitorStop = null
    this.loopbackMonitorStop?.()
    this.loopbackMonitorStop = null
    this.unregisterDeviceChangeListener()
    this.unregisterNativeEndpointListener()
    if (this.deviceChangeTimer) {
      clearTimeout(this.deviceChangeTimer)
      this.deviceChangeTimer = null
    }
    this.cancelLoopbackReacquisition()
    this.cancelMicReacquisition()
    try {
      this.micSource?.disconnect()
    } catch {
      // best-effort
    }
    this.micSource = null
    this.micDest = null
    if (this.micContext) {
      void this.micContext.close().catch(() => {})
      this.micContext = null
    }
    this.currentMicStream = null
    this.micRoute = { ...DEFAULT_MIC_ROUTE }
    this.nativeSnapshot = null
    this.pendingMicReacquire = false
    this.pendingLoopbackReacquire = false
    this.routingGeneration = 0
    this.micSilenceRecovery.reset()
    this.loopbackSilenceRecovery.reset()
    this.stopping = false
    this.micRecorder = null
    this.systemRecorder = null
    this.micChunks = []
    this.systemChunks = []
    this.finalizedSystemSegments = []
    this.currentSystemOffsetMs = 0
    this.currentSystemStream = null
    this.systemTimeline.reset()
    this.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
    this.streams = []
    this.status = { ...IDLE }
  }

  private cancelLoopbackReacquisition(): void {
    this.reacquireGeneration += 1
    const cancel = this.cancelReacquire
    this.cancelReacquire = null
    this.reacquiring = false
    cancel?.()
  }

  private cancelMicReacquisition(): void {
    this.micReacquireGeneration += 1
    this.micReacquiring = false
  }
}

export const capture = new CaptureController()
