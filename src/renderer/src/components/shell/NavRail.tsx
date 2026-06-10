import { NAV_ENTRIES, type ScreenId } from '@renderer/lib/nav'

interface NavRailProps {
  active: ScreenId | null
  onSelect: (id: ScreenId) => void
}

export function NavRail({ active, onSelect }: NavRailProps): JSX.Element {
  const top = NAV_ENTRIES.filter((e) => !e.pinBottom)
  const bottom = NAV_ENTRIES.filter((e) => e.pinBottom)

  return (
    <nav className="flex w-14 flex-col items-center justify-between border-r border-edge-tertiary bg-bg-tertiary py-3">
      <div className="flex flex-col items-center gap-1">
        {top.map((entry) => (
          <NavItem key={entry.id} entry={entry} active={active === entry.id} onSelect={onSelect} />
        ))}
      </div>
      <div className="flex flex-col items-center gap-1">
        {bottom.map((entry) => (
          <NavItem key={entry.id} entry={entry} active={active === entry.id} onSelect={onSelect} />
        ))}
      </div>
    </nav>
  )
}

function NavItem({
  entry,
  active,
  onSelect
}: {
  entry: (typeof NAV_ENTRIES)[number]
  active: boolean
  onSelect: (id: ScreenId) => void
}): JSX.Element {
  const Icon = entry.icon
  return (
    <button
      type="button"
      title={entry.label}
      aria-label={entry.label}
      aria-current={active ? 'page' : undefined}
      onClick={() => onSelect(entry.id)}
      className={`flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
        active
          ? 'bg-bg-info text-content-info'
          : 'text-content-tertiary hover:bg-bg-secondary hover:text-content-secondary'
      }`}
    >
      <Icon size={20} strokeWidth={1.75} />
    </button>
  )
}
