import type { LucideIcon } from 'lucide-react'

interface PlaceholderProps {
  icon: LucideIcon
  title: string
  note: string
}

/** Temporary screen body until the real screen is built. */
export function Placeholder({ icon: Icon, title, note }: PlaceholderProps): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-edge-tertiary bg-bg-primary px-6 py-16 text-center">
      <Icon size={28} strokeWidth={1.5} className="text-content-tertiary" />
      <h1 className="text-[22px] font-normal text-content-primary">{title}</h1>
      <p className="max-w-[360px] text-[13px] text-content-secondary">{note}</p>
    </div>
  )
}
