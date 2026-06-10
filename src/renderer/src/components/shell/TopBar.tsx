import { Search, Bell, Moon, Sun } from 'lucide-react'
import type { Theme } from '@renderer/lib/theme'

interface TopBarProps {
  theme: Theme
  onToggleTheme: () => void
}

export function TopBar({ theme, onToggleTheme }: TopBarProps): JSX.Element {
  return (
    <header
      className="flex h-10 items-center gap-3 border-b border-edge-tertiary bg-bg-secondary px-3"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <span className="select-none text-[13px] font-medium text-content-secondary">
        Meeting notetaker
      </span>

      <div
        className="ml-4 flex max-w-[320px] flex-1 items-center gap-2 rounded-md border border-edge-tertiary bg-bg-primary px-2.5"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <Search size={15} className="text-content-tertiary" />
        <input
          type="search"
          placeholder="Search all meetings"
          className="h-7 w-full bg-transparent text-[13px] text-content-primary placeholder:text-content-tertiary focus:outline-none"
        />
      </div>

      <div
        className="ml-auto flex items-center gap-1"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
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
