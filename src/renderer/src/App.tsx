import { useEffect, useRef, useState } from 'react'
import { AppShell } from './components/shell/AppShell'
import { HomeScreen } from './screens/HomeScreen'
import { PeopleScreen } from './screens/PeopleScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { LoginScreen, type User } from './screens/LoginScreen'
import { RecordingScreen, type RecordingSession } from './screens/RecordingScreen'
import { createMeeting, emailNotes, fetchMeetingReview, uploadAudio, type GraphMeetingMetadata } from './lib/api'
import { capture, type CaptureStatus } from './lib/capture'
import { loadPrefs } from './lib/prefs'
import { useNotifications } from './lib/useNotifications'
import { audioDurationSeconds, blobToBase64 } from './lib/recorder'
import { elapsedMs } from './screens/RecordingScreen'
import { useTheme } from './lib/theme'
import type { ScreenId } from './lib/nav'

const USER_KEY = 'mn.user'

function loadUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? (JSON.parse(raw) as User) : null
  } catch {
    return null
  }
}

type View = ScreenId | 'recording'

type PostCaptureNotice = {
  state: 'processing' | 'emailing' | 'ready' | 'failed'
  meetingId: string
  title: string
  message: string
} | null

function App(): JSX.Element {
  const [user, setUser] = useState<User | null>(loadUser)
  const [view, setView] = useState<View>('home')
  const [recording, setRecording] = useState<RecordingSession | null>(null)
  const recordingRef = useRef<RecordingSession | null>(null)
  const autoGraphMetadataRef = useRef<GraphMeetingMetadata | null>(null)
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus | null>(null)
  const [autoRecordingState, setAutoRecordingState] = useState<'idle' | 'recording' | 'processing'>('idle')
  const [submitting, setSubmitting] = useState(false)
  const [postCaptureNotice, setPostCaptureNotice] = useState<PostCaptureNotice>(null)
  const { theme, toggle } = useTheme()
  const { items: notifications, unread, markAllRead } = useNotifications(user !== null)

  // Keep the latest recording session available to auto-stop callbacks.
  useEffect(() => {
    recordingRef.current = recording
  }, [recording])

  // Keep the main process informed so backend calls carry the audit actor.
  useEffect(() => {
    if (typeof window.api?.setUser === 'function') window.api.setUser(user?.name ?? '')
  }, [user])

  // Listen for auto-recording commands from the main process (IN-66).
  useEffect(() => {
    if (!user || typeof window.api?.onAutoStartRequest !== 'function') return

    const unsubStart = window.api.onAutoStartRequest(async (data) => {
      try {
        const graphMetadata = data.metadata ?? null
        autoGraphMetadataRef.current = graphMetadata
        const title = graphMetadata?.title?.trim() || 'Auto-recorded Teams meeting'
        const created = await createMeeting(title, graphMetadata?.joinWebUrl ?? null, 'online', graphMetadata)
        const status = await capture.start('online', loadPrefs().micDeviceId)
        setCaptureStatus(status)
        setRecording({
          meetingId: created?.id ?? null,
          title,
          source: 'online',
          startedAt: Date.now(),
          pausedAccum: 0,
          pausedAt: null
        })
        setView('recording')
        setAutoRecordingState('recording')
        window.api.notifyRecordingStarted()
      } catch (err) {
        window.api.notifyRecordingError(err instanceof Error ? err.message : String(err))
      }
    })

    const unsubStop = window.api.onAutoStopRequest(async () => {
      try {
        setAutoRecordingState('processing')
        const session = recordingRef.current
        const meetingId = session?.meetingId ?? null
        const graphMetadata = autoGraphMetadataRef.current
        const durationSeconds = session ? Math.round(elapsedMs(session) / 1000) : null
        const blob = await capture.stop(session ? elapsedMs(session) : undefined)
        if (blob) {
          const name = `${meetingId ?? `auto-${Date.now()}`}.webm`
          try {
            await window.api.saveRecording(name, await blob.arrayBuffer())
          } catch {
            // Local save failed — still try upload
          }
          if (meetingId) {
            await uploadAudio(
              meetingId,
              await blobToBase64(blob),
              blob.type || 'audio/webm',
              durationSeconds,
              graphMetadata
            )
          }
        }
        setRecording(null)
        autoGraphMetadataRef.current = null
        setCaptureStatus(null)
        setAutoRecordingState('idle')
        window.api.notifyRecordingStopped()
      } catch (err) {
        window.api.notifyRecordingError(err instanceof Error ? err.message : String(err))
      }
    })

    return () => {
      unsubStart()
      unsubStop()
    }
  }, [user])

  if (!user) {
    return (
      <LoginScreen
        onSignedIn={(u) => {
          localStorage.setItem(USER_KEY, JSON.stringify(u))
          setUser(u)
        }}
      />
    )
  }

  const navigate = (id: ScreenId): void => {
    setView(id)
  }

  const watchProcessing = (meetingId: string, title: string): void => {
    setPostCaptureNotice({
      state: 'processing',
      meetingId,
      title,
      message: 'Recording uploaded. Processing transcript, summary, and action items…'
    })

    let attempts = 0
    const poll = async (): Promise<void> => {
      attempts += 1
      const review = await fetchMeetingReview(meetingId)
      const status = review?.meeting.pipeline_status
      if (status === 'ready' && review) {
        setPostCaptureNotice({
          state: 'emailing',
          meetingId,
          title,
          message: `Notes are ready: ${review.segments.length} transcript segments and ${review.action_items.length} action items. Emailing transcript…`
        })
        const result = await emailNotes(meetingId, null, user.email)
        if (result) {
          setPostCaptureNotice({
            state: 'ready',
            meetingId,
            title,
            message: `Transcript emailed to ${result.recipients.join(', ')}.`
          })
        } else {
          setPostCaptureNotice({
            state: 'failed',
            meetingId,
            title,
            message: 'Notes are ready, but the transcript email was not sent. Sign in to Outlook, then retry email.'
          })
        }
        return
      }
      if (status === 'failed') {
        setPostCaptureNotice({
          state: 'failed',
          meetingId,
          title,
          message: 'Processing failed. The recording was saved and can be retried.'
        })
        return
      }
      if (attempts < 30) window.setTimeout(() => void poll(), 2000)
    }

    void poll()
  }

  const retryTranscriptEmail = async (meetingId: string, title: string): Promise<void> => {
    let recorderEmail = user.email
    setPostCaptureNotice({
      state: 'emailing',
      meetingId,
      title,
      message: 'Connecting to Outlook…'
    })

    if (typeof window.api?.signIn === 'function') {
      const signedIn = await window.api.signIn()
      if (signedIn.ok && signedIn.name && signedIn.email) {
        const nextUser = { name: signedIn.name, email: signedIn.email }
        recorderEmail = signedIn.email
        localStorage.setItem(USER_KEY, JSON.stringify(nextUser))
        setUser(nextUser)
      } else {
        setPostCaptureNotice({
          state: 'failed',
          meetingId,
          title,
          message: signedIn.error || 'Outlook sign-in did not complete. Transcript email was not sent.'
        })
        return
      }
    }

    setPostCaptureNotice({
      state: 'emailing',
      meetingId,
      title,
      message: 'Retrying transcript email…'
    })
    const result = await emailNotes(meetingId, null, recorderEmail)
    setPostCaptureNotice({
      state: result ? 'ready' : 'failed',
      meetingId,
      title,
      message: result
        ? `Transcript emailed to ${result.recipients.join(', ')}.`
        : 'Email still failed. The notes are ready and the recording is safe.'
    })
  }

  const startCapture = async (title: string, link: string | null): Promise<void> => {
    // Always capture both mic and system audio — every meeting has system audio.
    const source = 'online' as const
    window.api.debugLog('manual start requested', { title, source })
    const created = await createMeeting(title, link)
    window.api.debugLog('manual meeting create finished', { meetingId: created?.id ?? null })
    const status = await capture.start(source, loadPrefs().micDeviceId)
    window.api.debugLog('manual capture start finished', { status })
    setCaptureStatus(status)
    setRecording({
      meetingId: created?.id ?? null,
      title,
      source,
      startedAt: Date.now(),
      pausedAccum: 0,
      pausedAt: null
    })
    setView('recording')
  }

  const stopRecording = async (): Promise<void> => {
    const session = recording
    const meetingId = session?.meetingId ?? null
    const durationSeconds = session ? Math.round(elapsedMs(session) / 1000) : null
    window.api.debugLog('manual stop requested', { meetingId, durationSeconds })
    setSubmitting(true)
    let blob: Blob | null = null
    try {
      blob = await capture.stop(session ? elapsedMs(session) : undefined)
      window.api.debugLog('capture stop resolved', {
        hasBlob: Boolean(blob),
        size: blob?.size ?? 0,
        type: blob?.type ?? null
      })
    } catch (err) {
      window.api.debugLog('capture stop failed', {
        message: err instanceof Error ? err.message : String(err)
      })
      setSubmitting(false)
      return
    }
    if (blob) {
      // Local copy first (survives backend outages), then queue the pipeline.
      const name = `${meetingId ?? `local-${Date.now()}`}.webm`
      try {
        const { path } = await window.api.saveRecording(name, await blob.arrayBuffer())
        console.info(`Recording saved: ${path} (${Math.round(blob.size / 1024)} KB)`)
      } catch (err) {
        console.error('Failed to save recording', err)
      }
      if (meetingId) {
        window.api.debugLog('audio upload starting', { meetingId, size: blob.size })
        const uploaded = await uploadAudio(
          meetingId,
          await blobToBase64(blob),
          blob.type || 'audio/webm',
          durationSeconds
        )
        window.api.debugLog('audio upload finished', { meetingId, ok: Boolean(uploaded) })
        if (!uploaded) console.warn('Audio upload failed — backend unreachable')
        if (uploaded) watchProcessing(meetingId, session?.title ?? 'Recording')
        else {
          setPostCaptureNotice({
            state: 'failed',
            meetingId,
            title: session?.title ?? 'Recording',
            message: 'Recording saved locally, but upload failed. Keep the app open and retry once backend is reachable.'
          })
        }
      }
    } else {
      window.api.debugLog('capture stop returned no blob', { meetingId })
    }
    setRecording(null)
    setCaptureStatus(null)
    setView('home')
    setSubmitting(false)
  }

  const uploadRecording = async (title: string, file: File): Promise<void> => {
    const created = await createMeeting(title, null, 'upload')
    if (!created) {
      console.warn('Upload needs the backend — start it and try again')
      return
    }
    const b64 = await blobToBase64(file)
    const duration = await audioDurationSeconds(file)
    const uploaded = await uploadAudio(created.id, b64, file.type || 'audio/webm', duration)
    if (!uploaded) console.warn('Audio upload failed — backend unreachable')
  }

  const signOut = (): void => {
    localStorage.removeItem(USER_KEY)
    setRecording(null)
    setView('home')
    setUser(null)
  }

  const shellRecordingState = recording ? 'recording' : autoRecordingState

  return (
    <AppShell
      active={view === 'recording' ? null : view}
      onSelect={navigate}
      theme={theme}
      onToggleTheme={toggle}
      recordingState={shellRecordingState}
      onOpenRecording={
        recording ? () => setView('recording') : null
      }
      notifications={notifications}
      unreadCount={unread}
      onNotificationsOpened={markAllRead}
      userName={user?.name}
    >
      {view === 'recording' && recording && (
        <RecordingScreen
          session={recording}
          captureStatus={captureStatus}
          onPause={() => {
            capture.pause()
            setRecording((s) => (s ? { ...s, pausedAt: Date.now() } : s))
          }}
          onResume={() => {
            capture.resume()
            setRecording((s) =>
              s && s.pausedAt !== null
                ? { ...s, pausedAccum: s.pausedAccum + (Date.now() - s.pausedAt), pausedAt: null }
                : s
            )
          }}
          onStop={() => void stopRecording()}
          saving={submitting}
        />
      )}
      {view === 'home' && (
        <HomeScreen
          userName={user.name}
          onStartCapture={(t, l) => void startCapture(t, l)}
          onUploadRecording={(t, f) => void uploadRecording(t, f)}
          recordingState={autoRecordingState}
          postCaptureNotice={postCaptureNotice}
          onDismissPostCaptureNotice={() => setPostCaptureNotice(null)}
          onRetryPostCaptureEmail={(meetingId, title) => void retryTranscriptEmail(meetingId, title)}
        />
      )}
      {view === 'people' && <PeopleScreen />}
      {view === 'settings' && (
        <SettingsScreen
          theme={theme}
          onToggleTheme={toggle}
          userName={user.name}
          userEmail={user.email}
          onSignOut={signOut}
        />
      )}
    </AppShell>
  )
}

export default App
