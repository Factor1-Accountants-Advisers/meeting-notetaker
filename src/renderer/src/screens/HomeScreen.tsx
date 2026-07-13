import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, Plus, Upload, XCircle } from 'lucide-react'
import { Card, SectionHeader } from '@renderer/components/ui/Card'

/** A recording interrupted by sleep/crash, recoverable from its spill file (IN-129). */
export interface InterruptedRecording {
  key: string
  title: string
  interruptedAtUtc: string
}

interface HomeProps {
  userName: string
  onUploadRecording: (title: string, file: File) => void
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
  onShowRecording?: () => void
}

export function HomeScreen({
  userName,
  onUploadRecording,
  recordingState,
  interruptedRecordings,
  onRecoverInterrupted,
  onDiscardInterrupted,
  postCaptureNotice,
  onDismissPostCaptureNotice,
  onRetryPostCapture,
  onShowRecording
}: HomeProps): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <Greeting userName={userName} />
      {interruptedRecordings?.map((entry) => (
        <InterruptedRecordingNotice
          key={entry.key}
          entry={entry}
          onRecover={onRecoverInterrupted}
          onDiscard={onDiscardInterrupted}
        />
      ))}
      {recordingState && recordingState !== 'idle' && (
        <div className="flex items-center gap-2 rounded-md border-[0.5px] border-edge-info bg-bg-info px-3 py-2 text-[13px] text-content-info">
          <span className={`h-2 w-2 rounded-full ${recordingState === 'recording' ? 'animate-pulse bg-edge-danger' : 'bg-edge-info'}`} />
          {recordingState === 'recording' ? 'Recording in progress' : 'Processing recording…'}
          {recordingState === 'recording' && onShowRecording && (
            <button
              type="button"
              onClick={onShowRecording}
              className="ml-auto rounded-md border-[0.5px] border-edge-info px-2.5 py-1 text-[12px] text-content-info hover:bg-bg-info"
            >
              Show
            </button>
          )}
        </div>
      )}
      {postCaptureNotice && (
        <PostCaptureNotice
          notice={postCaptureNotice}
          onDismiss={onDismissPostCaptureNotice}
          onRetry={onRetryPostCapture}
        />
      )}
      <CaptureCard
        onUpload={onUploadRecording}
        recordingActive={recordingState === 'recording'}
      />
    </div>
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
  onUpload,
  recordingActive = false
}: {
  onUpload: (title: string, file: File) => void
  /** Upload is disabled while an automatic recording is in progress. */
  recordingActive?: boolean
}): JSX.Element {
  const [title, setTitle] = useState('')
  const hasTitle = title.trim().length > 0
  const canUpload = hasTitle && !recordingActive

  return (
    <Card>
      <SectionHeader icon={Plus} title="Meeting Title" />
      <input
        type="text"
        value={title}
        disabled={recordingActive}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="e.g. Tax compliance — Henderson & Co"
        className="mb-3 h-9 w-full rounded-md border-[0.5px] border-edge-tertiary bg-bg-primary px-3 text-[14px] text-content-primary placeholder:text-content-tertiary focus:border-brand-blue focus:outline-none disabled:cursor-not-allowed disabled:opacity-45"
      />
      <div className="flex gap-2.5">
        <label
          className={`flex items-center justify-center gap-1.5 rounded-md border-[0.5px] border-edge-secondary px-4 py-2.5 text-[14px] text-content-primary ${
            canUpload ? 'cursor-pointer hover:bg-bg-secondary' : 'cursor-not-allowed opacity-45'
          }`}
          title={
            recordingActive
              ? 'Upload is unavailable while an automatic recording is in progress'
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
              if (file) onUpload(title.trim(), file)
              e.target.value = ''
            }}
          />
        </label>
      </div>
    </Card>
  )
}
