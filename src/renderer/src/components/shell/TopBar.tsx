import { useEffect, useRef, useState } from 'react'
import { Search, Bell, FileText, ListChecks, Moon, Sparkles, Sun } from 'lucide-react'
import { searchAll, type SearchResultDto } from '@renderer/lib/api'
import type { Theme } from '@renderer/lib/theme'

interface TopBarProps {
  theme: Theme
  onToggleTheme: () => void
  /** Set while a recording session is active and the user is on another screen. */
  onOpenRecording?: (() => void) | null
  onOpenMeeting?: (id: string) => void
}

const kindIcon = {
  meeting: FileText,
  summary: Sparkles,
  transcript: FileText,
  action_item: ListChecks
} as const

export function TopBar({
  theme,
  onToggleTheme,
  onOpenRecording,
  onOpenMeeting
}: TopBarProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResultDto[] | null>(null)
  const debounceRef = useRef<number>()

  useEffect(() => {
    window.clearTimeout(debounceRef.current)
    if (query.trim().length < 2) {
      setResults(null)
      return
    }
    debounceRef.current = window.setTimeout(() => {
      void searchAll(query.trim()).then((r) => setResults(r ?? []))
    }, 250)
    return () => window.clearTimeout(debounceRef.current)
  }, [query])

  const pick = (id: string): void => {
    setQuery('')
    setResults(null)
    onOpenMeeting?.(id)
  }
  return (
    <header
      className="flex h-10 items-center gap-3 border-b border-edge-tertiary bg-bg-secondary px-3"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <span className="select-none text-[13px] font-medium text-content-secondary">
        Meeting notetaker
      </span>

      <div
        className="relative ml-4 max-w-[320px] flex-1"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-2 rounded-md border border-edge-tertiary bg-bg-primary px-2.5">
          <Search size={15} className="text-content-tertiary" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search all meetings"
            className="h-7 w-full bg-transparent text-[13px] text-content-primary placeholder:text-content-tertiary focus:outline-none"
          />
        </div>
        {results !== null && (
          <div className="absolute left-0 right-0 top-9 z-50 max-h-[320px] overflow-y-auto rounded-md border-[0.5px] border-edge-secondary bg-bg-primary py-1">
            {results.length === 0 && (
              <div className="px-3 py-2 text-[12px] text-content-tertiary">No matches.</div>
            )}
            {results.map((r, i) => {
              const Icon = kindIcon[r.kind]
              return (
                <button
                  key={`${r.meeting_id}-${r.kind}-${i}`}
                  type="button"
                  onClick={() => pick(r.meeting_id)}
                  className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-bg-secondary"
                >
                  <Icon size={13} strokeWidth={1.75} className="mt-0.5 shrink-0 text-content-tertiary" />
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-medium text-content-primary">
                      {r.meeting_title}
                    </span>
                    <span className="block truncate text-[11px] text-content-tertiary">
                      {r.snippet}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div
        className="ml-auto flex items-center gap-1"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {onOpenRecording && (
          <button
            type="button"
            onClick={onOpenRecording}
            title="Return to recording"
            className="mr-1 flex items-center gap-1.5 rounded-md bg-bg-danger px-2.5 py-1 text-[11px] font-medium text-content-danger"
          >
            <span className="h-2 w-2 animate-pulse rounded-full bg-edge-danger" />
            Recording
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
        <button
          type="button"
          title="Notifications"
          aria-label="Notifications"
          className="flex h-8 w-8 items-center justify-center rounded-md text-content-tertiary hover:bg-bg-tertiary hover:text-content-secondary"
        >
          <Bell size={17} strokeWidth={1.75} />
        </button>
        <div
          className="ml-1 flex h-7 w-7 items-center justify-center rounded-full bg-brand-navy text-[11px] font-medium text-white"
          title="Gerd Guerrero"
        >
          GG
        </div>
      </div>
    </header>
  )
}
