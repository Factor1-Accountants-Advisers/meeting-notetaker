import { useState } from 'react'
import {
  AudioWaveform,
  Calendar,
  CheckCircle2,
  CheckSquare,
  Circle,
  Disc,
  Mic,
  Plus,
  UserPlus
} from 'lucide-react'
import { Card, SectionHeader } from '@renderer/components/ui/Card'
import { Pill, priorityTone, statusTone } from '@renderer/components/ui/Pill'
import { AvatarStack } from '@renderer/components/ui/Avatar'
import { toneClasses } from '@renderer/components/ui/tones'
import { fetchActionItems, fetchMeetings } from '@renderer/lib/api'
import { useLive } from '@renderer/lib/useLive'
import {
  upcomingMeetings,
  recordings as sampleRecordings,
  myActionItems as sampleMyItems,
  type Recording
} from '@renderer/data/mock'

interface HomeProps {
  userName: string
  onStartCapture: (title: string, link: string | null) => void
  onUploadRecording: (title: string, file: File) => void
  onOpenMeeting: (id: string) => void
  recordingState?: 'idle' | 'recording' | 'processing'
}

export function HomeScreen({
  userName,
  onStartCapture,
  onUploadRecording,
  onOpenMeeting,
  recordingState
}: HomeProps): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <Greeting userName={userName} />
      {recordingState && recordingState !== 'idle' && (
        <div className="flex items-center gap-2 rounded-md border-[0.5px] border-edge-info bg-bg-info px-3 py-2 text-[13px] text-content-info">
          <span className={`h-2 w-2 rounded-full ${recordingState === 'recording' ? 'animate-pulse bg-edge-danger' : 'bg-edge-info'}`} />
          {recordingState === 'recording' ? 'Auto-recording in progress' : 'Processing recording…'}
        </div>
      )}
      <CaptureCard onStart={onStartCapture} onUpload={onUploadRecording} />
      <div className="grid grid-cols-2 gap-3.5">
        <UpcomingCard />
        <RecordingsCard onOpenMeeting={onOpenMeeting} />
      </div>
      <ActionItemsCard userName={userName} />
    </div>
  )
}

function Greeting({ userName }: { userName: string }): JSX.Element {
  const now = new Date()
  const dateLine = now.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  })
  const hour = now.getHours()
  const daypart = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'

  const firstName = userName.split(' ')[0]
  return (
    <div>
      <div className="mb-0.5 text-[12px] text-content-tertiary">{dateLine}</div>
      <h1 className="text-[22px] font-medium text-content-primary">
        Good {daypart}, {firstName}
      </h1>
    </div>
  )
}

function CaptureCard({
  onStart,
  onUpload
}: {
  onStart: (title: string, link: string | null) => void
  onUpload: (title: string, file: File) => void
}): JSX.Element {
  const [title, setTitle] = useState('')
  const [link, setLink] = useState('')

  return (
    <Card>
      <SectionHeader
        icon={Plus}
        title="New meeting"
        right={
          <button
            type="button"
            className="flex items-center gap-1 text-[12px] font-normal text-content-info"
          >
            <UserPlus size={14} strokeWidth={1.75} />
            Invite team
          </button>
        }
      />
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Meeting name (e.g. Tax compliance — Henderson & Co)"
        className="mb-2.5 h-9 w-full rounded-md border-[0.5px] border-edge-tertiary bg-bg-primary px-3 text-[14px] text-content-primary placeholder:text-content-tertiary focus:border-brand-blue focus:outline-none"
      />
      <div className="mb-1.5 flex items-center gap-2 text-[12px] text-content-secondary">
        Meeting link
        <span className="flex gap-1.5 text-[11px] text-content-tertiary">Teams · Zoom · Meet</span>
        <span className="text-[11px] text-content-tertiary">· optional, auto-fills details</span>
      </div>
      <input
        type="text"
        value={link}
        onChange={(e) => setLink(e.target.value)}
        placeholder="https://"
        className="mb-3 h-9 w-full rounded-md border-[0.5px] border-edge-tertiary bg-bg-primary px-3 text-[14px] text-content-primary placeholder:text-content-tertiary focus:border-brand-blue focus:outline-none"
      />
      <button
        type="button"
        disabled={title.trim().length === 0}
        onClick={() => onStart(title.trim(), link.trim() || null)}
        className="flex w-full items-center justify-center gap-1.5 rounded-md border-[0.5px] border-edge-info bg-bg-info py-2.5 text-[14px] text-content-info transition-colors hover:opacity-90 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-45"
      >
        <Mic size={16} strokeWidth={1.75} />
        Start capturing
      </button>
      <div className="mt-2 text-center text-[12px] text-content-tertiary">
        or{' '}
        <label
          className={`text-content-info ${
            title.trim() ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
          }`}
          title={title.trim() ? 'Upload an existing recording' : 'Enter a meeting name first'}
        >
          upload a recording
          <input
            type="file"
            accept="audio/*,video/webm"
            className="hidden"
            disabled={title.trim().length === 0}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) onUpload(title.trim(), file)
              e.target.value = ''
            }}
          />
        </label>{' '}
        for this meeting
      </div>
    </Card>
  )
}

