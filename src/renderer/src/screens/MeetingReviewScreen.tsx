import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  CheckCircle2,
  CloudOff,
  FileText,
  ListChecks,
  Mail,
  Mic,
  Sparkles,
  UserRoundSearch,
  Users
} from 'lucide-react'
import { Card, SectionHeader } from '@renderer/components/ui/Card'
import { Pill, priorityTone, statusTone } from '@renderer/components/ui/Pill'
import { toneClasses } from '@renderer/components/ui/tones'
import {
  fetchMeetingReview,
  finalizeMeeting,
  mapActionItem,
  nameSpeaker,
  toneFor,
  type MeetingReviewDto
} from '@renderer/lib/api'
import {
  meetingDetails,
  meetings,
  staffNames,
  type ActionItem
} from '@renderer/data/mock'
import type { Tone } from '@renderer/components/ui/tones'

// ---------------------------------------------------------------------------
// View model: one shape whether data comes from the backend or sample data.
// ---------------------------------------------------------------------------

interface ReviewVm {
  title: string
  date: string
  durationMin: number
  finalized: boolean
  summary: string
  participants: { name: string; known: boolean; tone: Tone }[]
  segments: { id: string; speaker: string; known: boolean; time: string; text: string }[]
  actionItems: ActionItem[]
}

function msToClock(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function vmFromDto(dto: MeetingReviewDto): ReviewVm {
  return {
    title: dto.meeting.title,
    date: new Date(dto.meeting.created_at).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short'
    }),
    durationMin: Math.round((dto.meeting.duration_seconds ?? 0) / 60),
    finalized: dto.meeting.status === 'finalized',
    summary: dto.summary_text ?? '',
    participants: dto.participants.map((p) => ({
      name: p.name,
      known: p.known,
      tone: p.known ? toneFor(p.name) : 'danger'
    })),
    segments: dto.segments.map((s, i) => ({
      id: `s${i}`,
      speaker: s.speaker,
      known: s.speaker_known,
      time: msToClock(s.start_ms),
      text: s.text
    })),
    actionItems: dto.action_items.map(mapActionItem)
  }
}

function vmFromSample(meetingId: string): ReviewVm | null {
  const meeting = meetings.find((m) => m.id === meetingId)
  const detail = meetingDetails[meetingId]
  if (!meeting || !detail) return null
  return {
    title: meeting.title,
    date: meeting.date,
    durationMin: meeting.durationMin,
    finalized: meeting.status === 'Finalized',
    summary: detail.summary,
    participants: detail.participants.map((p) => ({
      name: p.name,
      known: !p.unknown,
      tone: p.tone
    })),
    segments: detail.transcript.map((t) => ({
      id: t.id,
      speaker: t.speaker,
      known: t.known,
      time: t.time,
      text: t.text
    })),
    actionItems: detail.actionItems
  }
}

/** Apply a local (offline) naming to the view model. */
function applyLocalName(vm: ReviewVm, label: string, name: string): ReviewVm {
  return {
    ...vm,
    participants: vm.participants.map((p) =>
      p.name === label ? { name, known: true, tone: toneFor(name) } : p
    ),
    segments: vm.segments.map((s) => (s.speaker === label ? { ...s, speaker: name, known: true } : s))
  }
}

interface Props {
  meetingId: string
  onBack: () => void
}

