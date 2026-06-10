import type { ReactNode } from 'react'
import type { ScreenId } from '@renderer/lib/nav'
import type { Theme } from '@renderer/lib/theme'
import { NavRail } from './NavRail'
import { TopBar } from './TopBar'

interface AppShellProps {
  active: ScreenId
  onSelect: (id: ScreenId) => void
  theme: Theme
  onToggleTheme: () => void
  children: ReactNode
}

export function AppShell({
  active,
  onSelect,
  theme,
  onToggleTheme,
  children
}: AppShellProps): JSX.Element {
  return (
    <div className="flex h-full flex-col bg-page text-content-primary">
      <TopBar theme={theme} onToggleTheme={onToggleTheme} />
      <div className="flex min-h-0 flex-1">
        <NavRail active={active} onSelect={onSelect} />
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[580px] px-[18px] py-[18px]">{children}</div>
        </main>
      </div>
    </div>
  )
}
