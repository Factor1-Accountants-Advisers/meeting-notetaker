/** Microphone clip recorder used by voiceprint enrollment. */

export interface ClipRecorder {
  stop: () => Promise<Blob>
  cancel: () => void
}

export async function startClipRecorder(): Promise<ClipRecorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const recorder = new MediaRecorder(stream, { mimeType: preferredMime() })
  const chunks: BlobPart[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  recorder.start()

  const releaseMic = (): void => stream.getTracks().forEach((t) => t.stop())

  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        recorder.onstop = () => {
          releaseMic()
          resolve(new Blob(chunks, { type: recorder.mimeType }))
        }
        recorder.stop()
      }),
    cancel: () => {
      recorder.onstop = null
      try {
        recorder.stop()
      } catch {
        // already stopped
      }
      releaseMic()
    }
  }
}

function preferredMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? ''
}

/** Duration of an audio blob in whole seconds, or null if undecodable. */
export async function audioDurationSeconds(blob: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const el = new Audio()
    el.preload = 'metadata'
    el.onloadedmetadata = () => {
      URL.revokeObjectURL(url)
      resolve(Number.isFinite(el.duration) ? Math.round(el.duration) : null)
    }
    el.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    el.src = url
  })
}

export interface VoiceSampleQuality {
  ok: boolean
  reason?: string
  durationSeconds: number | null
  rms?: number
  peak?: number
}

export async function analyzeVoiceSample(
  blob: Blob,
  minSeconds = 5,
  maxSeconds = 20
): Promise<VoiceSampleQuality> {
  const durationSeconds = await audioDurationSeconds(blob)
  if (durationSeconds !== null && durationSeconds < minSeconds) {
    return { ok: false, durationSeconds, reason: `The sample is too short. Please speak for at least ${minSeconds} seconds.` }
  }
  if (durationSeconds !== null && durationSeconds > maxSeconds + 2) {
    return { ok: false, durationSeconds, reason: `The sample is too long. Please keep it under ${maxSeconds} seconds.` }
  }
  if (blob.size < 8_000) {
    return { ok: false, durationSeconds, reason: 'The sample looks too quiet or empty. Please retake it and speak clearly.' }
  }

  try {
    const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) return { ok: true, durationSeconds }

    const ctx = new AudioCtx()
    const buffer = await ctx.decodeAudioData(await blob.arrayBuffer())
    await ctx.close()

    let sumSquares = 0
    let peak = 0
    let clipped = 0
    let count = 0
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel)
      const stride = Math.max(1, Math.floor(data.length / 24_000))
      for (let i = 0; i < data.length; i += stride) {
        const value = Math.abs(data[i])
        sumSquares += value * value
        peak = Math.max(peak, value)
        if (value > 0.98) clipped += 1
        count += 1
      }
    }
    const rms = Math.sqrt(sumSquares / Math.max(count, 1))
    const clippedRatio = clipped / Math.max(count, 1)

    if (rms < 0.008 || peak < 0.03) {
      return { ok: false, durationSeconds, rms, peak, reason: 'The sample is too quiet. Please move closer to the microphone and retake it.' }
    }
    if (clippedRatio > 0.08) {
      return { ok: false, durationSeconds, rms, peak, reason: 'The sample sounds distorted. Please move slightly away from the microphone and retake it.' }
    }
    return { ok: true, durationSeconds, rms, peak }
  } catch {
    // Some Electron/Chromium builds cannot decode every recorded container here.
    // Duration + non-empty size still catches the main bad samples; pyannoteAI is
    // the final server-confirmed validation before enrollment succeeds.
    return { ok: true, durationSeconds }
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
  return dataUrl.slice(dataUrl.indexOf(',') + 1)
}
