import { useEffect, useRef, useState } from 'react'
import { Check, Mic, MicOff, RotateCcw, Square, X } from 'lucide-react'
import { Pill } from '@renderer/components/ui/Pill'
import { enrollPerson } from '@renderer/lib/api'
import { blobToBase64, startClipRecorder, type ClipRecorder } from '@renderer/lib/recorder'
import type { StaffMember } from '@renderer/data/mock'

const CLIPS_NEEDED = 3
const MIN_CLIP_SECONDS = 5
const MAX_CLIP_SECONDS = 20

type RecState = 'idle' | 'recording' | 'denied' | 'saving'

interface Props {
  person: StaffMember
  onClose: () => void
  /** Fired with the updated member; `live` is false when saved without a backend. */
  onEnrolled: (updated: StaffMember, live: boolean) => void
}

export function EnrollmentModal({ person, onClose, onEnrolled }: Props): JSX.Element {
  const [clips, setClips] = useState<Blob[]>([])
  const [state, setState] = useState<RecState>('idle')
  const [seconds, setSeconds] = useState(0)
  const recorderRef = useRef<ClipRecorder | null>(null)

  // Tick + auto-stop while recording.
  useEffect(() => {
    if (state !== 'recording') return
    const id = window.setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => window.clearInterval(id)
  }, [state])

  useEffect(() => {
    if (state === 'recording' && seconds >= MAX_CLIP_SECONDS) void stopClip()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds, state])

  // Release the mic if the modal unmounts mid-recording.
  useEffect(() => () => recorderRef.current?.cancel(), [])

  const startClip = async (): Promise<void> => {
    try {
      recorderRef.current = await startClipRecorder()
      setSeconds(0)
      setState('recording')
    } catch {
      setState('denied')
    }
  }

  const stopClip = async (): Promise<void> => {
    const rec = recorderRef.current
    if (!rec) return
    recorderRef.current = null
    const blob = await rec.stop()
    setState('idle')
    setClips((prev) => [...prev, blob])
  }

  const redoLast = (): void => setClips((prev) => prev.slice(0, -1))

  const save = async (): Promise<void> => {
    setState('saving')
    const mime = clips[0]?.type || 'audio/webm'
    const b64 = await Promise.all(clips.map(blobToBase64))
    const updated = await enrollPerson(person.id, b64, mime)
    if (updated) {
      onEnrolled(updated, true)
      return
    }
    // Backend unreachable — reflect enrollment locally so the flow completes.
    onEnrolled({ ...person, enrollment: 'enrolled', modelVersion: 'pending sync' }, false)
  }

  const done = clips.length >= CLIPS_NEEDED

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
      <div className="w-full max-w-[420px] rounded-lg border-[0.5px] border-edge-secondary bg-bg-primary p-5">
        <div className="mb-1 flex items-start justify-between">
          <h2 className="m-0 text-[16px] font-medium text-content-primary">
            Voiceprint enrollment — {person.name}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            disabled={state === 'saving'}
            className="text-content-tertiary hover:text-content-secondary disabled:opacity-45"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
        <p className="mb-4 mt-0 text-[12px] leading-relaxed text-content-tertiary">
          Record {CLIPS_NEEDED} short clips of natural speech ({MIN_CLIP_SECONDS}–
          {MAX_CLIP_SECONDS} seconds each) — describe your day or read anything aloud. Clips are
          converted to a single voiceprint and the audio is deleted immediately. Biometric
          consent is collected during onboarding.
        </p>

        {/* Clip progress */}
        <div className="mb-4 flex gap-2">
          {Array.from({ length: CLIPS_NEEDED }, (_, i) => (
            <div
              key={i}
              className={`flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border-[0.5px] text-[12px] ${
                i < clips.length
                  ? 'border-edge-tertiary bg-bg-success text-content-success'
                  : i === clips.length && state === 'recording'
                    ? 'border-edge-danger bg-bg-danger text-content-danger'
                    : 'border-edge-tertiary bg-bg-secondary text-content-tertiary'
              }`}
            >
              {i < clips.length ? (
                <>
                  <Check size={13} strokeWidth={2} /> Clip {i + 1}
                </>
              ) : i === clips.length && state === 'recording' ? (
                <>
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-edge-danger" />
                  0:{String(seconds).padStart(2, '0')}
                </>
              ) : (
                `Clip ${i + 1}`
              )}
            </div>
          ))}
        </div>

        {state === 'denied' && (
          <p className="mb-3 mt-0 flex items-center gap-1.5 text-[12px] text-content-danger">
            <MicOff size={13} strokeWidth={1.75} />
            Microphone access was blocked. Allow it in system settings and try again.
          </p>
        )}

        <div className="flex items-center gap-2">
          {!done && state !== 'recording' && (
            <button
              type="button"
              onClick={() => void startClip()}
              disabled={state === 'saving'}
              className="flex items-center gap-1.5 rounded-md border-[0.5px] border-edge-info bg-bg-info px-3.5 py-2 text-[13px] text-content-info disabled:opacity-45"
            >
              <Mic size={15} strokeWidth={1.75} />
              Record clip {clips.length + 1}
            </button>
          )}
          {state === 'recording' && (
            <button
              type="button"
              onClick={() => void stopClip()}
              disabled={seconds < MIN_CLIP_SECONDS}
              title={
                seconds < MIN_CLIP_SECONDS
                  ? `Keep talking — at least ${MIN_CLIP_SECONDS} seconds`
                  : 'Stop this clip'
              }
              className="flex items-center gap-1.5 rounded-md border-[0.5px] border-edge-danger bg-bg-danger px-3.5 py-2 text-[13px] text-content-danger disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Square size={14} strokeWidth={1.75} />
              Stop clip
            </button>
          )}
          {clips.length > 0 && state !== 'recording' && state !== 'saving' && !done && (
            <button
              type="button"
              onClick={redoLast}
              className="flex items-center gap-1.5 rounded-md border-[0.5px] border-edge-secondary px-3 py-2 text-[13px] text-content-primary hover:bg-bg-secondary"
            >
              <RotateCcw size={14} strokeWidth={1.75} />
              Redo last
            </button>
          )}
          {done && state !== 'saving' && (
            <>
              <button
                type="button"
                onClick={() => void save()}
                className="flex items-center gap-1.5 rounded-md border-[0.5px] border-edge-info bg-bg-info px-3.5 py-2 text-[13px] text-content-info"
              >
                <Check size={15} strokeWidth={1.75} />
                Save voiceprint
              </button>
              <button
                type="button"
                onClick={redoLast}
                className="flex items-center gap-1.5 rounded-md border-[0.5px] border-edge-secondary px-3 py-2 text-[13px] text-content-primary hover:bg-bg-secondary"
              >
                <RotateCcw size={14} strokeWidth={1.75} />
                Redo last
              </button>
            </>
          )}
          {state === 'saving' && (
            <span className="flex items-center gap-2 text-[13px] text-content-secondary">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-edge-tertiary border-t-brand-blue" />
              Extracting voiceprint…
            </span>
          )}
        </div>

        {done && state !== 'saving' && (
          <div className="mt-3">
            <Pill tone="success">All clips recorded</Pill>
          </div>
        )}
      </div>
    </div>
  )
}
