import { useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Mic,
  Upload,
  Users,
  XCircle
} from 'lucide-react'
import { Card } from '@renderer/components/ui/Card'
import {
  AttendeePicker,
  type ManualAttendee
} from '@renderer/components/AttendeePicker'
import { staff as sampleStaff, type BlobStatus, type StaffMember } from '@renderer/data/mock'
import { fetchPeople } from '@renderer/lib/api'
import { useLive } from '@renderer/lib/useLive'

/** A recording interrupted by sleep/crash, recoverable from its spill file (IN-129). */
export interface InterruptedRecording {
  key: string
  title: string
  interruptedAtUtc: string
}

interface HomeProps {
  previewMode?: boolean
  onStartRecording: (title: string, attendees: ManualAttendee[]) => void
  onUploadRecording: (title: string, file: File, attendees: ManualAttendee[]) => void
  recordingState?: 'idle' | 'recording' | 'processing'
  interruptedRecordings?: InterruptedRecording[]
  onRecoverInterrupted?: (key: string) => void
  onDiscardInterrupted?: (key: string) => void
  postCaptureNotice?: {
    state: 'processing' | 'emailing' | 'ready' | 'upload_failed' | 'processing_failed' | 'email_failed'
    meetingId: string
    title: string
    message: string
  } | null
  onDismissPostCaptureNotice?: () => void
  onRetryPostCapture?: (meetingId: string, title: string) => void
  blobDeliveryNotices?: {
    status: BlobStatus
    meetingId: string
    title: string
    message: string
    retrying: boolean
  }[]
  onDismissBlobDeliveryNotice?: (meetingId: string) => void
  onRetryBlobDelivery?: (meetingId: string, title: string) => void
}

export function HomeScreen({
  previewMode = false,
  onStartRecording,
  onUploadRecording,
  recordingState,
  interruptedRecordings,
  onRecoverInterrupted,
  onDiscardInterrupted,
  postCaptureNotice,
  onDismissPostCaptureNotice,
  onRetryPostCapture,
  blobDeliveryNotices,
  onDismissBlobDeliveryNotice,
  onRetryBlobDelivery
}: HomeProps): JSX.Element {
  const { data: staff, offline } = useLive(
    previewMode ? async () => sampleStaff : fetchPeople,
    sampleStaff
  )

  return (
    <div className="flex flex-col gap-3">
      {interruptedRecordings?.map((entry) => (
        <InterruptedRecordingNotice
          key={entry.key}
          entry={entry}
          onRecover={onRecoverInterrupted}
          onDiscard={onDiscardInterrupted}
        />
      ))}
      {postCaptureNotice &&
        postCaptureNotice.state !== 'processing' &&
        postCaptureNotice.state !== 'emailing' && (
        <PostCaptureNotice
          notice={postCaptureNotice}
          onDismiss={onDismissPostCaptureNotice}
          onRetry={onRetryPostCapture}
        />
        )}
      {blobDeliveryNotices?.map((notice) => (
        <BlobDeliveryNoticeCard
          key={notice.meetingId}
          notice={notice}
          onDismiss={onDismissBlobDeliveryNotice}
          onRetry={onRetryBlobDelivery}
        />
      ))}
      <CaptureCard
        onStart={onStartRecording}
        onUpload={onUploadRecording}
        recordingActive={recordingState !== undefined && recordingState !== 'idle'}
        people={staff}
        directoryUnavailable={offline}
      />
    </div>
  )
}

