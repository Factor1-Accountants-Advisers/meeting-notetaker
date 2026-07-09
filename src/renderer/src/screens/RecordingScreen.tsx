import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  Clock,
  CloudOff,
  Mic,
  MicOff,
  Pause,
  Play,
  Plus,
  Square,
  Volume2
} from 'lucide-react'
import { Card } from '@renderer/components/ui/Card'
import { Pill } from '@renderer/components/ui/Pill'
import type { CaptureStatus } from '@renderer/lib/capture'

/** Lifted to App so recording survives navigation between screens. */
export interface RecordingSession {
  meetingId: string | null // null when created offline (not saved to backend)
  title: string
  source: 'online' | 'in_person'
  startedAt: number // epoch ms
  pausedAccum: number // total paused ms so far
  pausedAt: number | null // epoch ms when current pause began; null = recording
  // Scheduled auto-stop time (auto-recordings only). Owned by the main process;
  // updated here when the user extends. null/undefined for manual recordings.
  scheduledEndUtc?: string | null
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

function countdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
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
  extending,
  saving
}: Props): JSX.Element {
  const [now, setNow] = useState(Date.now())
  const [stopClicked, setStopClicked] = useState(false)
  const paused = session.pausedAt !== null
  const isSaving = saving || stopClicked

  const scheduledEndMs = session.scheduledEndUtc ? new Date(session.scheduledEndUtc).getTime() : null
  const remainingMs = scheduledEndMs !== null ? scheduledEndMs - now : null
  const endLabel =
    scheduledEndMs !== null
      ? new Date(scheduledEndMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : null

  useEffect(() => {
    // Keep ticking while paused: elapsedMs freezes itself via pause math, but
    // the scheduled-end countdown is wall-clock (auto-stop fires regardless of
    // pause), so it must keep counting down.
    if (isSaving) return
    const id = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(id)
  }, [isSaving])

  if (isSaving) {
    return (
      <div className="flex flex-col gap-4">
        <div>
          <div className="mb-0.5 text-[12px] text-content-tertiary">Finishing up</div>
          <h1 className="truncate text-[22px] font-medium text-content-primary">{session.title}</h1>
        </div>
        <Card className="flex flex-col items-center gap-5 !py-9">
          <div className="flex items-center gap-3">
            <span className="h-3 w-3 animate-pulse rounded-full bg-edge-success" />
            <span className="text-[16px] font-medium text-content-primary">Saving and uploading your recording…</span>
          </div>
          <Pill tone="info">Processing</Pill>
          <div className="text-[13px] text-content-secondary">You'll receive an email with the notes when ready</div>
        </Card>
      </div>
    )
  }

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

        {remainingMs !== null && (
          <div className="flex items-center gap-1.5 text-[13px] text-content-secondary">
            <Clock size={13} strokeWidth={1.75} />
            {remainingMs > 0 ? (
              <span>
                <span className="tabular-nums text-content-primary">{countdown(remainingMs)}</span> until
                scheduled end ({endLabel})
              </span>
            ) : (
              <span className="text-content-warning">
                Past scheduled end ({endLabel}) — extend to keep recording
              </span>
            )}
          </div>
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
          {scheduledEndMs !== null && onExtend && (
            <button
              type="button"
              onClick={onExtend}
              disabled={extending}
              className="flex items-center gap-1.5 rounded-md border-[0.5px] border-edge-secondary px-4 py-2.5 text-[14px] text-content-primary hover:bg-bg-secondary disabled:opacity-50"
            >
              <Plus size={16} strokeWidth={1.75} />
              {extending ? 'Extending…' : 'Extend 10 min'}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setStopClicked(true)
              window.api.debugLog('recording stop button clicked', {
                meetingId: session.meetingId,
                title: session.title
              })
              onStop()
            }}
            className="flex items-center gap-1.5 rounded-md border-[0.5px] border-edge-danger bg-bg-danger px-4 py-2.5 text-[14px] text-content-danger"
          >
            <Square size={15} strokeWidth={1.75} />
            Stop
          </button>
        </div>
      </Card>

      <Card>
        <div className="flex flex-col gap-2 text-[12px] text-content-secondary">
          {captureStatus?.mic === 'active' && (
            <span className="flex items-center gap-1.5 text-content-success">
              <Mic size={13} strokeWidth={1.75} />
              Microphone capturing
            </span>
          )}
          {captureStatus?.mic === 'error' && (
            <span className="flex items-center gap-1.5 text-content-danger">
              <MicOff size={13} strokeWidth={1.75} />
              Microphone unavailable — check access in system settings.
            </span>
          )}
          {captureStatus?.mic === 'silent' && (
            <span className="flex items-center gap-1.5 text-content-danger">
              <MicOff size={13} strokeWidth={1.75} />
              Microphone appears silent — your voice is not being captured. Check your mic in
              Settings (Bluetooth headsets in calls are a common cause).
            </span>
          )}
          {session.source === 'online' && captureStatus?.loopback === 'active' && (
            <span className="flex items-center gap-1.5 text-content-success">
              <Volume2 size={13} strokeWidth={1.75} />
              System audio (loopback) capturing — silence notifications and media while
              recording.
            </span>
          )}
          {session.source === 'online' && captureStatus?.loopback === 'error' && (
            <span className="flex items-center gap-1.5 text-content-danger">
              <AlertTriangle size={13} strokeWidth={1.75} />
              System-audio loopback failed — remote participants are not being captured.
            </span>
          )}
          {captureStatus !== null && !captureStatus.recording && (
            <span className="flex items-center gap-1.5 text-content-danger">
              <AlertTriangle size={13} strokeWidth={1.75} />
              No audio is being captured — timer only. Upload a recording afterwards instead.
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
