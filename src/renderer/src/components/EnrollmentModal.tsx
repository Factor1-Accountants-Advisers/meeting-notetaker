import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Mic, MicOff, RotateCcw, Square, X } from 'lucide-react'
import { Pill } from '@renderer/components/ui/Pill'
import { enrollPerson } from '@renderer/lib/api'
import {
  analyzeVoiceSample,
  blobToBase64,
  startClipRecorder,
  type ClipRecorder,
  type VoiceSampleQuality
} from '@renderer/lib/recorder'
import type { StaffMember } from '@renderer/data/mock'

const CLIPS_NEEDED = 3
const MIN_CLIP_SECONDS = 5
const MAX_CLIP_SECONDS = 20

const PROMPTS = [
  'Hi, this is Joseph Miguel Guerrero. I’m setting up Notetaker so it can identify my voice in meeting transcripts. I usually speak with clients and colleagues about work progress, decisions, and follow-up actions.',
  'Today I’m working on meeting notes, client updates, action items, and making sure everyone has clear next steps after each conversation.',
  'I’ll speak clearly for a few seconds in my normal meeting voice. The goal is to help Notetaker recognise me accurately without keeping the original recording.'
]

type RecState = 'idle' | 'recording' | 'checking' | 'denied' | 'saving'
type WizardStep = 'welcome' | 'consent' | 'sample-0' | 'sample-1' | 'sample-2' | 'complete'

interface Props {
  person: StaffMember
  onClose: () => void
  /** Fired only after the backend confirms enrollment. */
  onEnrolled: (updated: StaffMember) => void
  required?: boolean
}

interface AcceptedClip {
  blob: Blob
  quality: VoiceSampleQuality
}

