import { toneClasses, type Tone } from './tones'

export interface Person {
  initials: string
  tone: Tone
}

export function Avatar({
  initials,
  tone,
  stacked = false
}: Person & { stacked?: boolean }): JSX.Element {
  return (
    <span
      className={`flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[10px] font-medium ${toneClasses[tone]} ${
        stacked ? 'border-[1.5px] border-bg-primary' : ''
      }`}
    >
      {initials}
    </span>
  )
}

/** Overlapping avatar row; collapses overflow into a +N chip. */
export function AvatarStack({ people, max = 2 }: { people: Person[]; max?: number }): JSX.Element {
  const shown = people.slice(0, max)
  const extra = people.length - shown.length

  return (
    <div className="flex shrink-0">
      {shown.map((p, i) => (
        <span key={p.initials + i} className={i > 0 ? '-ml-2' : ''}>
          <Avatar {...p} stacked />
        </span>
      ))}
      {extra > 0 && (
        <span className="-ml-2">
          <Avatar initials={`+${extra}`} tone="secondary" stacked />
        </span>
      )}
    </div>
  )
}
