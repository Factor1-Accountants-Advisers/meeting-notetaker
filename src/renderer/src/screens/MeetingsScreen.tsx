import { useState } from 'react'
import { ArrowUpDown, ChevronRight, CloudOff, Plus } from 'lucide-react'
import { Card } from '@renderer/components/ui/Card'
import { Pill } from '@renderer/components/ui/Pill'
import { AvatarStack } from '@renderer/components/ui/Avatar'
import { toneClasses } from '@renderer/components/ui/tones'
import { fetchMeetings } from '@renderer/lib/api'
import { useLive } from '@renderer/lib/useLive'
import { meetings as sampleMeetings, type Meeting, type MeetingStatus } from '@renderer/data/mock'

type Filter = 'All' | 'Drafts' | 'Finalized'
const FILTERS: Filter[] = ['All', 'Drafts', 'Finalized']

const filterToStatus: Record<Exclude<Filter, 'All'>, MeetingStatus> = {
  Drafts: 'Draft',
  Finalized: 'Finalized'
}

export function MeetingsScreen({
  onOpenMeeting
}: {
  onOpenMeeting: (id: string) => void
}): JSX.Element {
  const [filter, setFilter] = useState<Filter>('All')
  const { data: meetings, offline } = useLive(fetchMeetings, sampleMeetings)

  const visible =
    filter === 'All' ? meetings : meetings.filter((m) => m.status === filterToStatus[filter])
  const groups = (['Today', 'Earlier this week', 'Older'] as const)
    .map((g) => ({ name: g, items: visible.filter((m) => m.group === g) }))
    .filter((g) => g.items.length > 0)

  return (
    <div>
      <div className="mb-3.5 flex items-center justify-between">
        <h1 className="text-[22px] font-medium text-content-primary">
          Meetings{' '}
          <span className="text-[14px] font-normal text-content-tertiary">· {meetings.length}</span>
          {offline && (
            <span className="ml-2 inline-flex items-center gap-1 align-middle text-[12px] font-normal text-content-warning">
              <CloudOff size={13} strokeWidth={1.75} />
              sample data
            </span>
          )}
        </h1>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md border-[0.5px] border-edge-info bg-bg-info px-3.5 py-2 text-[13px] text-content-info transition-colors hover:opacity-90 active:scale-[0.99]"
        >
          <Plus size={15} strokeWidth={1.75} />
          New meeting
        </button>
      </div>

      <div className="mb-4 flex items-center justify-between">
        <div className="inline-flex rounded-md bg-bg-secondary p-[3px]">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded-[6px] px-3 py-1 text-[12px] transition-colors ${
                filter === f
                  ? 'bg-bg-primary font-medium text-content-info'
                  : 'text-content-secondary hover:text-content-primary'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="flex items-center gap-1 text-[12px] text-content-tertiary hover:text-content-secondary"
        >
          <ArrowUpDown size={14} strokeWidth={1.75} />
          Recent first
        </button>
      </div>

      {groups.map((group) => (
        <div key={group.name} className="mb-4">
          <div className="mb-1.5 text-[12px] font-medium text-content-tertiary">{group.name}</div>
          <Card className="!px-4 !py-1">
            {group.items.map((m, i) => (
              <MeetingRow key={m.id} meeting={m} divider={i > 0} onOpen={onOpenMeeting} />
            ))}
          </Card>
        </div>
      ))}

      {groups.length === 0 && (
        <Card className="py-10 text-center text-[13px] text-content-tertiary">
          No {filter.toLowerCase()} meetings.
        </Card>
      )}
    </div>
  )
}

function MeetingRow({
  meeting,
  divider,
  onOpen
}: {
  meeting: Meeting
  divider: boolean
  onOpen: (id: string) => void
}): JSX.Element {
  const Icon = meeting.icon
  const itemsLabel = `${meeting.actionItems} action item${meeting.actionItems === 1 ? '' : 's'}`

  return (
    <button
      type="button"
      onClick={() => onOpen(meeting.id)}
      className={`flex w-full items-center gap-2.5 py-[11px] text-left ${
        divider ? 'border-t-[0.5px] border-edge-tertiary' : ''
      }`}
    >
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${toneClasses[meeting.tone]}`}
      >
        <Icon size={16} strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium text-content-primary">{meeting.title}</div>
        <div className="truncate text-[11px] text-content-tertiary">
          {meeting.context} · {meeting.date} · {meeting.durationMin} min · {itemsLabel}
        </div>
      </div>
      {meeting.unknownSpeakers > 0 && (
        <Pill tone="danger">{`${meeting.unknownSpeakers} to name`}</Pill>
      )}
      <Pill tone={meeting.status === 'Draft' ? 'warning' : 'success'}>{meeting.status}</Pill>
      <AvatarStack people={meeting.attendees} max={2} />
      <ChevronRight size={16} strokeWidth={1.75} className="shrink-0 text-content-tertiary" />
    </button>
  )
}