export function MeetingReviewScreen({ meetingId, onBack }: Props): JSX.Element {
  const [vm, setVm] = useState<ReviewVm | null>(() => vmFromSample(meetingId))
  const [live, setLive] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchMeetingReview(meetingId).then((dto) => {
      if (cancelled || !dto) return
      setVm(vmFromDto(dto))
      setLive(true)
    })
    return () => {
      cancelled = true
    }
  }, [meetingId])

  const unknownLeft = useMemo(
    () => (vm ? vm.participants.filter((p) => !p.known).length : 0),
    [vm]
  )

  if (!vm) {
    return (
      <div>
        <BackLink onBack={onBack} />
        <Card className="mt-3 py-10 text-center text-[13px] text-content-tertiary">
          Review data for this meeting is not available yet.
        </Card>
      </div>
    )
  }

  const handleName = async (label: string, name: string): Promise<void> => {
    if (live) {
      const dto = await nameSpeaker(meetingId, label, name)
      if (dto) {
        setVm(vmFromDto(dto))
        return
      }
    }
    setVm((prev) => (prev ? applyLocalName(prev, label, name) : prev))
  }

  const handleFinalize = async (): Promise<void> => {
    if (live) {
      const dto = await finalizeMeeting(meetingId)
      if (dto) {
        setVm((prev) => (prev ? { ...prev, finalized: dto.status === 'finalized' } : prev))
        return
      }
    }
    setVm((prev) => (prev ? { ...prev, finalized: true } : prev))
  }

  return (
    <div className="flex flex-col gap-4">
      <BackLink onBack={onBack} />
      <Header
        vm={vm}
        live={live}
        unknownLeft={unknownLeft}
        onFinalize={() => void handleFinalize()}
      />
      <ParticipantsCard vm={vm} onName={handleName} />
      <Card>
        <SectionHeader icon={Sparkles} title="Summary" meta="AI-generated" />
        <p className="m-0 text-[14px] leading-relaxed text-content-primary">{vm.summary}</p>
      </Card>
      <ActionItemsCard items={vm.actionItems} />
      <TranscriptCard vm={vm} onName={handleName} />
    </div>
  )
}

function BackLink({ onBack }: { onBack: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onBack}
      className="flex w-fit items-center gap-1 text-[12px] text-content-tertiary hover:text-content-secondary"
    >
      <ArrowLeft size={14} strokeWidth={1.75} />
      All meetings
    </button>
  )
}

