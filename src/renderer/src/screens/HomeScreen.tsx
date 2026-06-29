import { useState } from 'react'
import { CheckCircle2, Loader2, Mic, Plus, UserPlus, XCircle } from 'lucide-react'
import { Card, SectionHeader } from '@renderer/components/ui/Card'

interface HomeProps {
  userName: string
  onStartCapture: (title: string, link: string | null, source: 'online' | 'in_person') => void
  onUploadRecording: (title: string, file: File) => void
  recordingState?: 'idle' | 'recording' | 'processing'
  postCaptureNotice?: {
    state: 'processing' | 'emailing' | 'ready' | 'failed'
    meetingId: string
    title: string
    message: string
  } | null
  onDismissPostCaptureNotice?: () => void
  onRetryPostCaptureEmail?: (meetingId: string, title: string) => void
}

export function HomeScreen({
  userName,
  onStartCapture,
  onUploadRecording,
  recordingState,
  postCaptureNotice,
  onDismissPostCaptureNotice,
  onRetryPostCaptureEmail
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
      {postCaptureNotice && (
        <PostCaptureNotice
          notice={postCaptureNotice}
          onDismiss={onDismissPostCaptureNotice}
          onRetryEmail={onRetryPostCaptureEmail}
        />
      )}
      <CaptureCard onStart={onStartCapture} onUpload={onUploadRecording} />
    </div>
  )
}

function PostCaptureNotice({
  notice,
  onDismiss,
  onRetryEmail
}: {
  notice: NonNullable<HomeProps['postCaptureNotice']>
  onDismiss?: () => void
  onRetryEmail?: (meetingId: string, title: string) => void
}): JSX.Element {
  const icon =
    notice.state === 'ready' ? (
      <CheckCircle2 size={16} strokeWidth={1.75} />
    ) : notice.state === 'failed' ? (
      <XCircle size={16} strokeWidth={1.75} />
    ) : (
      <Loader2 className="animate-spin" size={16} strokeWidth={1.75} />
    )
  const toneClass =
    notice.state === 'ready'
      ? 'border-edge-success bg-bg-success text-content-success'
      : notice.state === 'failed'
        ? 'border-edge-danger bg-bg-danger text-content-danger'
        : 'border-edge-info bg-bg-info text-content-info'

  return (
    <div className={`rounded-md border-[0.5px] px-3 py-2.5 ${toneClass}`}>
      <div className="flex items-start gap-2">
        <div className="mt-0.5 shrink-0">{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{notice.title}</div>
          <div className="mt-0.5 text-[12px] opacity-90">{notice.message}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {notice.state === 'failed' && onRetryEmail && (
            <button
              type="button"
              className="rounded-sm border-[0.5px] border-current px-2 py-1 text-[12px] opacity-85 hover:opacity-100"
              onClick={() => onRetryEmail(notice.meetingId, notice.title)}
            >
              Retry email
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
  onStart,
  onUpload
}: {
  onStart: (title: string, link: string | null, source: 'online' | 'in_person') => void
  onUpload: (title: string, file: File) => void
}): JSX.Element {
  const [title, setTitle] = useState('')
  const [link, setLink] = useState('')
  const [source, setSource] = useState<'online' | 'in_person'>('online')

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
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[12px] text-content-secondary">Audio</span>
        <div className="flex gap-0.5 rounded-md border-[0.5px] border-edge-tertiary bg-bg-secondary p-0.5">
          <button
            type="button"
            onClick={() => setSource('in_person')}
            className={
              'rounded px-2 py-1 text-[12px] transition-colors ' +
              (source === 'in_person'
                ? 'bg-bg-primary text-content-primary'
                : 'text-content-tertiary hover:text-content-secondary')
            }
          >
            Mic only
          </button>
          <button
            type="button"
            onClick={() => setSource('online')}
            className={
              'rounded px-2 py-1 text-[12px] transition-colors ' +
              (source === 'online'
                ? 'bg-bg-primary text-content-primary'
                : 'text-content-tertiary hover:text-content-secondary')
            }
          >
            Mic + System
          </button>
        </div>
      </div>
      <button
        type="button"
        disabled={title.trim().length === 0}
        onClick={() => onStart(title.trim(), link.trim() || null, source)}
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
