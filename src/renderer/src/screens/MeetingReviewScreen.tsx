import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  CheckCircle2,
  Circle,
  CloudOff,
  FileText,
  History,
  ListChecks,
  Mail,
  Mic,
  Pencil,
  Sparkles,
  UserRoundSearch,
  Users,
  Volume2
} from 'lucide-react'
import { Card, SectionHeader } from '@renderer/components/ui/Card'
import { Pill, priorityTone, statusTone } from '@renderer/components/ui/Pill'
import { toneClasses } from '@renderer/components/ui/tones'
import {
  audioUrl,
  editSegment,
  fetchAudit,
  fetchMeetingReview,
  finalizeMeeting,
  mapActionItem,
  nameSpeaker,
  patchActionItem,
  retryPipeline,
  toneFor,
  type AuditEntryDto,
  type MeetingReviewDto
} from '@renderer/lib/api'
import {
  meetingDetails,
  meetings,
  staffNames,
  type ActionItem,
  type PipelineStatus
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
  pipelineStatus: PipelineStatus
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
    pipelineStatus: dto.meeting.pipeline_status,
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
    pipelineStatus: meeting.pipelineStatus,
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
  const [audit, setAudit] = useState<AuditEntryDto[]>([])

  const inFlight = vm?.pipelineStatus === 'queued' || vm?.pipelineStatus === 'processing'

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void fetchMeetingReview(meetingId).then((dto) => {
        if (cancelled || !dto) return
        setVm(vmFromDto(dto))
        setLive(true)
      })
    }
    load()
    // Poll while the pipeline is running so the review fills in when ready.
    const id = inFlight ? window.setInterval(load, 2000) : undefined
    return () => {
      cancelled = true
      if (id !== undefined) window.clearInterval(id)
    }
  }, [meetingId, inFlight])

  const refreshAudit = (): void => {
    void fetchAudit(meetingId).then((entries) => entries && setAudit(entries))
  }

  useEffect(() => {
    if (live && vm?.pipelineStatus === 'ready') refreshAudit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, vm?.pipelineStatus, meetingId])

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
        refreshAudit()
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
        refreshAudit()
        return
      }
    }
    setVm((prev) => (prev ? { ...prev, finalized: true } : prev))
  }

  const handleRetry = async (): Promise<void> => {
    const dto = await retryPipeline(meetingId)
    if (dto)
      setVm((prev) => (prev ? { ...prev, pipelineStatus: dto.pipeline_status } : prev))
  }

  const handleEditSegment = async (index: number, text: string): Promise<void> => {
    if (live) {
      const dto = await editSegment(meetingId, index, text)
      if (dto) {
        setVm(vmFromDto(dto))
        refreshAudit()
        return
      }
    }
    setVm((prev) =>
      prev
        ? {
            ...prev,
            segments: prev.segments.map((s, i) => (i === index ? { ...s, text } : s))
          }
        : prev
    )
  }

  const handlePatchItem = async (
    item: ActionItem,
    changes: { owner?: string; status?: 'open' | 'done' }
  ): Promise<void> => {
    if (live) {
      const dto = await patchActionItem(item.id, changes)
      if (dto) {
        const mapped = mapActionItem(dto)
        setVm((prev) =>
          prev
            ? {
                ...prev,
                actionItems: prev.actionItems.map((a) => (a.id === item.id ? mapped : a))
              }
            : prev
        )
        refreshAudit()
        return
      }
    }
    setVm((prev) =>
      prev
        ? {
            ...prev,
            actionItems: prev.actionItems.map((a) =>
              a.id === item.id
                ? {
                    ...a,
                    owner: changes.owner ?? a.owner,
                    status:
                      changes.status === undefined
                        ? a.status
                        : changes.status === 'done'
                          ? 'Done'
                          : 'Open'
                  }
                : a
            )
          }
        : prev
    )
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
      {vm.pipelineStatus === 'queued' || vm.pipelineStatus === 'processing' ? (
        <PipelineCard status={vm.pipelineStatus} />
      ) : vm.pipelineStatus === 'failed' ? (
        <FailedCard onRetry={() => void handleRetry()} />
      ) : vm.pipelineStatus === 'pending_audio' ? (
        <Card className="py-8 text-center text-[13px] text-content-tertiary">
          No recording yet — start a capture or upload an audio file for this meeting.
        </Card>
      ) : (
        <>
          {live && <AudioCard meetingId={meetingId} />}
          <ParticipantsCard vm={vm} onName={handleName} />
          <Card>
            <SectionHeader icon={Sparkles} title="Summary" meta="AI-generated" />
            <p className="m-0 text-[14px] leading-relaxed text-content-primary">{vm.summary}</p>
          </Card>
          <ActionItemsCard items={vm.actionItems} onPatch={handlePatchItem} />
          <TranscriptCard vm={vm} onName={handleName} onEdit={handleEditSegment} />
          {audit.length > 0 && <HistoryCard entries={audit} />}
        </>
      )}
    </div>
  )
}

