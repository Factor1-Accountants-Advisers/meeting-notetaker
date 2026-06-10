import { useState } from 'react'
import { AppShell } from './components/shell/AppShell'
import { HomeScreen } from './screens/HomeScreen'
import { MeetingsScreen } from './screens/MeetingsScreen'
import { MeetingReviewScreen } from './screens/MeetingReviewScreen'
import { ActionItemsScreen } from './screens/ActionItemsScreen'
import { PeopleScreen } from './screens/PeopleScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { useTheme } from './lib/theme'
import type { ScreenId } from './lib/nav'

function App(): JSX.Element {
  const [screen, setScreen] = useState<ScreenId>('home')
  const [reviewMeetingId, setReviewMeetingId] = useState<string | null>(null)
  const { theme, toggle } = useTheme()

  const navigate = (id: ScreenId): void => {
    setReviewMeetingId(null)
    setScreen(id)
  }

  // Cross-screen: any screen can open a meeting's review.
  const openMeeting = (id: string): void => {
    setScreen('meetings')
    setReviewMeetingId(id)
  }

  return (
    <AppShell active={screen} onSelect={navigate} theme={theme} onToggleTheme={toggle}>
      {screen === 'home' && <HomeScreen />}
      {screen === 'meetings' &&
        (reviewMeetingId ? (
          <MeetingReviewScreen
            meetingId={reviewMeetingId}
            onBack={() => setReviewMeetingId(null)}
          />
        ) : (
          <MeetingsScreen onOpenMeeting={setReviewMeetingId} />
        ))}
      {screen === 'actions' && <ActionItemsScreen onOpenMeeting={openMeeting} />}
      {screen === 'people' && <PeopleScreen />}
      {screen === 'settings' && <SettingsScreen theme={theme} onToggleTheme={toggle} />}
    </AppShell>
  )
}

export default App
