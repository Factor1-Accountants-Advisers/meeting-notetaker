import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  AudioWaveform as AudioWaveformIcon,
  CloudOff,
  Clock3,
  Mic,
  MicOff,
  Pause,
  Play,
  Square,
} from 'lucide-react'
import { Card } from '@renderer/components/ui/Card'
import type { CaptureStatus } from '@renderer/lib/capture'

/** Lifted to App so recording survives navigation between screens. */
export interface RecordingSession {
  meetingId: string | null
  title: string
  source: 'online' | 'in_person'
  startedAt: number
  pausedAccum: number
  pausedAt: number | null
  scheduledEndUtc?: string | null
}

export function elapsedMs(session: RecordingSession, now = Date.now()): number {
  const pausedSoFar =
    session.pausedAccum + (session.pausedAt !== null ? now - session.pausedAt : 0)
  return now - session.startedAt - pausedSoFar
}

function clock(ms: number): string {
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const hh = String(hours).padStart(2, '0')
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function remainingLabel(ms: number): string {
  if (ms <= 0) return 'Scheduled end passed'
  const minutes = Math.ceil(ms / 60_000)
  return minutes === 1 ? '1 min remaining' : `${minutes} min remaining`
}

interface Props {
  session: RecordingSession
  captureStatus: CaptureStatus | null
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onExtend?: () => void
  extending?: boolean
  saving?: boolean
}

export function RecordingScreen({
  session,
  captureStatus,
  onPause,
  onResume,
  onStop,
  onExtend,
  extending = false,
  saving = false
}: Props): JSX.Element {
  const [now, setNow] = useState(Date.now())
  const paused = session.pausedAt !== null
  const scheduledEndMs = session.scheduledEndUtc
    ? new Date(session.scheduledEndUtc).getTime()
    : null
  const remainingMs = scheduledEndMs !== null ? scheduledEndMs - now : null
  const endLabel =
    scheduledEndMs !== null
      ? new Date(scheduledEndMs).toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit'
        }).toLocaleLowerCase()
      : null

  useEffect(() => {
    if (saving) return
    const id = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(id)
  }, [saving])

  useEffect(() => {
    // An extension can arrive between timer ticks. Rebase immediately so the
    // new remaining time and scheduled end render in the same update.
    setNow(Date.now())
  }, [session.scheduledEndUtc])

  if (saving) {
    return (
      <Card className="flex flex-col items-center gap-3 !px-5 !py-8 text-center">
        <span className="h-3 w-3 animate-pulse rounded-full bg-edge-success" />
        <div>
          <h1 className="m-0 truncate text-[18px] font-medium text-content-primary">
            Finishing {session.title}
          </h1>
          <p className="mb-0 mt-1 text-[13px] text-content-secondary">
            Saving and uploading your recording…
          </p>
        </div>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <div className="text-center">
          <p className="m-0 truncate text-[12px] text-content-tertiary">{session.title}</p>
          <div className="mt-1 text-[20px] font-medium leading-tight tabular-nums text-content-primary">
            {clock(elapsedMs(session, now))}
          </div>
          <AudioWaveform
            paused={paused}
            level={Math.max(captureStatus?.micLevel ?? 0, captureStatus?.loopbackLevel ?? 0)}
          />
        </div>

        <div className="mt-3">
          <LevelMeter
            icon={captureStatus?.mic === 'error' || captureStatus?.mic === 'silent' ? MicOff : Mic}
            label="Microphone"
            level={captureStatus?.micLevel ?? 0}
            state={captureStatus?.mic ?? 'off'}
          />
          {session.source === 'online' && (
            <LevelMeter
              icon={AudioWaveformIcon}
              label="System audio"
              level={captureStatus?.loopbackLevel ?? 0}
              state={captureStatus?.loopback ?? 'off'}
            />
          )}
        </div>

        {remainingMs !== null && endLabel && (
          <div
            className={`mb-2.5 flex items-center justify-between gap-3 border-t border-edge-tertiary py-2.5 text-left text-[14px] ${
              remainingMs > 0 ? 'text-content-secondary' : 'text-content-warning'
            }`}
            aria-label={`Scheduled to end at ${endLabel}, ${remainingLabel(remainingMs)}`}
          >
            <span className="flex items-center gap-1.5">
              <Clock3 size={15} aria-hidden="true" />
              Scheduled end
            </span>
            <span className="whitespace-nowrap">
              <strong className="font-medium text-content-primary">{endLabel}</strong>
              <span className="text-[12px] text-content-tertiary">
                {' '}
                · {remainingLabel(remainingMs)}
              </span>
            </span>
          </div>
        )}

        <div className={`grid gap-2 ${onExtend ? 'grid-cols-3' : 'grid-cols-2'}`}>
          {paused ? (
            <button
              type="button"
              aria-label="Resume recording"
              onClick={onResume}
              className="ui-control flex min-h-7 min-w-0 items-center justify-center gap-1 rounded-control border border-edge-secondary bg-bg-secondary px-2 text-[14px] text-content-primary hover:bg-bg-tertiary"
            >
              <Play size={16} strokeWidth={1.75} />
              Resume
            </button>
          ) : (
            <button
              type="button"
              aria-label="Pause recording"
              onClick={onPause}
              className="ui-control flex min-h-7 min-w-0 items-center justify-center gap-1 rounded-control border border-edge-secondary bg-bg-secondary px-2 text-[14px] text-content-primary hover:bg-bg-tertiary"
            >
              <Pause size={16} strokeWidth={1.75} />
              Pause
            </button>
          )}

          {onExtend && (
            <button
              type="button"
              onClick={onExtend}
              disabled={extending}
              className="ui-control flex min-h-7 min-w-0 items-center justify-center gap-1 rounded-control border border-transparent bg-white px-2 text-[14px] text-[#111111] hover:bg-[#F2F2F2] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {!extending && <Clock3 size={15} aria-hidden="true" />}
              {extending ? 'Extending…' : 'Extend 10 min'}
            </button>
          )}

          <button
            type="button"
            aria-label="Stop recording"
            onClick={onStop}
            className="ui-control flex min-h-7 min-w-0 items-center justify-center gap-1 rounded-control border border-transparent bg-[var(--color-button-stop)] px-2 text-[14px] text-[#17110D] hover:bg-[var(--color-button-stop-hover)]"
          >
            <Square size={15} strokeWidth={1.75} />
            Stop recording
          </button>
        </div>
      </Card>

      <CaptureWarnings session={session} captureStatus={captureStatus} />
    </div>
  )
}