function Header({
  vm,
  live,
  unknownLeft,
  onFinalize
}: {
  vm: ReviewVm
  live: boolean
  unknownLeft: number
  onFinalize: () => void
}): JSX.Element {
  const canFinalize = !vm.finalized && unknownLeft === 0

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-[22px] font-medium text-content-primary">{vm.title}</h1>
          <div className="mt-1 flex items-center gap-2 text-[12px] text-content-tertiary">
            <Pill tone={vm.finalized ? 'success' : 'warning'}>
              {vm.finalized ? 'Finalized' : 'Draft'}
            </Pill>
            {vm.date} · {vm.durationMin} min ·{' '}
            <span className="flex items-center gap-1">
              <Mic size={12} strokeWidth={1.75} />
              Online · loopback + mic
            </span>
            {!live && (
              <span className="flex items-center gap-1 text-content-warning">
                <CloudOff size={12} strokeWidth={1.75} />
                sample data
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            disabled={!canFinalize}
            onClick={onFinalize}
            title={
              vm.finalized
                ? 'Already finalized'
                : unknownLeft > 0
                  ? `${unknownLeft} unknown speaker(s) must be named first`
                  : 'Finalize meeting notes'
            }
            className="flex items-center gap-1.5 rounded-md border-[0.5px] border-edge-info bg-bg-info px-3.5 py-2 text-[13px] text-content-info transition-opacity disabled:cursor-not-allowed disabled:opacity-45"
          >
            <CheckCircle2 size={15} strokeWidth={1.75} />
            Finalize
          </button>
          <button
            type="button"
            disabled={!vm.finalized}
            title={vm.finalized ? 'Email notes to participants' : 'Available after finalizing'}
            className="flex items-center gap-1.5 rounded-md border-[0.5px] border-edge-secondary px-3.5 py-2 text-[13px] text-content-primary transition-opacity hover:bg-bg-secondary disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Mail size={15} strokeWidth={1.75} />
            Email
          </button>
        </div>
      </div>
      {!vm.finalized && unknownLeft > 0 && (
        <div className="mt-2 text-[12px] text-content-danger">
          {unknownLeft} unknown speaker{unknownLeft > 1 ? 's' : ''} must be named before finalizing.
        </div>
      )}
    </div>
  )
}

function NamePicker({
  unknownId,
  onPick
}: {
  unknownId: string
  onPick: (name: string) => void
}): JSX.Element {
  return (
    <select
      defaultValue=""
      aria-label={`Name ${unknownId}`}
      onChange={(e) => e.target.value && onPick(e.target.value)}
      className="h-6 rounded-md border-[0.5px] border-edge-danger bg-bg-danger px-1 text-[11px] font-medium text-content-danger focus:outline-none"
    >
      <option value="" disabled>
        Name…
      </option>
      {staffNames.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  )
}

function ParticipantsCard({
  vm,
  onName
}: {
  vm: ReviewVm
  onName: (label: string, name: string) => void
}): JSX.Element {
  return (
    <Card>
      <SectionHeader icon={Users} title="Participants" />
      <div className="flex flex-wrap items-center gap-2">
        {vm.participants.map((p) =>
          p.known ? (
            <span
              key={p.name}
              className={`rounded-md px-2 py-0.5 text-[12px] font-medium ${toneClasses[p.tone]}`}
            >
              {p.name}
            </span>
          ) : (
            <span
              key={p.name}
              className="flex items-center gap-1.5 rounded-md bg-bg-danger py-0.5 pl-2 pr-1 text-[12px] font-medium text-content-danger"
            >
              <UserRoundSearch size={13} strokeWidth={1.75} />
              {p.name} — name them
              <NamePicker unknownId={p.name} onPick={(n) => onName(p.name, n)} />
            </span>
          )
        )}
      </div>
    </Card>
  )
}

function ActionItemsCard({ items }: { items: ActionItem[] }): JSX.Element {
  return (
    <Card>
      <SectionHeader icon={ListChecks} title="Action items" meta={`${items.length}`} />
      {items.map((a, i) => (
        <div
          key={a.id}
          className={`flex items-center gap-2.5 py-2.5 ${
            i > 0 ? 'border-t-[0.5px] border-edge-tertiary' : ''
          }`}
        >
          <div className="min-w-0 flex-1">
            <div className="text-[14px] text-content-primary">{a.description}</div>
            <div className="text-[11px] text-content-tertiary">
              {a.owner ? (
                <>Owner: {a.owner}</>
              ) : (
                <span className="text-content-danger">Unassigned — unknown speaker</span>
              )}{' '}
              · <span className={a.overdue ? 'text-content-danger' : ''}>{a.dueLabel}</span>
            </div>
          </div>
          <Pill tone={priorityTone[a.priority]}>{a.priority}</Pill>
          <Pill tone={statusTone[a.status]}>{a.status}</Pill>
        </div>
      ))}
      {items.length === 0 && (
        <div className="py-4 text-center text-[12px] text-content-tertiary">
          No action items for this meeting.
        </div>
      )}
    </Card>
  )
}

function TranscriptCard({
  vm,
  onName
}: {
  vm: ReviewVm
  onName: (label: string, name: string) => void
}): JSX.Element {
  return (
    <Card>
      <SectionHeader icon={FileText} title="Transcript" />
      <div className="flex flex-col gap-3">
        {vm.segments.map((seg) => (
          <div key={seg.id} className={`rounded-md px-2.5 py-2 ${seg.known ? '' : 'bg-bg-danger'}`}>
            <div className="mb-0.5 flex items-center gap-2">
              <span
                className={`text-[12px] font-medium ${
                  seg.known ? 'text-content-info' : 'text-content-danger'
                }`}
              >
                {seg.speaker}
              </span>
              <span className="text-[11px] text-content-tertiary">{seg.time}</span>
              {!seg.known && (
                <NamePicker unknownId={seg.speaker} onPick={(n) => onName(seg.speaker, n)} />
              )}
            </div>
            <p className="m-0 text-[14px] leading-relaxed text-content-primary">{seg.text}</p>
          </div>
        ))}
      </div>
    </Card>
  )
}
