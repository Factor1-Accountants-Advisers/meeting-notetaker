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

export async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
  return dataUrl.slice(dataUrl.indexOf(',') + 1)
}
