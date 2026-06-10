import { useState } from 'react'
import { AppShell } from './components/shell/AppShell'
import { HomeScreen } from './screens/HomeScreen'
import { MeetingsScreen } from './screens/MeetingsScreen'
import { MeetingReviewScreen } from './screens/MeetingReviewScreen'
import { ActionItemsScreen } from './screens/ActionItemsScreen'
import { PeopleScreen } from './screens/PeopleScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { LoginScreen, type User } from './screens/LoginScreen'
import { RecordingScreen, type RecordingSession } from './screens/RecordingScreen'
import { createMeeting } from './lib/api'
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
  const [reviewMeetingId, setReviewMeetingId] = useState<string | null>(null)
  const [recording, setRecording] = useState<RecordingSession | null>(null)
  const { theme, toggle } = useTheme()

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
    setReviewMeetingId(null)
    setView(id)
  }

  const openMeeting = (id: string): void => {
    setView('meetings')
    setReviewMeetingId(id)
  }

  const startCapture = async (title: string, link: string | null): Promise<void> => {
    const created = await createMeeting(title, link)
    setRecording({
      meetingId: created?.id ?? null,
      title,
      source: link ? 'online' : 'in_person',
      startedAt: Date.now(),
      pausedAccum: 0,
      pausedAt: null
    })
    setView('recording')
  }

  const stopRecording = (): void => {
    const meetingId = recording?.meetingId ?? null
    setRecording(null)
    // Capture upload + pipeline kick-off lands with the WASAPI work; for now
    // stopping returns to the library where the draft meeting already exists.
    if (meetingId) openMeeting(meetingId)
    else navigate('meetings')
  }

  const signOut = (): void => {
    localStorage.removeItem(USER_KEY)
    setRecording(null)
    setReviewMeetingId(null)
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
    >
      {view === 'recording' && recording && (
        <RecordingScreen
          session={recording}
          onPause={() =>
            setRecording((s) => (s ? { ...s, pausedAt: Date.now() } : s))
          }
          onResume={() =>
            setRecording((s) =>
              s && s.pausedAt !== null
                ? { ...s, pausedAccum: s.pausedAccum + (Date.now() - s.pausedAt), pausedAt: null }
                : s
            )
          }
          onStop={stopRecording}
        />
      )}
      {view === 'home' && (
        <HomeScreen userName={user.name} onStartCapture={(t, l) => void startCapture(t, l)} />
      )}
      {view === 'meetings' &&
        (reviewMeetingId ? (
          <MeetingReviewScreen
            meetingId={reviewMeetingId}
            onBack={() => setReviewMeetingId(null)}
          />
        ) : (
          <MeetingsScreen onOpenMeeting={setReviewMeetingId} />
        ))}
      {view === 'actions' && <ActionItemsScreen onOpenMeeting={openMeeting} />}
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
