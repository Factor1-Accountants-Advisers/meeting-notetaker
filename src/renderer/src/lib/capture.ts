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
 *   with AudioContext/createMediaStreamSource.
 * - MediaRecorder can collapse multiple audio tracks to one mono stream and, in
 *   practice, may only preserve the first track. To avoid losing system audio,
 *   online recordings use two MediaRecorders: one for mic and one for loopback.
 *   The backend merges the two blobs with ffmpeg before transcription.
 * - Keep display video tracks alive until cleanup; stopping/disabling them can
 *   tear down or mute the associated loopback audio on Windows.
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

export interface CaptureStatus {
  mic: StreamState
  loopback: StreamState
  recording: boolean
}

export interface CaptureResult {
  /** Microphone audio for online/in-person, or system audio if mic was unavailable. */
  blob: Blob
  /** Separate WASAPI/system-audio capture for online meetings. Backend merges this with blob. */
  systemBlob?: Blob
}

const IDLE: CaptureStatus = { mic: 'off', loopback: 'off', recording: false }

/** Session details persisted alongside the spill so an interrupted recording is recoverable (IN-129). */
export interface SpillSessionMeta {
  title: string
  meetingId: string | null
  graphMetadata?: unknown
}

class CaptureController {
  private micRecorder: MediaRecorder | null = null
  private systemRecorder: MediaRecorder | null = null
  private micChunks: BlobPart[] = []
  private systemChunks: BlobPart[] = []
  private streams: MediaStream[] = []
  private status: CaptureStatus = { ...IDLE }
  private monitorCtx: AudioContext | null = null
  private monitorTimer: ReturnType<typeof setInterval> | null = null
  private silentSeconds = 0
  private statusListener: ((status: CaptureStatus) => void) | null = null
  private spillKey: string | null = null
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
      this.startMicSilenceMonitor(mic)
    } catch {
      status.mic = 'error'
    }

    if (source === 'online') {
      try {
        const sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        const sysAudioTracks = sys.getAudioTracks()
        if (sysAudioTracks.length === 0) throw new Error('no loopback track')

        const track = sysAudioTracks[0]

        window.api.debugLog('loopback audio track acquired', {
          trackCount: sysAudioTracks.length,
          trackLabel: track.label ?? 'unknown',
          trackId: track.id,
          readyState: track.readyState,
          muted: track.muted,
          enabled: track.enabled,
          kind: track.kind
        })

        track.onended = () => {
          console.warn('loopback audio track ended unexpectedly')
          window.api.debugLog('loopback audio track ended', {
            trackLabel: track.label ?? 'unknown'
          })
        }
        track.onmute = () => {
          console.warn('loopback audio track muted')
          window.api.debugLog('loopback audio track muted', {
            trackLabel: track.label ?? 'unknown'
          })
        }
        track.onunmute = () => {
          window.api.debugLog('loopback audio track unmuted', {
            trackLabel: track.label ?? 'unknown'
          })
        }

        // Keep the original display stream alive, including its video track.
        this.streams.push(sys)
        this.systemRecorder = this.createRecorder(new MediaStream(sysAudioTracks), this.systemChunks, 'sys')
        this.systemRecorder.start(1000)
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
  }

  resume(): void {
    for (const recorder of [this.micRecorder, this.systemRecorder]) {
      if (recorder?.state === 'paused') recorder.resume()
    }
  }

  async stop(durationMs?: number): Promise<CaptureResult | null> {
    // Detach the spill from the live session: it must survive stop() until the
    // caller confirms the audio is safe (discardCompletedSpill), or be dropped
    // right away when there is no audio worth keeping.
    const spill = this.spillKey ? { key: this.spillKey, chains: this.spillChains } : null
    this.spillKey = null

    const micRecorder = this.micRecorder
    const systemRecorder = this.systemRecorder
    if ((!micRecorder || micRecorder.state === 'inactive') && (!systemRecorder || systemRecorder.state === 'inactive')) {
      this.releaseAll()
      if (spill) this.discardSpill(spill)
      return null
    }

    const [micBlob, systemBlob] = await Promise.all([
      this.stopRecorder(micRecorder, this.micChunks, durationMs),
      this.stopRecorder(systemRecorder, this.systemChunks, durationMs)
    ])
    this.releaseAll()

    const primaryBlob = micBlob ?? systemBlob
    if (!primaryBlob || primaryBlob.size === 0) {
      if (spill) this.discardSpill(spill)
      return null
    }
    this.completedSpill = spill
    const result: CaptureResult = { blob: primaryBlob }
    if (systemBlob && systemBlob.size > 0 && micBlob) result.systemBlob = systemBlob
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

  private startMicSilenceMonitor(mic: MediaStream): void {
    // The header warning about Web Audio applies to WASAPI/loopback streams;
    // observing the mic stream with an AnalyserNode is safe (the enrollment
    // recorder already does RMS analysis the same way). Best-effort: a monitor
    // failure must never break capture.
    try {
      const ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      ctx.createMediaStreamSource(mic).connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      this.monitorCtx = ctx
      this.silentSeconds = 0
      this.monitorTimer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples)
        let sum = 0
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
        const rms = Math.sqrt(sum / samples.length)
        if (rms < SILENCE_RMS) {
          this.silentSeconds += 1
          if (this.silentSeconds >= SILENCE_WARN_AFTER_S && this.status.mic === 'active') {
            this.status = { ...this.status, mic: 'silent' }
            window.api?.debugLog?.('mic capture appears silent', {
              silentSeconds: this.silentSeconds,
              rms
            })
            this.statusListener?.({ ...this.status })
          }
        } else {
          if (this.status.mic === 'silent') {
            this.status = { ...this.status, mic: 'active' }
            window.api?.debugLog?.('mic capture recovered', { rms })
            this.statusListener?.({ ...this.status })
          }
          this.silentSeconds = 0
        }
      }, 1000)
    } catch {
      // Monitoring is diagnostics only.
    }
  }

  private stopMicSilenceMonitor(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer)
      this.monitorTimer = null
    }
    this.monitorCtx?.close().catch(() => {})
    this.monitorCtx = null
    this.silentSeconds = 0
  }

  private releaseAll(): void {
    // Deliberately leaves any spill untouched: an abandoned session's spill
    // must survive to the next-launch recovery prompt, never be deleted here.
    this.stopMicSilenceMonitor()
    this.micRecorder = null
    this.systemRecorder = null
    this.micChunks = []
    this.systemChunks = []
    this.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
    this.streams = []
    this.status = { ...IDLE }
  }
}

export const capture = new CaptureController()
