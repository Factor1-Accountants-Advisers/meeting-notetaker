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

export type StreamState = 'active' | 'error' | 'off'

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

class CaptureController {
  private micRecorder: MediaRecorder | null = null
  private systemRecorder: MediaRecorder | null = null
  private micChunks: BlobPart[] = []
  private systemChunks: BlobPart[] = []
  private streams: MediaStream[] = []
  private status: CaptureStatus = { ...IDLE }

  getStatus(): CaptureStatus {
    return this.status
  }

  async start(source: 'online' | 'in_person', micDeviceId = ''): Promise<CaptureStatus> {
    this.releaseAll()

    const status: CaptureStatus = { mic: 'off', loopback: 'off', recording: false }

    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: micDeviceId ? { deviceId: { ideal: micDeviceId } } : true
      })
      this.streams.push(mic)
      this.micRecorder = this.createRecorder(new MediaStream(mic.getAudioTracks()), this.micChunks)
      this.micRecorder.start(1000)
      status.mic = 'active'
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
        this.systemRecorder = this.createRecorder(new MediaStream(sysAudioTracks), this.systemChunks)
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
    const micRecorder = this.micRecorder
    const systemRecorder = this.systemRecorder
    if ((!micRecorder || micRecorder.state === 'inactive') && (!systemRecorder || systemRecorder.state === 'inactive')) {
      this.releaseAll()
      return null
    }

    const [micBlob, systemBlob] = await Promise.all([
      this.stopRecorder(micRecorder, this.micChunks, durationMs),
      this.stopRecorder(systemRecorder, this.systemChunks, durationMs)
    ])
    this.releaseAll()

    const primaryBlob = micBlob ?? systemBlob
    if (!primaryBlob || primaryBlob.size === 0) return null
    const result: CaptureResult = { blob: primaryBlob }
    if (systemBlob && systemBlob.size > 0 && micBlob) result.systemBlob = systemBlob
    return result
  }

  private createRecorder(stream: MediaStream, chunks: BlobPart[]): MediaRecorder {
    const mime = ['audio/webm;codecs=opus', 'audio/webm'].find((m) =>
      MediaRecorder.isTypeSupported(m)
    )
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    return recorder
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

  private releaseAll(): void {
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
