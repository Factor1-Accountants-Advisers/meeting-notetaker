import { useState } from 'react'
import { FileText, CheckSquare, Users, Settings } from 'lucide-react'
import { AppShell } from './components/shell/AppShell'
import { Placeholder } from './screens/Placeholder'
import { useTheme } from './lib/theme'
import type { ScreenId } from './lib/nav'

function App(): JSX.Element {
  const [screen, setScreen] = useState<ScreenId>('home')
  const { theme, toggle } = useTheme()

  return (
    <AppShell active={screen} onSelect={setScreen} theme={theme} onToggleTheme={toggle}>
      {screen === 'home' && (
        <Placeholder icon={FileText} title="Home" note="Dashboard — greeting, capture, upcoming meetings, recordings, and your action items. Coming next." />
      )}
      {screen === 'meetings' && (
        <Placeholder icon={FileText} title="Meetings" note="Library of all accessible meetings with filters, recency groups, and status pills. Coming next." />
      )}
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
