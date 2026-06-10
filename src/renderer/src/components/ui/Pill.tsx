import { toneClasses, type Tone } from './tones'

export function Pill({ tone, children }: { tone: Tone; children: string }): JSX.Element {
  return (
    <span
      className={`whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-medium ${toneClasses[tone]}`}
    >
      {children}
    </span>
  )
}

export type Priority = 'High' | 'Medium' | 'Low'
export type Status = 'Open' | 'Overdue' | 'Done'

export const priorityTone: Record<Priority, Tone> = {
  High: 'danger',
  Medium: 'warning',
  Low: 'secondary'
}

export const statusTone: Record<Status, Tone> = {
  Open: 'secondary',
  Overdue: 'danger',
  Done: 'success'
}
