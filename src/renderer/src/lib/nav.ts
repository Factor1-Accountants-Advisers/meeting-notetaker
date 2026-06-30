import { LayoutGrid, Users, Settings, type LucideIcon } from 'lucide-react'

export type ScreenId = 'home' | 'people' | 'settings'

export interface NavEntry {
  id: ScreenId
  label: string
  icon: LucideIcon
  /** Settings is pinned to the bottom of the rail. */
  pinBottom?: boolean
}

export const NAV_ENTRIES: NavEntry[] = [
  { id: 'home', label: 'Home', icon: LayoutGrid },
  { id: 'people', label: 'People', icon: Users },
  { id: 'settings', label: 'Settings', icon: Settings, pinBottom: true }
]
