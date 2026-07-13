import { LayoutGrid, Settings, type LucideIcon } from 'lucide-react'

export type ScreenId = 'home' | 'settings'

export interface NavEntry {
  id: ScreenId
  label: string
  icon: LucideIcon
  /** Settings is pinned to the bottom of the rail. */
  pinBottom?: boolean
}

export const NAV_ENTRIES: NavEntry[] = [
  { id: 'home', label: 'Home', icon: LayoutGrid },
  { id: 'settings', label: 'Settings', icon: Settings, pinBottom: true }
]
