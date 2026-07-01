import { useEffect, useRef, useState } from 'react'
import { AppShell } from './components/shell/AppShell'
import { EnrollmentModal } from './components/EnrollmentModal'
import { HomeScreen } from './screens/HomeScreen'
import { PeopleScreen } from './screens/PeopleScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { LoginScreen, type User } from './screens/LoginScreen'
import { RecordingScreen, type RecordingSession } from './screens/RecordingScreen'
import { createMeeting, emailNotes, ensureCurrentPerson, fetchMeetingReview, uploadAudio, type GraphMeetingMetadata } from './lib/api'
import { capture, type CaptureStatus } from './lib/capture'
import { loadPrefs } from './lib/prefs'
import { useNotifications } from './lib/useNotifications'
import { audioDurationSeconds, blobToBase64 } from './lib/recorder'
import { elapsedMs } from './screens/RecordingScreen'
import { useTheme } from './lib/theme'
import type { ScreenId } from './lib/nav'
import type { StaffMember } from './data/mock'

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
  const [currentPerson, setCurrentPerson] = useState<StaffMember | null>(null)
  const [enrollmentLoading, setEnrollmentLoading] = useState(false)
  const [enrollmentError, setEnrollmentError] = useState<string | null>(null)
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

  // Required staff voiceprint gate after Microsoft sign-in.
  useEffect(() => {
    let cancelled = false
    if (!user) {
      setCurrentPerson(null)
      setEnrollmentError(null)
      setEnrollmentLoading(false)
      return
    }

    setEnrollmentLoading(true)
    setEnrollmentError(null)
    ensureCurrentPerson(user.name, user.email)
      .then((person) => {
        if (cancelled) return
        if (person) {
          setCurrentPerson(person)
        } else {
          setCurrentPerson(null)
          setEnrollmentError('Could not load your staff enrollment record. Check that the backend is running, then sign in again.')
        }
      })
      .catch((err) => {
        if (cancelled) return
        setCurrentPerson(null)
        setEnrollmentError(err instanceof Error ? err.message : 'Could not load your staff enrollment record.')
      })
      .finally(() => {
        if (!cancelled) setEnrollmentLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [user])

  // Listen for auto-recording commands from the main process (IN-66).
  useEffect(() => {
    if (!user || currentPerson?.enrollment !== 'enrolled' || typeof window.api?.onAutoStartRequest !== 'function') return

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
        const result = await capture.stop(session ? elapsedMs(session) : undefined)
        if (result) {
          const name = `${meetingId ?? `auto-${Date.now()}`}.webm`
          try {
            await window.api.saveRecording(name, await result.blob.arrayBuffer())
            if (result.systemBlob) {
              await window.api.saveRecording(
                name.replace(/\.webm$/i, '.system.webm'),
                await result.systemBlob.arrayBuffer()
              )
            }
          } catch {
            // Local save failed — still try upload
          }
          if (meetingId) {
            await uploadAudio(
              meetingId,
              await blobToBase64(result.blob),
              result.blob.type || 'audio/webm',
              durationSeconds,
              graphMetadata,
              result.systemBlob
                ? {
                    audioB64: await blobToBase64(result.systemBlob),
                    mimeType: result.systemBlob.type || 'audio/webm'
                  }
                : null
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
  }, [user, currentPerson?.enrollment])

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
    const maxAttempts = 300
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
      if (attempts < maxAttempts) {
        window.setTimeout(() => void poll(), 2000)
        return
      }

      setPostCaptureNotice({
        state: 'failed',
        meetingId,
        title,
        message: 'Processing is taking longer than expected. The recording was saved; open the meeting list or refresh to check the latest status.'
      })
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
    let result: Awaited<ReturnType<typeof capture.stop>> = null
    try {
      result = await capture.stop(session ? elapsedMs(session) : undefined)
      window.api.debugLog('capture stop resolved', {
        hasBlob: Boolean(result?.blob),
        size: result?.blob.size ?? 0,
        type: result?.blob.type ?? null,
        hasSystemBlob: Boolean(result?.systemBlob),
        systemSize: result?.systemBlob?.size ?? 0,
        systemType: result?.systemBlob?.type ?? null
      })
    } catch (err) {
      window.api.debugLog('capture stop failed', {
        message: err instanceof Error ? err.message : String(err)
      })
      setSubmitting(false)
      return
    }
    if (result) {
      // Local copy first (survives backend outages), then queue the pipeline.
      const name = `${meetingId ?? `local-${Date.now()}`}.webm`
      try {
        const { path } = await window.api.saveRecording(name, await result.blob.arrayBuffer())
        console.info(`Recording saved: ${path} (${Math.round(result.blob.size / 1024)} KB)`)
        if (result.systemBlob) {
          const systemPath = await window.api.saveRecording(
            name.replace(/\.webm$/i, '.system.webm'),
            await result.systemBlob.arrayBuffer()
          )
          console.info(
            `System audio saved: ${systemPath.path} (${Math.round(result.systemBlob.size / 1024)} KB)`
          )
        }
      } catch (err) {
        console.error('Failed to save recording', err)
      }
      if (meetingId) {
        window.api.debugLog('audio upload starting', {
          meetingId,
          size: result.blob.size,
          systemSize: result.systemBlob?.size ?? 0
        })
        const uploaded = await uploadAudio(
          meetingId,
          await blobToBase64(result.blob),
          result.blob.type || 'audio/webm',
          durationSeconds,
          null,
          result.systemBlob
            ? {
                audioB64: await blobToBase64(result.systemBlob),
                mimeType: result.systemBlob.type || 'audio/webm'
              }
            : null
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
    setCurrentPerson(null)
    setEnrollmentError(null)
    setEnrollmentLoading(false)
    setView('home')
    setUser(null)
  }

  if (enrollmentLoading || enrollmentError || !currentPerson || currentPerson.enrollment !== 'enrolled') {
    return (
      <div className="relative flex h-full flex-col items-center justify-center bg-page px-6">
        <div className="w-full max-w-[520px] rounded-lg border-[0.5px] border-edge-secondary bg-bg-primary p-5 text-center">
          <h1 className="m-0 text-[18px] font-medium text-content-primary">Voiceprint required</h1>
          <p className="mx-auto mb-0 mt-2 max-w-[420px] text-[12px] leading-relaxed text-content-tertiary">
            Factor1 staff must enroll a voiceprint after Microsoft sign-in before using
            Notetaker. This keeps speaker attribution aligned with the Slice 1 Jira scope.
          </p>
          {enrollmentLoading && (
            <p className="mb-0 mt-4 flex items-center justify-center gap-2 text-[13px] text-content-secondary">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-edge-tertiary border-t-brand-blue" />
              Loading your enrollment status…
            </p>
          )}
          {enrollmentError && (
            <p className="mb-0 mt-4 rounded-md border-[0.5px] border-edge-danger bg-bg-danger px-3 py-2 text-[12px] leading-relaxed text-content-danger">
              {enrollmentError}
            </p>
          )}
          <button
            type="button"
            onClick={signOut}
            className="mt-4 rounded-md border-[0.5px] border-edge-secondary px-3 py-2 text-[13px] text-content-primary hover:bg-bg-secondary"
          >
            Sign out
          </button>
        </div>
        {currentPerson && currentPerson.enrollment !== 'enrolled' && (
          <EnrollmentModal
            person={currentPerson}
            required
            onClose={() => undefined}
            onEnrolled={(updated) => {
              setCurrentPerson(updated)
              setEnrollmentError(null)
              setView('home')
            }}
          />
        )}
      </div>
    )
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