function BlobDeliveryNoticeCard({
  notice,
  onDismiss,
  onRetry
}: {
  notice: NonNullable<HomeProps['blobDeliveryNotices']>[number]
  onDismiss?: (meetingId: string) => void
  onRetry?: (meetingId: string, title: string) => void
}): JSX.Element {
  const failed = notice.status === 'failed'
  const terminal = notice.status !== 'pending'
  const icon =
    notice.status === 'uploaded' ? (
      <CheckCircle2 size={16} strokeWidth={1.75} />
    ) : failed ? (
      <XCircle size={16} strokeWidth={1.75} />
    ) : (
      <Loader2 size={16} strokeWidth={1.75} />
    )
  const toneClass =
    notice.status === 'uploaded'
      ? '!border-edge-success !bg-bg-success text-content-success'
      : failed
        ? '!border-edge-danger !bg-bg-danger text-content-danger'
        : '!border-edge-info !bg-bg-info text-content-info'

  return (
    <Card className={`!rounded-md !px-3 !py-2.5 ${toneClass}`}>
      <div className="flex items-start gap-2">
        <div className="mt-0.5 shrink-0">{icon}</div>
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="min-w-0 flex-1"
        >
          <div className="truncate text-[13px] font-medium">{notice.title}</div>
          <div className="mt-0.5 text-[12px] opacity-90">{notice.message}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {(failed || notice.retrying) && onRetry && (
            <button
              type="button"
              disabled={notice.retrying}
              className="rounded-sm border-[0.5px] border-current px-2 py-1 text-[12px] opacity-85 hover:opacity-100 focus:border-brand-blue focus:outline-none disabled:cursor-not-allowed disabled:opacity-45"
              onClick={() => onRetry(notice.meetingId, notice.title)}
            >
              {notice.retrying ? 'Retrying…' : 'Retry upload'}
            </button>
          )}
          {terminal && onDismiss && (
            <button
              type="button"
              className="text-[12px] opacity-80 hover:opacity-100 focus:outline-none focus:ring-1 focus:ring-brand-blue"
              onClick={() => onDismiss(notice.meetingId)}
            >
              Dismiss
            </button>
          )}
        </div>
      </div>
    </Card>
  )
}

