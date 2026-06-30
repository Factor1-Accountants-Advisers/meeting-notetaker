import { useMemo, useState } from 'react'
import {
  ArrowUpDown,
  CheckCircle2,
  Circle,
  ChevronRight,
  CloudOff,
  UserRoundSearch
} from 'lucide-react'
import { Card } from '@renderer/components/ui/Card'
import { Pill, priorityTone, statusTone, type Priority } from '@renderer/components/ui/Pill'
import { fetchActionItems } from '@renderer/lib/api'
import { useLive } from '@renderer/lib/useLive'
import { allActionItems as sampleItems, type ActionItem } from '@renderer/data/mock'

type StatusFilter = 'All' | 'Open' | 'Overdue' | 'Done'
const STATUS_FILTERS: StatusFilter[] = ['All', 'Open', 'Overdue', 'Done']

interface Props {
  onOpenMeeting: (id: string) => void
}

export function ActionItemsScreen({ onOpenMeeting }: Props): JSX.Element {
  const [status, setStatus] = useState<StatusFilter>('All')
  const [owner, setOwner] = useState('All')
  const [priority, setPriority] = useState<'All' | Priority>('All')
  const [dueAsc, setDueAsc] = useState(true)
  const { data: allActionItems, offline } = useLive(fetchActionItems, sampleItems)
  const [done, setDone] = useState<Set<string> | null>(null)

  // Seed done-state once data arrives (live ids differ from sample ids).
  const doneSet = useMemo(
    () => done ?? new Set(allActionItems.filter((a) => a.status === 'Done').map((a) => a.id)),
    [done, allActionItems]
  )

  const owners = useMemo(
    () => [
      'All',
      ...Array.from(new Set(allActionItems.map((a) => a.owner ?? 'Unassigned')))
    ],
    [allActionItems]
  )

  const effectiveStatus = (a: ActionItem): StatusFilter =>
    doneSet.has(a.id) ? 'Done' : a.overdue ? 'Overdue' : 'Open'

  const visible = allActionItems
    .filter((a) => status === 'All' || effectiveStatus(a) === status)
    .filter((a) => owner === 'All' || (a.owner ?? 'Unassigned') === owner)
    .filter((a) => priority === 'All' || a.priority === priority)
    .sort((a, b) =>
      dueAsc ? a.dueISO.localeCompare(b.dueISO) : b.dueISO.localeCompare(a.dueISO)
    )

  const openCount = allActionItems.filter((a) => !doneSet.has(a.id)).length
  const overdueCount = allActionItems.filter((a) => a.overdue && !doneSet.has(a.id)).length

  return (
    <div>
      <div className="mb-3.5 flex items-center justify-between">
        <h1 className="text-[22px] font-medium text-content-primary">
          Action items{' '}
          <span className="text-[14px] font-normal text-content-tertiary">
            · {openCount} open
          </span>
          {offline && (
            <span className="ml-2 inline-flex items-center gap-1 align-middle text-[12px] font-normal text-content-warning">
              <CloudOff size={13} strokeWidth={1.75} />
              sample data
            </span>
          )}
        </h1>
        {overdueCount > 0 && <Pill tone="danger">{`${overdueCount} overdue`}</Pill>}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <div className="inline-flex rounded-md bg-bg-secondary p-[3px]">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setStatus(f)}
              className={`rounded-[6px] px-3 py-1 text-[12px] transition-colors ${
                status === f
                  ? 'bg-bg-primary font-medium text-content-info'
                  : 'text-content-secondary hover:text-content-primary'
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        <select
          value={owner}
          aria-label="Filter by owner"
          onChange={(e) => setOwner(e.target.value)}
          className="h-7 rounded-md border-[0.5px] border-edge-tertiary bg-bg-primary px-2 text-[12px] text-content-secondary focus:outline-none"
        >
          {owners.map((o) => (
            <option key={o} value={o}>
              {o === 'All' ? 'All owners' : o}
            </option>
          ))}
        </select>

        <select
          value={priority}
          aria-label="Filter by priority"
          onChange={(e) => setPriority(e.target.value as 'All' | Priority)}
          className="h-7 rounded-md border-[0.5px] border-edge-tertiary bg-bg-primary px-2 text-[12px] text-content-secondary focus:outline-none"
        >
          {(['All', 'High', 'Medium', 'Low'] as const).map((p) => (
            <option key={p} value={p}>
              {p === 'All' ? 'All priorities' : p}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => setDueAsc((v) => !v)}
          className="ml-auto flex items-center gap-1 text-[12px] text-content-tertiary hover:text-content-secondary"
        >
          <ArrowUpDown size={14} strokeWidth={1.75} />
          Due {dueAsc ? 'soonest' : 'latest'} first
        </button>
      </div>

      <Card className="!py-1">
        {visible.map((a, i) => (
          <ItemRow
            key={a.id}
            item={a}
            divider={i > 0}
            isDone={doneSet.has(a.id)}
            onToggle={() =>
              setDone(() => {
                const next = new Set(doneSet)
                if (next.has(a.id)) next.delete(a.id)
                else next.add(a.id)
                return next
              })
            }
            onOpenMeeting={onOpenMeeting}
          />
        ))}
        {visible.length === 0 && (
          <div className="py-9 text-center text-[13px] text-content-tertiary">
            No action items match these filters.
          </div>
        )}
      </Card>
    </div>
  )
}

function ItemRow({
  item,
  divider,
  isDone,
  onToggle,
  onOpenMeeting
}: {
  item: ActionItem
  divider: boolean
  isDone: boolean
  onToggle: () => void
  onOpenMeeting: (id: string) => void
}): JSX.Element {
  return (
    <div
      className={`flex items-center gap-2.5 py-2.5 ${
        divider ? 'border-t-[0.5px] border-edge-tertiary' : ''
      }`}
    >
      <button
        type="button"
        aria-label={isDone ? 'Mark as open' : 'Mark as done'}
        onClick={onToggle}
        className="shrink-0 text-content-tertiary hover:text-content-secondary"
      >
        {isDone ? (
          <CheckCircle2 size={18} strokeWidth={1.75} className="text-content-success" />
        ) : (
          <Circle size={18} strokeWidth={1.75} />
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div
          className={`text-[14px] ${
            isDone ? 'text-content-tertiary line-through' : 'text-content-primary'
          }`}
        >
          {item.description}
        </div>
        <div className="flex items-center gap-1 text-[11px] text-content-tertiary">
          {item.owner ? (
            item.owner
          ) : (
            <span className="flex items-center gap-1 text-content-danger">
              <UserRoundSearch size={11} strokeWidth={1.75} />
              Unassigned — unknown speaker
            </span>
          )}
          <span>
            · {item.sourceMeeting} ·{' '}
            <span className={item.overdue && !isDone ? 'text-content-danger' : ''}>
              {item.dueLabel}
            </span>
          </span>
        </div>
      </div>

      <Pill tone={priorityTone[item.priority]}>{item.priority}</Pill>
      <Pill tone={isDone ? statusTone.Done : item.overdue ? statusTone.Overdue : statusTone.Open}>
        {isDone ? 'Done' : item.overdue ? 'Overdue' : 'Open'}
      </Pill>

      {item.meetingId && (
        <button
          type="button"
          title={`Open ${item.sourceMeeting}`}
          aria-label={`Open ${item.sourceMeeting}`}
          onClick={() => onOpenMeeting(item.meetingId as string)}
          className="shrink-0 text-content-tertiary hover:text-content-secondary"
        >
          <ChevronRight size={16} strokeWidth={1.75} />
        </button>
      )}
    </div>
  )
}
