import { useState } from 'react'
import { CheckSquare, Users, Settings } from 'lucide-react'
import { AppShell } from './components/shell/AppShell'
import { HomeScreen } from './screens/HomeScreen'
import { MeetingsScreen } from './screens/MeetingsScreen'
import { Placeholder } from './screens/Placeholder'
import { useTheme } from './lib/theme'
import type { ScreenId } from './lib/nav'

function App(): JSX.Element {
  const [screen, setScreen] = useState<ScreenId>('home')
  const { theme, toggle } = useTheme()

  return (
    <AppShell active={screen} onSelect={setScreen} theme={theme} onToggleTheme={toggle}>
      {screen === 'home' && <HomeScreen />}
      {screen === 'meetings' && <MeetingsScreen />}
      {screen === 'actions' && (
        <Placeholder icon={CheckSquare} title="Action items" note="Cross-meeting action items, filterable by owner, status, priority, and overdue." />
      )}
      {screen === 'people' && (
        <Placeholder icon={Users} title="People" note="Staff list with voiceprint enrollment status and the 3-clip enrollment flow." />
      )}
      {screen === 'settings' && (
        <Placeholder icon={Settings} title="Settings" note="Account, audio preferences, transcription defaults, and update status." />
      )}
    </AppShell>
  )
}

export default App
