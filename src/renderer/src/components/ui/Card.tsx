import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

export function Card({
  children,
  className = ''
}: {
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <section
      className={`rounded-lg border-[0.5px] border-edge-tertiary bg-bg-primary px-4 py-3.5 ${className}`}
    >
      {children}
    </section>
  )
}

/** 13px/500 card section header with a leading icon and an optional right slot. */
export function SectionHeader({
  icon: Icon,
  title,
  meta,
  right
}: {
  icon: LucideIcon
  title: string
  meta?: string
  right?: ReactNode
}): JSX.Element {
  return (
    <div className="mb-2.5 flex items-center justify-between text-[13px] font-medium text-content-primary">
      <span className="flex items-center gap-1.5">
        <Icon size={15} strokeWidth={1.75} />
        {title}
        {meta && <span className="font-normal text-content-tertiary">· {meta}</span>}
      </span>
      {right}
    </div>
  )
}
