import { useState } from 'react'
import { Mic, Plus, UserPlus } from 'lucide-react'
import { Card, SectionHeader } from '@renderer/components/ui/Card'

interface HomeProps {
  userName: string
  onStartCapture: (title: string, link: string | null) => void
  onUploadRecording: (title: string, file: File) => void
  recordingState?: 'idle' | 'recording' | 'processing'
}

export function HomeScreen({
  userName,
  onStartCapture,
  onUploadRecording,
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
