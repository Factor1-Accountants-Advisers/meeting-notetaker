/**
 * Meeting audio capture (decision #6):
 * - online meetings: system-audio loopback (via getDisplayMedia + the main
 *   process display-media handler) mixed with the microphone
 * - in-person meetings: microphone only
 *
 * Module-level singleton so a capture keeps running while the user navigates;
 * the recording screen only renders its status.
 */

import fixWebmDuration from 'fix-webm-duration'

export type StreamState = 'active' | 'error' | 'off'

export interface CaptureStatus {
  mic: StreamState
  loopback: StreamState
  /** False when neither stream could start — session is timer-only. */
  recording: boolean
}

const IDLE: CaptureStatus = { mic: 'off', loopback: 'off', recording: false }

class CaptureController {
  private ctx: AudioContext | null = null
  private recorder: MediaRecorder | null = null
  private chunks: BlobPart[] = []
  private streams: MediaStream[] = []
  private status: CaptureStatus = { ...IDLE }

  getStatus(): CaptureStatus {
    return this.status
  }

  async start(source: 'online' | 'in_person'): Promise<CaptureStatus> {
    this.releaseAll() // defensive: never two captures at once

    const status: CaptureStatus = { mic: 'off', loopback: 'off', recording: false }
    const ctx = new AudioContext()
    const mixed = ctx.createMediaStreamDestination()

    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
      this.streams.push(mic)
      ctx.createMediaStreamSource(mic).connect(mixed)
      status.mic = 'active'
    } catch {
      status.mic = 'error'
    }

    if (source === 'online') {
      try {
        // Main process answers with a screen source + WASAPI loopback audio.
        const sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        if (sys.getAudioTracks().length === 0) throw new Error('no loopback track')
        // Audio-first, but do NOT stop the video track: on Windows, stopping it
        // tears down the whole capture session and silences the loopback audio.
        // Disable it instead; it is stopped with everything else on release.
        sys.getVideoTracks().forEach((t) => {
          t.enabled = false
        })
        this.streams.push(sys)
        ctx.createMediaStreamSource(new MediaStream(sys.getAudioTracks())).connect(mixed)
        status.loopback = 'active'
      } catch {
        status.loopback = 'error'
      }
    }

    if (status.mic === 'active' || status.loopback === 'active') {
      const mime = ['audio/webm;codecs=opus', 'audio/webm'].find((m) =>
        MediaRecorder.isTypeSupported(m)
      )
      this.recorder = new MediaRecorder(mixed.stream, mime ? { mimeType: mime } : undefined)
      this.chunks = []
      this.recorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.chunks.push(e.data)
      }
      this.recorder.start(1000) // timeslice so long captures aren't one giant buffer
      this.ctx = ctx
      status.recording = true
    } else {
      void ctx.close()
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

  /** Stop and return the captured audio; null when nothing was recorded.
   *
   * MediaRecorder webm has no duration in its header (players show 0:00 until
   * they scan the file), so the measured duration is patched in before return.
   */
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
    void this.ctx?.close()
    this.ctx = null
    this.status = { ...IDLE }
  }
}

export const capture = new CaptureController()
