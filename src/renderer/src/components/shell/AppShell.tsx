import { useEffect, useRef, type ReactNode } from 'react'
import type { ScreenId } from '@renderer/lib/nav'
import { TopBar } from './TopBar'

interface AppShellProps {
  active: ScreenId | null
  onSelect: (id: ScreenId) => void
  recordingState?: 'idle' | 'recording' | 'processing'
  statusText?: string | null
  statusDetail?: string | null
  recordingStartedAt?: number | null
  recordingPausedAt?: number | null
  recordingPausedAccum?: number
  onOpenRecording?: (() => void) | null
  userName?: string
  children: ReactNode
}

export function AppShell({
  active,
  onSelect,
  recordingState = 'idle',
  statusText,
  statusDetail,
  recordingStartedAt,
  recordingPausedAt,
  recordingPausedAccum,
  onOpenRecording,
  userName,
  children
}: AppShellProps): JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const content = contentRef.current
    if (!content || typeof window.api?.setCompactWindowHeight !== 'function') return

    let frame = 0
    const syncWindowHeight = (): void => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const contentHeight = Math.ceil(content.getBoundingClientRect().height)
        window.api.setCompactWindowHeight(40 + 32 + contentHeight)
      })
    }
    const observer = new ResizeObserver(syncWindowHeight)
    observer.observe(content)
    syncWindowHeight()

    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(frame)
    }
  }, [])

  return (
    <div className="flex h-full flex-col bg-page text-content-primary">
      <TopBar
        settingsActive={active === 'settings'}
        recordingState={recordingState}
        statusText={statusText}
        statusDetail={statusDetail}
        recordingStartedAt={recordingStartedAt}
        recordingPausedAt={recordingPausedAt}
        recordingPausedAccum={recordingPausedAccum}
        onOpenHome={() => onSelect('home')}
        onOpenSettings={() => onSelect('settings')}
        onOpenRecording={onOpenRecording}
        userName={userName}
      />
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[652px] px-4 py-4 max-[400px]:px-3 max-[400px]:py-3">
          <div ref={contentRef} className="ui-enter my-auto w-full">
            {children}
          </div>
        </div>
      </main>
    </div>
  )
}