function PipelineCard({ status }: { status: 'queued' | 'processing' }): JSX.Element {
  return (
    <Card className="flex flex-col items-center gap-3 !py-10 text-center">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-edge-tertiary border-t-brand-blue" />
      <div className="text-[14px] text-content-primary">
        {status === 'queued' ? 'Waiting in the queue…' : 'Processing the recording…'}
      </div>
      <div className="max-w-[360px] text-[12px] text-content-tertiary">
        Transcribing, identifying speakers, and drafting the summary and action items. This
        page updates automatically.
      </div>
    </Card>
  )
}

function FailedCard({ onRetry }: { onRetry: () => void }): JSX.Element {
  return (
    <Card className="flex flex-col items-center gap-3 !py-10 text-center">
      <div className="text-[14px] text-content-danger">Processing failed.</div>
      <div className="max-w-[360px] text-[12px] text-content-tertiary">
        The recording is stored safely; processing can be retried at any time.
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="flex items-center gap-1.5 rounded-md border-[0.5px] border-edge-info bg-bg-info px-3.5 py-2 text-[13px] text-content-info"
      >
        Retry processing
      </button>
    </Card>
  )
}

function AudioCard({ meetingId }: { meetingId: string }): JSX.Element | null {
  const [available, setAvailable] = useState(true)
  if (!available) return null
  return (
    <Card>
      <SectionHeader icon={Volume2} title="Recording" meta="audio deleted after 30 days" />
      <audio
        controls
        preload="metadata"
        src={audioUrl(meetingId)}
        onError={() => setAvailable(false)}
        className="h-9 w-full"
      />
    </Card>
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
  const canFinalize = !vm.finalized && unknownLeft === 0 && vm.pipelineStatus === 'ready'

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
                : vm.pipelineStatus !== 'ready'
                  ? 'Available once processing completes'
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
      {!vm.finalized && unknownLeft > 0 && vm.pipelineStatus === 'ready' && (
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

function ActionItemsCard({
  items,
  onPatch
}: {
  items: ActionItem[]
  onPatch: (item: ActionItem, changes: { owner?: string; status?: 'open' | 'done' }) => void
}): JSX.Element {
  return (
    <Card>
      <SectionHeader icon={ListChecks} title="Action items" meta={`${items.length}`} />
      {items.map((a, i) => {
        const isDone = a.status === 'Done'
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
              onClick={() => onPatch(a, { status: isDone ? 'open' : 'done' })}
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
              <div className="flex items-center gap-1 text-[11px] text-content-tertiary">
                {a.owner ? (
                  <>Owner: {a.owner}</>
                ) : (
                  <span className="flex items-center gap-1 text-content-danger">
                    Unassigned
                    <select
                      defaultValue=""
                      aria-label={`Assign owner for ${a.description}`}
                      onChange={(e) => e.target.value && onPatch(a, { owner: e.target.value })}
                      className="h-5 rounded-md border-[0.5px] border-edge-danger bg-bg-danger px-1 text-[10px] font-medium text-content-danger focus:outline-none"
                    >
                      <option value="" disabled>
                        Assign…
                      </option>
                      {staffNames.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </span>
                )}
                <span>
                  · <span className={a.overdue && !isDone ? 'text-content-danger' : ''}>{a.dueLabel}</span>
                </span>
              </div>
            </div>
            <Pill tone={priorityTone[a.priority]}>{a.priority}</Pill>
            <Pill tone={statusTone[a.status]}>{a.status}</Pill>
          </div>
        )
      })}
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
  onName,
  onEdit
}: {
  vm: ReviewVm
  onName: (label: string, name: string) => void
  onEdit: (index: number, text: string) => void
}): JSX.Element {
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')

  return (
    <Card>
      <SectionHeader icon={FileText} title="Transcript" meta="edits are logged" />
      <div className="flex flex-col gap-3">
        {vm.segments.map((seg, index) => (
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
              {editing !== index && (
                <button
                  type="button"
                  title="Edit this segment"
                  aria-label={`Edit segment ${index + 1}`}
                  onClick={() => {
                    setEditing(index)
                    setDraft(seg.text)
                  }}
                  className="ml-auto text-content-tertiary hover:text-content-secondary"
                >
                  <Pencil size={13} strokeWidth={1.75} />
                </button>
              )}
            </div>
            {editing === index ? (
              <div>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={3}
                  className="w-full rounded-md border-[0.5px] border-edge-secondary bg-bg-primary p-2 text-[14px] leading-relaxed text-content-primary focus:border-brand-blue focus:outline-none"
                />
                <div className="mt-1.5 flex gap-2">
                  <button
                    type="button"
                    disabled={draft.trim().length === 0}
                    onClick={() => {
                      onEdit(index, draft.trim())
                      setEditing(null)
                    }}
                    className="rounded-md border-[0.5px] border-edge-info bg-bg-info px-2.5 py-1 text-[12px] text-content-info disabled:opacity-45"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    className="rounded-md border-[0.5px] border-edge-secondary px-2.5 py-1 text-[12px] text-content-primary hover:bg-bg-secondary"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <p className="m-0 text-[14px] leading-relaxed text-content-primary">{seg.text}</p>
            )}
          </div>
        ))}
      </div>
    </Card>
  )
}

function HistoryCard({ entries }: { entries: AuditEntryDto[] }): JSX.Element {
  return (
    <Card>
      <SectionHeader icon={History} title="History" meta={`${entries.length} change${entries.length === 1 ? '' : 's'}`} />
      <div className="flex flex-col">
        {entries.map((e, i) => (
          <div
            key={e.id}
            className={`py-2 text-[12px] ${i > 0 ? 'border-t-[0.5px] border-edge-tertiary' : ''}`}
          >
            <span className="text-content-primary">{e.actor}</span>{' '}
            <span className="text-content-secondary">{describeAudit(e)}</span>
            <span className="ml-2 text-[11px] text-content-tertiary">
              {new Date(e.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
            </span>
            {e.before && e.after && e.action === 'transcript.edit' && (
              <div className="mt-0.5 truncate text-[11px] text-content-tertiary">
                “{e.before}” → “{e.after}”
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  )
}

function describeAudit(e: AuditEntryDto): string {
  switch (e.action) {
    case 'transcript.edit':
      return `edited ${e.target}`
    case 'speaker.name':
      return `named ${e.before} as ${e.after}`
    case 'meeting.finalize':
      return 'finalized the meeting'
    default:
      if (e.action.startsWith('action_item.')) {
        const field = e.action.split('.')[1]
        return `changed ${field} of “${e.target}” to ${e.after ?? '—'}`
      }
      return `${e.action} on ${e.target}`
  }
}
