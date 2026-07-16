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
 */

import fixWebmDuration from 'fix-webm-duration'

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

export interface CaptureStatus {
  mic: StreamState
  loopback: StreamState
  recording: boolean
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

const IDLE: CaptureStatus = { mic: 'off', loopback: 'off', recording: false }

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

class CaptureController {
  private micRecorder: MediaRecorder | null = null
  private systemRecorder: MediaRecorder | null = null
  private micChunks: BlobPart[] = []
  private systemChunks: BlobPart[] = []
  private streams: MediaStream[] = []
  private status: CaptureStatus = { ...IDLE }
  private micMonitorStop: (() => void) | null = null
  private loopbackMonitorStop: (() => void) | null = null
  private statusListener: ((status: CaptureStatus) => void) | null = null
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
  private reacquiring = false
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

  async start(
    source: 'online' | 'in_person',
    micDeviceId = '',
    spillMeta?: SpillSessionMeta
  ): Promise<CaptureStatus> {
    this.releaseAll()

    const status: CaptureStatus = { mic: 'off', loopback: 'off', recording: false }
    this.openSpillSession(source, spillMeta)

    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: micDeviceId ? { deviceId: { ideal: micDeviceId } } : true
      })
      this.streams.push(mic)
      this.micRecorder = this.createRecorder(new MediaStream(mic.getAudioTracks()), this.micChunks, 'mic')
      this.micRecorder.start(1000)
      status.mic = 'active'
      this.micMonitorStop = this.startSilenceMonitor(
        mic,
        SILENCE_WARN_AFTER_S,
        (rms, silentSeconds) => {
          if (this.status.mic !== 'active') return
          this.status = { ...this.status, mic: 'silent' }
          window.api?.debugLog?.('mic capture appears silent', { silentSeconds, rms })
          this.statusListener?.({ ...this.status })
        },
        (rms) => {
          if (this.status.mic !== 'silent') return
          this.status = { ...this.status, mic: 'active' }
          window.api?.debugLog?.('mic capture recovered', { rms })
          this.statusListener?.({ ...this.status })
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
      } catch {
        status.loopback = 'error'
      }
    }

    status.recording = Boolean(this.micRecorder || this.systemRecorder)
    this.status = status
    return status
  }

  pause(): void {
    for (const recorder of [this.micRecorder, this.systemRecorder]) {
      if (recorder?.state === 'recording') recorder.pause()
    }
    this.systemTimeline.pause()
  }

  resume(): void {
    for (const recorder of [this.micRecorder, this.systemRecorder]) {
      if (recorder?.state === 'paused') recorder.resume()
    }
    this.systemTimeline.resume()
  }

  async stop(durationMs?: number): Promise<CaptureResult | null> {
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

  private onDeviceChange = (): void => {
    if (!this.systemRecorder) return
    if (this.deviceChangeTimer) clearTimeout(this.deviceChangeTimer)
    this.deviceChangeTimer = setTimeout(() => {
      this.deviceChangeTimer = null
      window.api?.debugLog?.('audio device change detected — re-acquiring loopback', {
        offsetMs: this.systemTimeline.currentOffsetMs()
      })
      void this.reacquireLoopback()
    }, DEVICE_CHANGE_DEBOUNCE_MS)
  }

  /**
   * Swap the loopback capture onto the current default output device (IN-468).
   * MediaRecorder cannot survive a track change, so the running segment is
   * finalized and a new recorder starts at the current timeline offset. On any
   * failure the old capture is left running — a failed swap must never make
   * things worse than the pre-fix behaviour.
   */
  private async reacquireLoopback(): Promise<void> {
    if (this.reacquiring || !this.systemRecorder) return
    this.reacquiring = true
    try {
      const sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
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
      if (this.status.loopback !== 'active') {
        this.status = { ...this.status, loopback: 'active' }
        this.statusListener?.({ ...this.status })
      }
      window.api?.debugLog?.('loopback re-acquired after device change', {
        offsetMs: switchOffset,
        segments: this.finalizedSystemSegments.length + 1
      })
    } catch (err) {
      window.api?.debugLog?.('loopback re-acquisition failed — keeping existing capture', {
        message: err instanceof Error ? err.message : String(err)
      })
    } finally {
      this.reacquiring = false
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
    if (!recorder || recorder.state === 'inactive') return null
    let blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }))
      recorder.stop()
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

  /**
   * RMS silence watchdog. onSilent fires once when the stream has been under
   * the silence floor for warnAfterS consecutive seconds; onRecovered fires
   * once when signal returns. Best-effort: a monitor failure must never break
   * capture. Returns a cleanup function (or null if monitoring is impossible).
   *
   * The mic stream is observed directly (safe — the enrollment recorder does
   * the same). Loopback streams must go through startLoopbackSilenceMonitor,
   * which observes a clone.
   */
  private startSilenceMonitor(
    stream: MediaStream,
    warnAfterS: number,
    onSilent: (rms: number, silentSeconds: number) => void,
    onRecovered: (rms: number) => void
  ): (() => void) | null {
    try {
      const ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      ctx.createMediaStreamSource(stream).connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      let silentSeconds = 0
      let flagged = false
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
      },
      (rms) => {
        if (this.status.loopback !== 'silent') return
        this.status = { ...this.status, loopback: 'active' }
        window.api?.debugLog?.('system audio capture recovered', { rms })
        this.statusListener?.({ ...this.status })
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
    if (this.deviceChangeTimer) {
      clearTimeout(this.deviceChangeTimer)
      this.deviceChangeTimer = null
    }
    this.reacquiring = false
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
}

export const capture = new CaptureController()
