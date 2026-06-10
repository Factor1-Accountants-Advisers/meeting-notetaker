import { useEffect, useState } from 'react'
import { CloudOff, Mic, Pause, Play, Square, Volume2 } from 'lucide-react'
import { Card } from '@renderer/components/ui/Card'
import { Pill } from '@renderer/components/ui/Pill'

/** Lifted to App so recording survives navigation between screens. */
export interface RecordingSession {
  meetingId: string | null // null when created offline (not saved to backend)
  title: string
  source: 'online' | 'in_person'
  startedAt: number // epoch ms
  pausedAccum: number // total paused ms so far
  pausedAt: number | null // epoch ms when current pause began; null = recording
}

export function elapsedMs(s: RecordingSession, now = Date.now()): number {
  const pausedSoFar = s.pausedAccum + (s.pausedAt !== null ? now - s.pausedAt : 0)
  return now - s.startedAt - pausedSoFar
}

function clock(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

interface Props {
  session: RecordingSession
  onPause: () => void
  onResume: () => void
  onStop: () => void
}

export function RecordingScreen({ session, onPause, onResume, onStop }: Props): JSX.Element {
  const [now, setNow] = useState(Date.now())
  const paused = session.pausedAt !== null

  useEffect(() => {
    if (paused) return
    const id = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(id)
  }, [paused])

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="mb-0.5 text-[12px] text-content-tertiary">
          {paused ? 'Recording paused' : 'Recording'}
        </div>
        <h1 className="truncate text-[22px] font-medium text-content-primary">{session.title}</h1>
      </div>

      <Card className="flex flex-col items-center gap-5 !py-9">
        <div className="flex items-center gap-3">
          <span
            className={`h-3 w-3 rounded-full ${
              paused ? 'bg-content-tertiary' : 'animate-pulse bg-edge-danger'
            }`}
          />
          <span className="text-[40px] font-medium tabular-nums text-content-primary">
            {clock(elapsedMs(session, now))}
          </span>
        </div>

        {paused ? (
          <Pill tone="warning">Paused</Pill>
        ) : (
          <Pill tone="danger">Recording</Pill>
        )}

        <div className="flex gap-2.5">
          {paused ? (
            <button
              type="button"
              onClick={onResume}
              className="flex items-center gap-1.5 rounded-md border-[0.5px] border-edge-info bg-bg-info px-4 py-2.5 text-[14px] text-content-info"
            >
              <Play size={16} strokeWidth={1.75} />
              Resume
            </button>
          ) : (
            <button
              type="button"
              onClick={onPause}
              className="flex items-center gap-1.5 rounded-md border-[0.5px] border-edge-secondary px-4 py-2.5 text-[14px] text-content-primary hover:bg-bg-secondary"
            >
              <Pause size={16} strokeWidth={1.75} />
              Pause
            </button>
          )}
          <button
            type="button"
            onClick={onStop}
            className="flex items-center gap-1.5 rounded-md border-[0.5px] border-edge-danger bg-bg-danger px-4 py-2.5 text-[14px] text-content-danger"
          >
            <Square size={15} strokeWidth={1.75} />
            Stop
          </button>
        </div>
      </Card>

      <Card>
        <div className="flex flex-col gap-2 text-[12px] text-content-secondary">
          <span className="flex items-center gap-1.5">
            <Mic size={13} strokeWidth={1.75} />
            {session.source === 'online'
              ? 'Capturing system audio (loopback) + microphone'
              : 'Capturing microphone'}
          </span>
          {session.source === 'online' && (
            <span className="flex items-center gap-1.5 text-content-tertiary">
              <Volume2 size={13} strokeWidth={1.75} />
              Loopback captures all system sound — silence notifications and media while
              recording.
            </span>
          )}
          {session.meetingId === null && (
            <span className="flex items-center gap-1.5 text-content-warning">
              <CloudOff size={13} strokeWidth={1.75} />
              Backend unavailable — this meeting is not saved yet.
            </span>
          )}
        </div>
      </Card>
    </div>
  )
}
