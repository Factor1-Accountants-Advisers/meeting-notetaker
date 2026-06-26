import { useEffect, useState } from 'react'
import { AppShell } from './components/shell/AppShell'
import { HomeScreen } from './screens/HomeScreen'
import { PeopleScreen } from './screens/PeopleScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { LoginScreen, type User } from './screens/LoginScreen'
import { RecordingScreen, type RecordingSession } from './screens/RecordingScreen'
import { createMeeting, uploadAudio } from './lib/api'
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

function App(): JSX.Element {
  const [user, setUser] = useState<User | null>(loadUser)
  const [view, setView] = useState<View>('home')
  const [recording, setRecording] = useState<RecordingSession | null>(null)
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus | null>(null)
  const [autoRecordingState, setAutoRecordingState] = useState<'idle' | 'recording' | 'processing'>('idle')
  const { theme, toggle } = useTheme()
  const { items: notifications, unread, markAllRead } = useNotifications(user !== null)

  // Keep the main process informed so backend calls carry the audit actor.
  useEffect(() => {
    if (typeof window.api?.setUser === 'function') window.api.setUser(user?.name ?? '')
  }, [user])

  // Listen for auto-recording commands from the main process (IN-66).
  useEffect(() => {
    if (!user || typeof window.api?.onAutoStartRequest !== 'function') return

    const unsubStart = window.api.onAutoStartRequest(async (_data) => {
      try {
        const created = await createMeeting('Auto-recorded meeting', null)
        const status = await capture.start('online', loadPrefs().micDeviceId)
        setCaptureStatus(status)
        setRecording({
          meetingId: created?.id ?? null,
          title: 'Auto-recorded meeting',
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
        const session = recording
        const meetingId = session?.meetingId ?? null
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
              durationSeconds
            )
          }
        }
        setRecording(null)
        setCaptureStatus(null)
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

  const startCapture = async (title: string, link: string | null): Promise<void> => {
    const source = link ? ('online' as const) : ('in_person' as const)
    const created = await createMeeting(title, link)
    const status = await capture.start(source, loadPrefs().micDeviceId)
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
    const blob = await capture.stop(session ? elapsedMs(session) : undefined)
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
        const uploaded = await uploadAudio(
          meetingId,
          await blobToBase64(blob),
          blob.type || 'audio/webm',
          durationSeconds
        )
        if (!uploaded) console.warn('Audio upload failed — backend unreachable')
      }
    }
    setRecording(null)
    setCaptureStatus(null)
    setView('home')
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

  return (
    <AppShell
      active={view === 'recording' ? null : view}
      onSelect={navigate}
      theme={theme}
      onToggleTheme={toggle}
      onOpenRecording={
        recording && view !== 'recording' ? () => setView('recording') : null
      }
      notifications={notifications}
      unreadCount={unread}
      onNotificationsOpened={markAllRead}
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
        />
      )}
      {view === 'home' && (
        <HomeScreen
          userName={user.name}
          onStartCapture={(t, l) => void startCapture(t, l)}
          onUploadRecording={(t, f) => void uploadRecording(t, f)}
          recordingState={autoRecordingState}
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