export function EnrollmentModal({ person, onClose, onEnrolled, required = false }: Props): JSX.Element {
  const [step, setStep] = useState<WizardStep>('welcome')
  const [clips, setClips] = useState<Array<AcceptedClip | null>>([null, null, null])
  const [state, setState] = useState<RecState>('idle')
  const [seconds, setSeconds] = useState(0)
  const [consented, setConsented] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recorderRef = useRef<ClipRecorder | null>(null)

  useEffect(() => {
    if (state !== 'recording') return
    const id = window.setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => window.clearInterval(id)
  }, [state])

  useEffect(() => {
    if (state === 'recording' && seconds >= MAX_CLIP_SECONDS) void stopClip()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds, state])

  useEffect(() => () => recorderRef.current?.cancel(), [])

  const sampleIndex = step.startsWith('sample-') ? Number(step.slice('sample-'.length)) : -1
  const acceptedCount = clips.filter(Boolean).length
  const allClipsReady = acceptedCount === CLIPS_NEEDED

  const startClip = async (): Promise<void> => {
    setError(null)
    try {
      recorderRef.current = await startClipRecorder()
      setSeconds(0)
      setState('recording')
    } catch {
      setState('denied')
      setError('Microphone access was blocked. Allow it in system settings and try again.')
    }
  }

  const stopClip = async (): Promise<void> => {
    const rec = recorderRef.current
    if (!rec || sampleIndex < 0) return
    recorderRef.current = null
    const blob = await rec.stop()
    setState('checking')
    const quality = await analyzeVoiceSample(blob, MIN_CLIP_SECONDS, MAX_CLIP_SECONDS)
    if (!quality.ok) {
      setState('idle')
      setError(quality.reason ?? 'This voice sample was not clear enough. Please retake it.')
      return
    }

    setClips((prev) => prev.map((item, i) => (i === sampleIndex ? { blob, quality } : item)))
    setState('idle')
    setError(null)
  }

  const retakeCurrent = (): void => {
    if (sampleIndex < 0 || state === 'saving') return
    setClips((prev) => prev.map((item, i) => (i === sampleIndex ? null : item)))
    setError(null)
    setState('idle')
  }

  const goNext = async (): Promise<void> => {
    if (state === 'saving') return
    if (step === 'welcome') {
      setStep('consent')
      return
    }
    if (step === 'consent') {
      if (!consented) return
      setStep('sample-0')
      return
    }
    if (step.startsWith('sample-')) {
      if (sampleIndex < CLIPS_NEEDED - 1) {
        setStep(`sample-${sampleIndex + 1}` as WizardStep)
        setError(null)
        return
      }
      if (allClipsReady) await save()
    }
  }

  const goBack = (): void => {
    if (state === 'recording' || state === 'checking' || state === 'saving') return
    setError(null)
    if (step === 'consent') setStep('welcome')
    else if (step === 'sample-0') setStep('consent')
    else if (step === 'sample-1') setStep('sample-0')
    else if (step === 'sample-2') setStep('sample-1')
  }

  const save = async (): Promise<void> => {
    if (!consented || !allClipsReady) return
    setState('saving')
    setError(null)
    const readyClips = clips.filter((clip): clip is AcceptedClip => clip !== null)
    const mime = readyClips[0]?.blob.type || 'audio/webm'
    const b64 = await Promise.all(readyClips.map((clip) => blobToBase64(clip.blob)))
    try {
      const updated = await enrollPerson(person.id, b64, mime)
      if (updated) {
        setStep('complete')
        window.setTimeout(() => onEnrolled(updated), 900)
        return
      }
    } catch (err) {
      setState('idle')
      setError(err instanceof Error ? err.message : 'Voiceprint enrollment failed.')
      return
    }

    setState('idle')
    setError('Voiceprint enrollment failed. Check that the backend is running and pyannoteAI is configured, then try again.')
  }

  const currentClip = sampleIndex >= 0 ? clips[sampleIndex] : null
  const nextDisabled =
    state === 'recording' ||
    state === 'checking' ||
    state === 'saving' ||
    (step === 'consent' && !consented) ||
    (step.startsWith('sample-') && !currentClip)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
      <div className="w-full max-w-[400px] aspect-square overflow-hidden rounded-lg border-[0.5px] border-edge-secondary bg-bg-primary flex flex-col">
        <div className="border-b-[0.5px] border-edge-tertiary px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="m-0 text-[16px] font-medium text-content-primary">
                {titleFor(step, person.name)}
              </h2>
              <p className="mb-0 mt-1 text-[12px] text-content-tertiary">{subtitleFor(step)}</p>
            </div>
            {!required && (
              <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                disabled={state === 'saving'}
                className="text-content-tertiary hover:text-content-secondary disabled:opacity-45"
              >
                <X size={16} strokeWidth={1.75} />
              </button>
            )}
          </div>
          <Progress step={step} clips={clips} consented={consented} />
        </div>

        <div className="flex-1 min-h-0 px-5 py-5 overflow-auto transition-opacity duration-200">
          {step === 'welcome' && <WelcomePage person={person} />}
          {step === 'consent' && (
            <ConsentPage
              consented={consented}
              onChange={(checked) => {
                setConsented(checked)
                setError(null)
              }}
            />
          )}
          {step.startsWith('sample-') && sampleIndex >= 0 && (
            <SamplePage
              index={sampleIndex}
              prompt={PROMPTS[sampleIndex]}
              clip={currentClip}
              state={state}
              seconds={seconds}
              error={error}
            />
          )}
          {step === 'complete' && <CompletePage />}

          {(error && !step.startsWith('sample-')) && (
            <p className="mb-0 mt-4 rounded-md border-[0.5px] border-edge-danger bg-bg-danger px-3 py-2 text-[12px] leading-relaxed text-content-danger">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between border-t-[0.5px] border-edge-tertiary px-5 py-4">
          <button
            type="button"
            onClick={goBack}
            disabled={step === 'welcome' || step === 'complete' || state === 'recording' || state === 'checking' || state === 'saving'}
            className="flex items-center gap-1.5 rounded-md border-[0.5px] border-edge-secondary px-3 py-2 text-[13px] text-content-primary transition-colors hover:bg-bg-secondary disabled:cursor-not-allowed disabled:opacity-35"
          >
            <ArrowLeft size={14} strokeWidth={1.75} />
            Back
          </button>

          {step === 'complete' ? (
            <span className="text-[13px] text-content-success">Unlocking Notetaker…</span>
          ) : step.startsWith('sample-') ? (
            <div className="flex items-center gap-2">
              {currentClip && (
                <button
                  type="button"
                  onClick={retakeCurrent}
                  disabled={state === 'saving'}
                  className="flex items-center gap-1.5 rounded-md border-[0.5px] border-edge-secondary px-3 py-2 text-[13px] text-content-primary transition-colors hover:bg-bg-secondary disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <RotateCcw size={14} strokeWidth={1.75} />
                  Retake
                </button>
              )}
              {!currentClip ? (
                <SampleAction
                  state={state}
                  seconds={seconds}
                  index={sampleIndex}
                  onStart={() => void startClip()}
                  onStop={() => void stopClip()}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => void goNext()}
                  disabled={nextDisabled}
                  className="flex items-center gap-1.5 rounded-md border-[0.5px] border-edge-info bg-bg-info px-3.5 py-2 text-[13px] text-content-info transition-opacity disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {step === 'sample-2' ? 'Create voiceprint' : 'Next'}
                  <ArrowRight size={14} strokeWidth={1.75} />
                </button>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void goNext()}
              disabled={nextDisabled}
              className="flex items-center gap-1.5 rounded-md border-[0.5px] border-edge-info bg-bg-info px-3.5 py-2 text-[13px] text-content-info transition-opacity disabled:cursor-not-allowed disabled:opacity-45"
            >
              {step === 'sample-2' ? 'Create voiceprint' : 'Next'}
              <ArrowRight size={14} strokeWidth={1.75} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function titleFor(step: WizardStep, name: string): string {
  if (step === 'welcome') return 'Welcome to Notetaker'
  if (step === 'consent') return 'Set up voice identification'
  if (step === 'complete') return 'Voiceprint setup complete'
  const index = Number(step.slice('sample-'.length)) + 1
  return `Voice sample ${index} of ${CLIPS_NEEDED} — ${name}`
}

function subtitleFor(step: WizardStep): string {
  if (step === 'welcome') return 'A quick setup step before you start recording meetings.'
  if (step === 'consent') return 'Voice samples help Notetaker identify you in transcripts.'
  if (step === 'complete') return 'Your enrollment has been confirmed by the backend.'
  return 'Read the prompt aloud in your normal meeting voice.'
}

function Progress({ step, clips, consented }: { step: WizardStep; clips: Array<AcceptedClip | null>; consented: boolean }): JSX.Element {
  const labels = ['Welcome', 'Consent', 'Sample 1', 'Sample 2', 'Sample 3', 'Done']
  const current = step === 'welcome' ? 0 : step === 'consent' ? 1 : step === 'complete' ? 5 : Number(step.slice('sample-'.length)) + 2
  return (
    <div className="mt-4 grid grid-cols-6 gap-1.5">
      {labels.map((label, index) => {
        const done = index === 0 || (index === 1 && consented) || (index >= 2 && index <= 4 && clips[index - 2]) || step === 'complete'
        const active = index === current
        return (
          <div key={label} className="min-w-0">
            <div
              className={`h-1.5 rounded-full ${
                done ? 'bg-edge-success' : active ? 'bg-edge-info' : 'bg-edge-tertiary'
              }`}
            />
            <div className={`mt-1 truncate text-[10px] ${active ? 'text-content-primary' : 'text-content-tertiary'}`}>
              {label}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function WelcomePage({ person }: { person: StaffMember }): JSX.Element {
  return (
    <div className="space-y-4">
      <p className="m-0 text-[13px] leading-relaxed text-content-secondary">
        Hi {person.name}. Notetaker records meetings, transcribes them, and helps identify speakers so notes are easier to review. Before you start, we'll set up your staff voiceprint. This is required for Factor1 staff and only takes a few short samples.
      </p>
    </div>
  )
}

function ConsentPage({ consented, onChange }: { consented: boolean; onChange: (checked: boolean) => void }): JSX.Element {
  return (
    <div className="space-y-4">
      <p className="m-0 text-[13px] leading-relaxed text-content-secondary">
        To fully utilise Notetaker, we need to record a few short voice samples. These help reduce Unknown speakers in meeting transcripts.
      </p>
      <label className="flex items-start gap-2 rounded-md border-[0.5px] border-edge-tertiary p-3 text-[12px] leading-relaxed text-content-secondary">
        <input
          type="checkbox"
          checked={consented}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5"
        />
        <span>I consent to Factor1 creating and storing voiceprints for staff speaker identification.</span>
      </label>
    </div>
  )
}

function SamplePage({
  index,
  prompt,
  clip,
  state,
  seconds,
  error,
}: {
  index: number
  prompt: string
  clip: AcceptedClip | null
  state: RecState
  seconds: number
  error: string | null
}): JSX.Element {
  return (
    <div className="space-y-4">
      <div className="rounded-md border-[0.5px] border-edge-tertiary bg-bg-secondary p-3">
        <div className="text-[12px] font-medium text-content-primary">Please read this aloud</div>
        <p className="mb-0 mt-2 text-[13px] leading-relaxed text-content-secondary">"{prompt}"</p>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {Array.from({ length: CLIPS_NEEDED }, (_, i) => (
          <div
            key={i}
            className={`flex h-9 items-center justify-center gap-1.5 rounded-md border-[0.5px] text-[12px] ${
              i < index
                ? 'border-edge-success bg-bg-success text-content-success'
                : i === index && clip
                  ? 'border-edge-success bg-bg-success text-content-success'
                  : i === index && state === 'recording'
                    ? 'border-edge-danger bg-bg-danger text-content-danger'
                    : i === index
                      ? 'border-edge-info bg-bg-info text-content-info'
                      : 'border-edge-tertiary bg-bg-secondary text-content-tertiary'
            }`}
          >
            {(i < index || (i === index && clip)) ? <Check size={13} strokeWidth={2} /> : null}
            {i === index && state === 'recording' ? `0:${String(seconds).padStart(2, '0')}` : `Sample ${i + 1}`}
          </div>
        ))}
      </div>

      {state === 'checking' && (
        <p className="mb-0 flex items-center gap-2 text-[12px] text-content-secondary">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-edge-tertiary border-t-brand-blue" />
          Checking sample quality…
        </p>
      )}
      {state === 'denied' && (
        <p className="mb-0 flex items-center gap-1.5 text-[12px] text-content-danger">
          <MicOff size={13} strokeWidth={1.75} />
          Microphone access was blocked. Allow it in system settings and try again.
        </p>
      )}
      {error && <p className="mb-0 text-[12px] leading-relaxed text-content-danger">{error}</p>}
    </div>
  )
}

function SampleAction({
  state,
  seconds,
  index,
  onStart,
  onStop
}: {
  state: RecState
  seconds: number
  index: number
  onStart: () => void
  onStop: () => void
}): JSX.Element {
  if (state === 'recording') {
    return (
      <button
        type="button"
        onClick={onStop}
        disabled={seconds < MIN_CLIP_SECONDS}
        className="flex items-center gap-1.5 rounded-md border-[0.5px] border-edge-danger bg-bg-danger px-3.5 py-2 text-[13px] text-content-danger disabled:cursor-not-allowed disabled:opacity-45"
      >
        <Square size={14} strokeWidth={1.75} />
        Stop sample
      </button>
    )
  }
  if (state === 'checking') {
    return <span className="text-[13px] text-content-secondary">Checking…</span>
  }
  return (
    <button
      type="button"
      onClick={onStart}
      className="flex items-center gap-1.5 rounded-md border-[0.5px] border-edge-info bg-bg-info px-3.5 py-2 text-[13px] text-content-info"
    >
      <Mic size={15} strokeWidth={1.75} />
      Record sample {index + 1}
    </button>
  )
}

function CompletePage(): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 py-8 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-bg-success text-content-success">
        <Check size={22} strokeWidth={2} />
      </span>
      <p className="m-0 text-[13px] leading-relaxed text-content-secondary">
        Your voiceprints have been created and Notetaker is ready to use.
      </p>
      <Pill tone="success">Enrollment confirmed</Pill>
    </div>
  )
}
