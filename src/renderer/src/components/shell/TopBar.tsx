import { useState } from 'react'
import { Bell, Moon, Sun } from 'lucide-react'
import type { AppNotification } from '@renderer/lib/useNotifications'
import type { Theme } from '@renderer/lib/theme'

interface TopBarProps {
  theme: Theme
  onToggleTheme: () => void
  recordingState?: 'idle' | 'recording' | 'processing'
  /** Opens the active recording screen when one exists. */
  onOpenRecording?: (() => void) | null
  onOpenMeeting?: (id: string) => void
  notifications?: AppNotification[]
  unreadCount?: number
  onNotificationsOpened?: () => void
  userName?: string
}

export function TopBar({
  theme,
  onToggleTheme,
  recordingState = 'idle',
  onOpenRecording,
  onOpenMeeting,
  notifications = [],
  unreadCount = 0,
  onNotificationsOpened,
  userName
}: TopBarProps): JSX.Element {
  const [bellOpen, setBellOpen] = useState(false)
  const recordingActive = recordingState === 'recording' || recordingState === 'processing'
  const initials = userName
    ? userName
        .split(' ')
        .map(function (w) {
          return w[0]
        })
        .filter(Boolean)
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : '?'
  return (
    <header
      className="flex h-10 items-center gap-3 border-b border-edge-tertiary bg-bg-secondary px-3"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <span className="select-none text-[13px] font-medium text-content-secondary">
        Meeting Notetaker
      </span>

      <div
        className="ml-auto flex items-center gap-1"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {recordingActive && (
          <button
            type="button"
            onClick={onOpenRecording ?? undefined}
            title={recordingState === 'recording' ? 'Recording is active' : 'Recording is processing'}
            className="mr-1 flex items-center gap-1.5 rounded-md bg-bg-danger px-2.5 py-1 text-[11px] font-medium text-content-danger"
          >
            <span className={`h-2 w-2 rounded-full bg-edge-danger ${recordingState === 'recording' ? 'animate-pulse' : ''}`} />
            {recordingState === 'recording' ? 'Recording now' : 'Processing recording'}
          </button>
        )}
        <button
          type="button"
          title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          aria-label="Toggle theme"
          onClick={onToggleTheme}
          className="flex h-8 w-8 items-center justify-center rounded-md text-content-tertiary hover:bg-bg-tertiary hover:text-content-secondary"
        >
          {theme === 'dark' ? <Sun size={17} strokeWidth={1.75} /> : <Moon size={17} strokeWidth={1.75} />}
        </button>
        <div className="relative">
          <button
            type="button"
            title="Notifications"
            aria-label="Notifications"
            onClick={() => {
              const opening = !bellOpen
              setBellOpen(opening)
              if (opening) onNotificationsOpened?.()
            }}
            className="relative flex h-8 w-8 items-center justify-center rounded-md text-content-tertiary hover:bg-bg-tertiary hover:text-content-secondary"
          >
            <Bell size={17} strokeWidth={1.75} />
            {unreadCount > 0 && (
              <span className="absolute right-1 top-1 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-edge-danger px-0.5 text-[9px] font-medium text-white">
                {unreadCount}
              </span>
            )}
          </button>
          {bellOpen && (
            <div className="absolute right-0 top-9 z-50 max-h-[300px] w-[280px] overflow-y-auto rounded-md border-[0.5px] border-edge-secondary bg-bg-primary py-1">
              {notifications.length === 0 && (
                <div className="px-3 py-2 text-[12px] text-content-tertiary">
                  Nothing yet — pipeline events show here.
                </div>
              )}
              {notifications.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => {
                    setBellOpen(false)
                    onOpenMeeting?.(n.meetingId)
                  }}
                  className="block w-full px-3 py-1.5 text-left hover:bg-bg-secondary"
                >
                  <span className="block text-[12px] text-content-primary">{n.text}</span>
                  <span className="block text-[11px] text-content-tertiary">
                    {new Date(n.at).toLocaleTimeString('en-GB', {
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div
          className="ml-1 flex h-7 w-7 items-center justify-center rounded-full bg-brand-navy text-[11px] font-medium text-white"
          title={userName ?? 'Signed-in user'}
        >
          {initials}
        </div>
      </div>
    </header>
  )
}