function AudioWaveform({ paused, level }: { paused: boolean; level: number }): JSX.Element {
  const pattern = [28, 48, 74, 38, 88, 56, 94, 42, 68, 34, 80, 50, 90, 44, 62, 30, 72, 46, 84, 36, 66]
  const strength = paused ? 0.25 : 0.58 + Math.min(1, level * 16) * 0.42

  return (
    <div
      className="mt-2.5 flex h-12 items-center justify-center gap-[3px]"
      role="img"
      aria-label={paused ? 'Audio waveform paused' : 'Live audio waveform'}
    >
      {pattern.map((height, index) => (
        <span
          key={`${height}-${index}`}
          className="w-[3px] rounded-full bg-brand-blue transition-[height,opacity] duration-100"
          style={{
            height: `${Math.max(5, Math.round((height / 100) * 48 * strength))}px`,
            opacity: paused ? 0.45 : 0.92
          }}
        />
      ))}
    </div>
  )
}

function LevelMeter({
  icon: Icon,
  label,
  level,
  state
}: {
  icon: typeof Mic
  label: string
  level: number
  state: CaptureStatus['mic']
}): JSX.Element {
  const visual = Math.min(100, Math.round(Math.pow(Math.max(0, level) / 0.05, 0.45) * 100))
  const problem = state === 'error' || state === 'silent'

  return (
    <div className="grid grid-cols-[minmax(8rem,1fr)_minmax(7rem,2fr)_auto] items-center gap-3 border-t border-edge-tertiary py-2 max-[560px]:grid-cols-1">
      <span className="flex min-w-0 items-center gap-[7px] text-[14px] text-content-primary">
        <Icon size={15} strokeWidth={1.75} className="text-content-secondary" />
        {label}
      </span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-background-muted)]">
        <div
          className={`h-full rounded-full transition-[width] duration-100 ${
            problem ? 'bg-edge-danger' : 'bg-brand-blue'
          }`}
          style={{ width: `${visual}%` }}
        />
      </div>
      <span
        className={`h-2 w-2 shrink-0 rounded-full max-[560px]:hidden ${
          problem
            ? 'bg-edge-danger'
            : state === 'active'
              ? 'bg-[var(--color-button-stop)]'
              : 'bg-content-tertiary'
        }`}
        aria-label={`${label} ${state}`}
      />
    </div>
  )
}

function CaptureWarnings({
  session,
  captureStatus
}: {
  session: RecordingSession
  captureStatus: CaptureStatus | null
}): JSX.Element | null {
  const warnings: { icon: typeof AlertTriangle; text: string; tone: string }[] = []

  if (captureStatus?.mic === 'error') {
    warnings.push({
      icon: MicOff,
      text: 'Microphone unavailable — check access in system settings.',
      tone: 'text-content-danger'
    })
  } else if (captureStatus?.mic === 'silent') {
    warnings.push({
      icon: MicOff,
      text: 'Microphone appears silent — check your selected microphone.',
      tone: 'text-content-danger'
    })
  }
  if (session.source === 'online' && captureStatus?.loopback === 'error') {
    warnings.push({
      icon: AlertTriangle,
      text: 'System audio failed — remote participants are not being captured.',
      tone: 'text-content-danger'
    })
  } else if (session.source === 'online' && captureStatus?.loopback === 'silent') {
    warnings.push({
      icon: AlertTriangle,
      text: 'System audio has been silent for over a minute — check your audio output device.',
      tone: 'text-content-danger'
    })
  }
  if (captureStatus !== null && !captureStatus.recording) {
    warnings.push({
      icon: AlertTriangle,
      text: 'No audio is being captured — the timer is still running.',
      tone: 'text-content-danger'
    })
  }
  if (session.meetingId === null) {
    warnings.push({
      icon: CloudOff,
      text: 'Backend unavailable — this meeting is not saved yet.',
      tone: 'text-content-warning'
    })
  }
  if (warnings.length === 0) return null

  return (
    <Card className="!py-2.5">
      <div className="flex flex-col gap-2">
        {warnings.map(({ icon: Icon, text, tone }) => (
          <div key={text} className={`flex items-start gap-2 text-[12px] ${tone}`}>
            <Icon size={14} strokeWidth={1.75} className="mt-0.5 shrink-0" />
            <span>{text}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}