/** Offer recovery of a recording interrupted by lid-close/sleep/crash (IN-129). */
function InterruptedRecordingNotice({
  entry,
  onRecover,
  onDiscard
}: {
  entry: InterruptedRecording
  onRecover?: (key: string) => void
  onDiscard?: (key: string) => void
}): JSX.Element {
  const interruptedAt = new Date(entry.interruptedAtUtc)
  const when = Number.isNaN(interruptedAt.getTime())
    ? null
    : interruptedAt.toLocaleString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      })

  return (
    <div className="rounded-md border-[0.5px] border-edge-secondary bg-bg-warning px-3 py-2.5 text-content-warning">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 shrink-0" size={16} strokeWidth={1.75} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{entry.title}</div>
          <div className="mt-0.5 text-[12px] opacity-90">
            This recording was interrupted{when ? ` around ${when}` : ''} — likely by sleep or a
            closed laptop. The captured audio was saved and can still be transcribed.
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onRecover && (
            <button
              type="button"
              className="rounded-sm border-[0.5px] border-current px-2 py-1 text-[12px] opacity-85 hover:opacity-100"
              onClick={() => onRecover(entry.key)}
            >
              Upload for transcription
            </button>
          )}
          {onDiscard && (
            <button
              type="button"
              className="text-[12px] opacity-80 hover:opacity-100"
              onClick={() => onDiscard(entry.key)}
            >
              Discard
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function PostCaptureNotice({
  notice,
  onDismiss,
  onRetry
}: {
  notice: NonNullable<HomeProps['postCaptureNotice']>
  onDismiss?: () => void
  onRetry?: (meetingId: string, title: string) => void
}): JSX.Element {
  const failed = notice.state.endsWith('_failed')
  const icon =
    notice.state === 'ready' ? (
      <CheckCircle2 size={16} strokeWidth={1.75} />
    ) : failed ? (
      <XCircle size={16} strokeWidth={1.75} />
    ) : (
      <Loader2 className="animate-spin" size={16} strokeWidth={1.75} />
    )
  const toneClass =
    notice.state === 'ready'
      ? 'border-edge-success bg-bg-success text-content-success'
      : failed
        ? 'border-edge-danger bg-bg-danger text-content-danger'
        : 'border-edge-info bg-bg-info text-content-info'
  const actionLabel =
    notice.state === 'upload_failed'
      ? 'Retry upload'
      : notice.state === 'processing_failed'
        ? 'Check status'
        : notice.state === 'email_failed'
          ? 'Retry email'
          : null

  return (
    <div className={`rounded-md border-[0.5px] px-3 py-2.5 ${toneClass}`}>
      <div className="flex items-start gap-2">
        <div className="mt-0.5 shrink-0">{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{notice.title}</div>
          <div className="mt-0.5 text-[12px] opacity-90">{notice.message}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {actionLabel && onRetry && (
            <button
              type="button"
              className="rounded-sm border-[0.5px] border-current px-2 py-1 text-[12px] opacity-85 hover:opacity-100"
              onClick={() => onRetry(notice.meetingId, notice.title)}
            >
              {actionLabel}
            </button>
          )}
          {notice.state !== 'processing' && notice.state !== 'emailing' && onDismiss && (
            <button type="button" className="text-[12px] opacity-80 hover:opacity-100" onClick={onDismiss}>
              Dismiss
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function CaptureCard({
  onStart,
  onUpload,
  recordingActive = false,
  people,
  directoryUnavailable
}: {
  onStart: (title: string, attendees: ManualAttendee[]) => void
  onUpload: (title: string, file: File, attendees: ManualAttendee[]) => void
  /** Capture actions are disabled while a recording is active or finishing. */
  recordingActive?: boolean
  people: StaffMember[]
  directoryUnavailable: boolean
}): JSX.Element {
  const [title, setTitle] = useState('')
  const [attendees, setAttendees] = useState<ManualAttendee[]>([])
  const [attendeesOpen, setAttendeesOpen] = useState(false)
  const hasTitle = title.trim().length > 0
  const canUpload = hasTitle && !recordingActive

  return (
    <Card>
      <div className="mb-3.5 flex items-start justify-between gap-4">
        <div>
          <p className="mb-0.5 mt-0 text-[12px] text-content-tertiary">Manual capture</p>
          <h2 className="m-0 text-[20px] font-medium text-content-primary">New meeting</h2>
        </div>
        <Mic size={16} className="mt-0.5 text-content-secondary" aria-hidden="true" />
      </div>
      <label
        htmlFor="meeting-title"
        className="mb-1.5 block text-[14px] font-medium text-content-primary"
      >
        Meeting title
      </label>
      <input
        id="meeting-title"
        type="text"
        value={title}
        disabled={recordingActive}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="e.g. Tax compliance — Henderson & Co"
        className="ui-control h-7 w-full rounded-control border border-edge-tertiary bg-bg-secondary px-2 text-[14px] text-content-primary placeholder:text-content-tertiary focus:border-brand-blue focus:outline-none disabled:cursor-not-allowed disabled:opacity-45"
      />
      <button
        type="button"
        aria-expanded={attendeesOpen}
        onClick={() => setAttendeesOpen((open) => !open)}
        className="ui-control my-3 grid w-full grid-cols-[1fr_auto_auto] items-center gap-2.5 border-y border-edge-tertiary bg-transparent py-2.5 text-left text-[14px] text-content-primary max-[400px]:grid-cols-[1fr_auto]"
      >
        <span className="flex items-center gap-2">
          <Users size={16} aria-hidden="true" />
          Add attendees
        </span>
        <span className="mn-disclosure-detail text-[12px] text-content-tertiary">
          {attendees.length > 0 ? `${attendees.length} selected · optional` : 'Optional'}
        </span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={`text-content-tertiary transition-transform duration-150 ${
            attendeesOpen ? 'rotate-180' : ''
          }`}
        />
      </button>
      {attendeesOpen && (
        <div className="ui-enter">
          <AttendeePicker
            people={people}
            selected={attendees}
            onChange={setAttendees}
            disabled={recordingActive}
            directoryUnavailable={directoryUnavailable}
          />
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <label
          className={`ui-control flex min-h-7 items-center justify-center gap-1 rounded-control border border-edge-secondary bg-bg-secondary px-2 text-[14px] text-content-primary ${
            canUpload ? 'cursor-pointer hover:bg-bg-tertiary' : 'cursor-not-allowed opacity-45'
          }`}
          title={
            recordingActive
              ? 'Capture actions are unavailable while the current recording finishes'
              : hasTitle
                ? 'Upload an existing recording'
                : 'Enter a meeting name first'
          }
        >
          <Upload size={16} strokeWidth={1.75} />
          Upload recording
          <input
            type="file"
            accept="audio/*,video/webm"
            className="hidden"
            disabled={!canUpload}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) onUpload(title.trim(), file, attendees)
              e.target.value = ''
            }}
          />
        </label>
        <button
          type="button"
          disabled={!canUpload}
          onClick={() => onStart(title.trim(), attendees)}
          className="ui-control flex min-h-7 items-center justify-center gap-1 rounded-control border border-transparent bg-[var(--color-button-primary)] px-2 text-[14px] text-[var(--color-button-primary-text)] hover:bg-[var(--color-button-primary-hover)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Mic size={16} strokeWidth={1.75} />
          Start recording
        </button>
      </div>
    </Card>
  )
}