function UpcomingCard(): JSX.Element {
  // Monday-anchored five-day strip for the current week.
  const today = new Date()
  const monday = new Date(today)
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7))
  const days = Array.from({ length: 5 }, (_, i) => {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    return d
  })

  return (
    <Card>
      <SectionHeader icon={Calendar} title="Upcoming meetings" />
      <div className="mb-3 flex justify-between gap-[3px]">
        {days.map((d) => {
          const isToday = d.toDateString() === today.toDateString()
          return (
            <div
              key={d.toISOString()}
              className={`flex-1 rounded-md py-1.5 text-center ${isToday ? 'bg-bg-info' : ''}`}
            >
              <div
                className={`text-[10px] ${isToday ? 'text-content-info' : 'text-content-tertiary'}`}
              >
                {d.toLocaleDateString('en-GB', { weekday: 'short' })}
              </div>
              <div
                className={`text-[14px] ${
                  isToday ? 'font-medium text-content-info' : 'text-content-secondary'
                }`}
              >
                {d.getDate()}
              </div>
            </div>
          )
        })}
      </div>
      {upcomingMeetings.map((m, i) => {
        const Icon = m.icon
        return (
          <div
            key={m.id}
            className={`flex items-center gap-2.5 border-t-[0.5px] border-edge-tertiary py-2 ${
              i === upcomingMeetings.length - 1 ? 'pb-0' : ''
            }`}
          >
            <span
              className={`flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md ${toneClasses[m.tone]}`}
            >
              <Icon size={15} strokeWidth={1.75} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] text-content-primary">{m.title}</div>
              <div className="text-[11px] text-content-tertiary">{m.time}</div>
            </div>
            <AvatarStack people={m.attendees} max={2} />
          </div>
        )
      })}
    </Card>
  )
}

function RecordingsCard({ onOpenMeeting }: { onOpenMeeting: (id: string) => void }): JSX.Element {
  // Processed meetings double as the recordings list (audio-first tiles, §5.1).
  const { data: tiles, offline } = useLive(async (): Promise<Recording[] | null> => {
    const live = await fetchMeetings()
    if (!live) return null
    return live
      .filter((m) => m.pipelineStatus === 'ready' && m.durationMin > 0)
      .slice(0, 4)
      .map((m) => ({
        id: m.id,
        title: m.title,
        date: m.date,
        durationLabel: `${m.durationMin} min`,
        durationBadge: `${m.durationMin}:00`
      }))
  }, sampleRecordings)

  return (
    <Card>
      <SectionHeader
        icon={Disc}
        title="Recordings"
        right={
          <button type="button" className="text-[12px] font-normal text-content-info">
            View all
          </button>
        }
      />
      <div className="grid grid-cols-2 gap-2.5">
        {tiles.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => !offline && onOpenMeeting(r.id)}
            className="text-left"
            title={offline ? undefined : `Open ${r.title}`}
          >
            <div className="relative mb-1.5 flex aspect-[16/10] items-center justify-center rounded-md bg-bg-tertiary">
              <AudioWaveform size={22} strokeWidth={1.5} className="text-content-tertiary" />
              <span className="absolute bottom-1 right-1 rounded bg-bg-primary px-1 py-px text-[10px] text-content-secondary">
                {r.durationBadge}
              </span>
            </div>
            <div className="truncate text-[12px] font-medium text-content-primary">{r.title}</div>
            <div className="text-[11px] text-content-tertiary">
              {r.date} · {r.durationLabel}
            </div>
          </button>
        ))}
        {tiles.length === 0 && (
          <div className="col-span-2 py-6 text-center text-[12px] text-content-tertiary">
            Processed recordings appear here.
          </div>
        )}
      </div>
    </Card>
  )
}

function ActionItemsCard({ userName }: { userName: string }): JSX.Element {
  const { data: myActionItems } = useLive(
    async () => {
      const all = await fetchActionItems()
      return all ? all.filter((a) => a.owner === userName && a.status !== 'Done') : null
    },
    sampleMyItems
  )
  const [done, setDone] = useState<Set<string>>(new Set())
  const open = myActionItems.filter((a) => !done.has(a.id))
  const overdueCount = open.filter((a) => a.overdue).length

  return (
    <Card>
      <SectionHeader
        icon={CheckSquare}
        title="Your action items"
        meta={`${open.length} open`}
        right={overdueCount > 0 ? <Pill tone="danger">{`${overdueCount} overdue`}</Pill> : undefined}
      />
      {myActionItems.map((a, i) => {
        const isDone = done.has(a.id)
        return (
          <div
            key={a.id}
            className={`flex items-center gap-2.5 py-2.5 ${
              i > 0 ? 'border-t-[0.5px] border-edge-tertiary' : ''
            }`}
          >
            <button
              type="button"
              aria-label={isDone ? 'Mark as open' : 'Mark as done'}
              onClick={() =>
                setDone((prev) => {
                  const next = new Set(prev)
                  if (next.has(a.id)) next.delete(a.id)
                  else next.add(a.id)
                  return next
                })
              }
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
                {a.description}
              </div>
              <div className="text-[11px] text-content-tertiary">
                {a.sourceMeeting} ·{' '}
                <span className={a.overdue && !isDone ? 'text-content-danger' : ''}>
                  {a.dueLabel}
                </span>
              </div>
            </div>
            <Pill tone={priorityTone[a.priority]}>{a.priority}</Pill>
            <Pill tone={isDone ? statusTone.Done : statusTone[a.status]}>
              {isDone ? 'Done' : a.status}
            </Pill>
          </div>
        )
      })}
    </Card>
  )
}
