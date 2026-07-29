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
      className={`rounded-card bg-bg-primary p-3 ${className}`}
    >
      {children}
    </section>
  )
}

/** 14px/500 card section header with a leading icon and an optional right slot. */
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
    <div className="mb-2.5 flex items-center justify-between text-[14px] font-medium text-content-primary">
      <span className="flex items-center gap-1.5">
        <Icon size={15} strokeWidth={1.75} />
        {title}
        {meta && <span className="font-normal text-content-tertiary">· {meta}</span>}
      </span>
      {right}
    </div>
  )
}
