import { useMemo, useState } from 'react'
import {
  ArrowLeft,
  CheckCircle2,
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
  meetingDetails,
  meetings,
  staffNames,
  type Meeting
} from '@renderer/data/mock'

interface Props {
  meetingId: string
  onBack: () => void
}

export function MeetingReviewScreen({ meetingId, onBack }: Props): JSX.Element {
  const meeting = meetings.find((m) => m.id === meetingId)
  const detail = meetingDetails[meetingId]

  // Local review state; persisted via the backend later (with audit logging).
  const [names, setNames] = useState<Record<string, string>>({})
  const [finalized, setFinalized] = useState(meeting?.status === 'Finalized')

  const unknownLeft = useMemo(
    () =>
      detail
        ? detail.participants.filter((p) => p.unknown && !names[p.name]).length
        : 0,
    [detail, names]
  )

  if (!meeting || !detail) {
    return (
      <div>
        <BackLink onBack={onBack} />
        <Card className="py-10 text-center text-[13px] text-content-tertiary">
          Review data for this meeting is not available yet.
        </Card>
      </div>
    )
  }

  const resolve = (speaker: string): { label: string; known: boolean } => {
    const named = names[speaker]
    return named ? { label: named, known: true } : { label: speaker, known: false }
  }

  return (
    <div className="flex flex-col gap-4">
      <BackLink onBack={onBack} />
      <Header
        meeting={meeting}
        finalized={finalized}
        unknownLeft={unknownLeft}
        onFinalize={() => setFinalized(true)}
      />
      <ParticipantsCard detail={detail} names={names} onName={setNames} />
      <Card>
        <SectionHeader icon={Sparkles} title="Summary" meta="AI-generated" />
        <p className="m-0 text-[14px] leading-relaxed text-content-primary">{detail.summary}</p>
      </Card>
      <ActionItemsCard detail={detail} />
      <TranscriptCard detail={detail} names={names} onName={setNames} resolve={resolve} />
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
  meeting,
  finalized,
  unknownLeft,
  onFinalize
}: {
  meeting: Meeting
  finalized: boolean
  unknownLeft: number
  onFinalize: () => void
}): JSX.Element {
  const canFinalize = !finalized && unknownLeft === 0
  const sourceLabel = 'Online · loopback + mic'

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-[22px] font-medium text-content-primary">{meeting.title}</h1>
          <div className="mt-1 flex items-center gap-2 text-[12px] text-content-tertiary">
            <Pill tone={finalized ? 'success' : 'warning'}>
              {finalized ? 'Finalized' : 'Draft'}
            </Pill>
            {meeting.date} · {meeting.durationMin} min ·{' '}
            <span className="flex items-center gap-1">
              <Mic size={12} strokeWidth={1.75} />
              {sourceLabel}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            disabled={!canFinalize}
            onClick={onFinalize}
            title={
              finalized
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
            disabled={!finalized}
            title={finalized ? 'Email notes to participants' : 'Available after finalizing'}
            className="flex items-center gap-1.5 rounded-md border-[0.5px] border-edge-secondary px-3.5 py-2 text-[13px] text-content-primary transition-opacity hover:bg-bg-secondary disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Mail size={15} strokeWidth={1.75} />
            Email
          </button>
        </div>
      </div>
      {!finalized && unknownLeft > 0 && (
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
  detail,
  names,
  onName
}: {
  detail: NonNullable<(typeof meetingDetails)[string]>
  names: Record<string, string>
  onName: React.Dispatch<React.SetStateAction<Record<string, string>>>
}): JSX.Element {
  return (
    <Card>
      <SectionHeader icon={Users} title="Participants" />
      <div className="flex flex-wrap items-center gap-2">
        {detail.participants.map((p) => {
          const namedAs = names[p.name]
          if (p.unknown && !namedAs) {
            return (
              <span
                key={p.name}
                className="flex items-center gap-1.5 rounded-md bg-bg-danger py-0.5 pl-2 pr-1 text-[12px] font-medium text-content-danger"
              >
                <UserRoundSearch size={13} strokeWidth={1.75} />
                {p.name} — name them
                <NamePicker
                  unknownId={p.name}
                  onPick={(n) => onName((prev) => ({ ...prev, [p.name]: n }))}
                />
              </span>
            )
          }
          const label = namedAs ?? p.name
          return (
            <span
              key={p.name}
              className={`rounded-md px-2 py-0.5 text-[12px] font-medium ${
                namedAs ? toneClasses.success : toneClasses[p.tone]
              }`}
            >
              {label}
            </span>
          )
        })}
      </div>
    </Card>
  )
}

function ActionItemsCard({
  detail
}: {
  detail: NonNullable<(typeof meetingDetails)[string]>
}): JSX.Element {
  return (
    <Card>
      <SectionHeader icon={ListChecks} title="Action items" meta={`${detail.actionItems.length}`} />
      {detail.actionItems.map((a, i) => (
        <div
          key={a.id}
          className={`flex items-center gap-2.5 py-2.5 ${
            i > 0 ? 'border-t-[0.5px] border-edge-tertiary' : ''
          }`}
        >
          <div className="min-w-0 flex-1">
            <div className="text-[14px] text-content-primary">{a.description}</div>
            <div className="text-[11px] text-content-tertiary">
              Owner: Gerd ·{' '}
              <span className={a.overdue ? 'text-content-danger' : ''}>{a.dueLabel}</span>
            </div>
          </div>
          <Pill tone={priorityTone[a.priority]}>{a.priority}</Pill>
          <Pill tone={statusTone[a.status]}>{a.status}</Pill>
        </div>
      ))}
    </Card>
  )
}

function TranscriptCard({
  detail,
  names,
  onName,
  resolve
}: {
  detail: NonNullable<(typeof meetingDetails)[string]>
  names: Record<string, string>
  onName: React.Dispatch<React.SetStateAction<Record<string, string>>>
  resolve: (speaker: string) => { label: string; known: boolean }
}): JSX.Element {
  return (
    <Card>
      <SectionHeader icon={FileText} title="Transcript" />
      <div className="flex flex-col gap-3">
        {detail.transcript.map((seg) => {
          const { label, known } = seg.known
            ? { label: seg.speaker, known: true }
            : resolve(seg.speaker)
          return (
            <div
              key={seg.id}
              className={`rounded-md px-2.5 py-2 ${known ? '' : 'bg-bg-danger'}`}
            >
              <div className="mb-0.5 flex items-center gap-2">
                <span
                  className={`text-[12px] font-medium ${
                    known ? 'text-content-info' : 'text-content-danger'
                  }`}
                >
                  {label}
                </span>
                <span className="text-[11px] text-content-tertiary">{seg.time}</span>
                {!known && !names[seg.speaker] && (
                  <NamePicker
                    unknownId={seg.speaker}
                    onPick={(n) => onName((prev) => ({ ...prev, [seg.speaker]: n }))}
                  />
                )}
              </div>
              <p className="m-0 text-[14px] leading-relaxed text-content-primary">{seg.text}</p>
            </div>
          )
        })}
      </div>
    </Card>
  )
}
