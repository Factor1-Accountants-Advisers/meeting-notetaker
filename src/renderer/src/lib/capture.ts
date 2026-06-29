/**
 * Meeting audio capture (decision #6):
 * - online meetings: system-audio loopback (via getDisplayMedia + the main
 *   process display-media handler) mixed with the microphone
 * - in-person meetings: microphone only
 *
 * Module-level singleton so a capture keeps running while the user navigates;
 * the recording screen only renders its status.
 *
 * NOTE: Web Audio API does NOT reliably capture system/display audio in
 * Electron/Chromium — createMediaStreamSource silently drops loopback tracks.
 * Instead, audio tracks from both sources are combined into one MediaStream
 * and fed directly to MediaRecorder, which handles multi-track mixing
 * natively.
 */

import fixWebmDuration from 'fix-webm-duration'

export type StreamState = 'active' | 'error' | 'off'

export interface CaptureStatus {
  mic: StreamState
  loopback: StreamState
  recording: boolean
}

const IDLE: CaptureStatus = { mic: 'off', loopback: 'off', recording: false }

class CaptureController {
  private recorder: MediaRecorder | null = null
  private chunks: BlobPart[] = []
  private streams: MediaStream[] = []
  private status: CaptureStatus = { ...IDLE }

  getStatus(): CaptureStatus {
    return this.status
  }

  async start(source: 'online' | 'in_person', micDeviceId = ''): Promise<CaptureStatus> {
    this.releaseAll()

    const status: CaptureStatus = { mic: 'off', loopback: 'off', recording: false }
    const audioTracks: MediaStreamTrack[] = []

    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: micDeviceId ? { deviceId: { ideal: micDeviceId } } : true
      })
      this.streams.push(mic)
      audioTracks.push(...mic.getAudioTracks())
      status.mic = 'active'
    } catch {
      status.mic = 'error'
    }

    if (source === 'online') {
      try {
        const sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        if (sys.getAudioTracks().length === 0) throw new Error('no loopback track')
        // Keep video track enabled. Disabling it can re-trigger the Chromium
        // bug where disabling a display-capture video track also silences its
        // associated audio track (Electron #49607). MediaRecorder ignores
        // video tracks — they are stopped with everything else on release.
        this.streams.push(sys)
        audioTracks.push(...sys.getAudioTracks())
        status.loopback = 'active'
        // WSL: loopback audio may exist but be silent — WASAPI can't bridge
        // host audio into WSL's virtualised sound stack. The packaged Windows
        // build captures real system audio natively.
        window.api.debugLog('loopback audio track acquired', {
          trackCount: sys.getAudioTracks().length,
          trackLabel: sys.getAudioTracks()[0]?.label ?? 'unknown'
        })
      } catch {
        status.loopback = 'error'
      }
    }

    if (audioTracks.length > 0) {
      const combinedStream = new MediaStream(audioTracks)
      this.streams.push(combinedStream)

      const mime = ['audio/webm;codecs=opus', 'audio/webm'].find((m) =>
        MediaRecorder.isTypeSupported(m)
      )
      this.recorder = new MediaRecorder(combinedStream, mime ? { mimeType: mime } : undefined)
      this.chunks = []
      this.recorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.chunks.push(e.data)
      }
      this.recorder.start(1000)
      status.recording = true
    }

    this.status = status
    return status
  }

  pause(): void {
    if (this.recorder?.state === 'recording') this.recorder.pause()
  }

  resume(): void {
    if (this.recorder?.state === 'paused') this.recorder.resume()
  }

  async stop(durationMs?: number): Promise<Blob | null> {
    const recorder = this.recorder
    if (!recorder || recorder.state === 'inactive') {
      this.releaseAll()
      return null
    }
    let blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () =>
        resolve(new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' }))
      recorder.stop()
    })
    this.releaseAll()
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
    this.recorder = null
    this.chunks = []
    this.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
    this.streams = []
    this.status = { ...IDLE }
  }
}

export const capture = new CaptureController()
