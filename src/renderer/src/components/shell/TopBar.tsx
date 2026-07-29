import { useEffect, useState } from 'react'
import { AudioLines, LoaderCircle, Settings } from 'lucide-react'

interface TopBarProps {
  settingsActive?: boolean
  recordingState?: 'idle' | 'recording' | 'processing'
  statusText?: string | null
  statusDetail?: string | null
  recordingStartedAt?: number | null
  recordingPausedAt?: number | null
  recordingPausedAccum?: number
  onOpenHome: () => void
  onOpenSettings: () => void
  onOpenRecording?: (() => void) | null
  userName?: string
}

export function TopBar({
  settingsActive = false,
  recordingState = 'idle',
  statusText,
  statusDetail,
  recordingStartedAt,
  recordingPausedAt = null,
  recordingPausedAccum = 0,
  onOpenHome,
  onOpenSettings,
  onOpenRecording,
  userName
}: TopBarProps): JSX.Element {
  const [now, setNow] = useState(Date.now())
  const initials = userName
    ? userName
        .split(' ')
        .map((part) => part[0])
        .filter(Boolean)
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : '?'
  const recording = recordingState === 'recording'
  const processing = recordingState === 'processing'
  const visibleStatus =
    statusText ?? (recording ? 'Recording' : processing ? 'Processing recording' : null)
  const recordingElapsed =
    recording && recordingStartedAt
      ? formatElapsed(
          (recordingPausedAt ?? now) - recordingStartedAt - recordingPausedAccum
        )
      : null

  useEffect(() => {
    if (!recording || recordingPausedAt !== null) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(id)
  }, [recording, recordingPausedAt])

  return (
    <header
      className="mn-topbar grid h-10 shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-edge-tertiary bg-[var(--color-background-chrome)] px-3"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <button
        type="button"
        onClick={onOpenHome}
        className="ui-control flex min-w-0 items-center gap-[7px] justify-self-start rounded-md pr-2 text-content-primary hover:text-content-info"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        aria-label="Go to home"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand-navy text-white">
          <AudioLines size={16} strokeWidth={1.75} />
        </span>
        <span className="mn-brand-label truncate text-[14px] font-medium">Meeting Notetaker</span>
      </button>

      {visibleStatus ? (
        <button
          type="button"
          disabled={!recording || !onOpenRecording}
          onClick={recording ? onOpenRecording ?? undefined : undefined}
          className={`ui-control flex min-w-0 max-w-full items-center justify-center gap-[7px] justify-self-center rounded-md px-2.5 py-1 text-[12px] ${
            recording
              ? 'bg-bg-warning text-content-primary hover:opacity-90'
              : 'text-content-secondary'
          } disabled:cursor-default`}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {recording ? (
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--color-button-stop)]" />
          ) : processing ? (
            <LoaderCircle
              size={14}
              strokeWidth={1.75}
              className="shrink-0 animate-spin motion-reduce:animate-none"
            />
          ) : null}
          <span className="min-w-0 truncate">
            {processing ? (
              <strong className="font-medium text-content-primary">{visibleStatus}</strong>
            ) : recording ? (
              <span className="mn-recording-label">{visibleStatus}</span>
            ) : (
              visibleStatus
            )}
            {processing && statusDetail ? (
              <span className="mn-processing-detail text-content-tertiary"> · {statusDetail}</span>
            ) : null}
          </span>
          {recordingElapsed ? (
            <strong className="shrink-0 font-medium tabular-nums">{recordingElapsed}</strong>
          ) : null}
        </button>
      ) : (
        <span />
      )}

      <div
        data-no-drag
        className="flex items-center gap-[7px] justify-self-end"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          type="button"
          title="Settings"
          aria-label="Open settings"
          aria-pressed={settingsActive}
          onClick={onOpenSettings}
          className={`ui-control flex h-8 w-8 items-center justify-center rounded-md ${
            settingsActive
              ? 'bg-bg-info text-content-info'
              : 'text-content-tertiary hover:bg-bg-tertiary hover:text-content-secondary'
          }`}
        >
          <Settings size={17} strokeWidth={1.75} />
        </button>
        <div
          className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-navy text-[11px] font-medium text-white"
          title={userName ?? 'Signed-in user'}
        >
          {initials}
        </div>
      </div>
    </header>
  )
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const hh = String(hours).padStart(2, '0')
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}
