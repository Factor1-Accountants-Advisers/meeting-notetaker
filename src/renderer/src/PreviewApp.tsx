import { useEffect, useState } from 'react'
import { AppShell } from './components/shell/AppShell'
import { HomeScreen } from './screens/HomeScreen'
import { RecordingScreen, type RecordingSession } from './screens/RecordingScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { useTheme } from './lib/theme'
import type { ScreenId } from './lib/nav'

type PreviewView = ScreenId | 'recording'

const USER = {
  name: 'Joseph Guerrero',
  email: 'preview.user@example.com'
}

function previewSession(title = 'Client advisory meeting'): RecordingSession {
  const now = Date.now()
  return {
    meetingId: 'local-preview',
    title,
    source: 'online',
    startedAt: now - 18 * 60_000 - 42_000,
    pausedAccum: 0,
    pausedAt: null,
    scheduledEndUtc: new Date(now + 11 * 60_000).toISOString()
  }
}

export function PreviewApp(): JSX.Element {
  const [view, setView] = useState<PreviewView>('home')
  const [session, setSession] = useState<RecordingSession>(() => previewSession())
  const [processingTitle, setProcessingTitle] = useState<string | null>(null)
  const { theme, setTheme } = useTheme()
  const recording = view === 'recording'
  const processing = processingTitle !== null

  const navigate = (next: PreviewView): void => {
    if (next === 'recording' && view !== 'recording') {
      setSession(previewSession())
      setProcessingTitle(null)
    }
    setView(next)
  }

  useEffect(() => {
    const handlePreviewShortcut = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return
      const next =
        event.key === '1'
          ? 'home'
          : event.key === '2'
            ? 'recording'
            : event.key === '3'
              ? 'settings'
              : null
      if (!next) return
      event.preventDefault()
      navigate(next)
    }
    window.addEventListener('keydown', handlePreviewShortcut)
    return () => window.removeEventListener('keydown', handlePreviewShortcut)
  })

  return (
    <AppShell
      active={view === 'recording' ? null : view}
      onSelect={navigate}
      recordingState={recording ? 'recording' : processing ? 'processing' : 'idle'}
      statusText={
        recording
          ? session.pausedAt === null
            ? 'Recording'
            : 'Recording paused'
          : processing
            ? 'Preparing summary'
            : null
      }
      statusDetail={processing ? processingTitle : null}
      recordingStartedAt={recording ? session.startedAt : null}
      recordingPausedAt={recording ? session.pausedAt : null}
      recordingPausedAccum={recording ? session.pausedAccum : 0}
      onOpenRecording={recording ? () => setView('recording') : null}
      userName={USER.name}
    >
      {view === 'home' && (
        <HomeScreen
          previewMode
          recordingState={processing ? 'processing' : 'idle'}
          postCaptureNotice={
            processingTitle
              ? {
                  state: 'processing',
                  meetingId: 'local-preview',
                  title: processingTitle,
                  message: 'Preparing summary'
                }
              : null
          }
          onStartRecording={(title) => {
            setSession(previewSession(title))
            setProcessingTitle(null)
            setView('recording')
          }}
          onUploadRecording={(title) => {
            setProcessingTitle(title)
            setView('home')
          }}
        />
      )}

      {view === 'recording' && (
        <RecordingScreen
          session={session}
          captureStatus={{
            mic: 'active',
            loopback: 'active',
            recording: true,
            micLevel: 0.021,
            loopbackLevel: 0.014
          }}
          onPause={() => setSession((current) => ({ ...current, pausedAt: Date.now() }))}
          onResume={() =>
            setSession((current) => {
              if (current.pausedAt === null) return current
              return {
                ...current,
                pausedAccum: current.pausedAccum + (Date.now() - current.pausedAt),
                pausedAt: null
              }
            })
          }
          onStop={() => {
            setProcessingTitle(session.title)
            setView('home')
          }}
          onExtend={() =>
            setSession((current) => ({
              ...current,
              scheduledEndUtc: new Date(
                new Date(current.scheduledEndUtc ?? Date.now()).getTime() + 10 * 60_000
              ).toISOString()
            }))
          }
        />
      )}

      {view === 'settings' && (
        <SettingsScreen
          previewMode
          theme={theme}
          onSetTheme={setTheme}
          userName={USER.name}
          userEmail={USER.email}
          isStorageAdmin={false}
          onOpenVoiceprintAdmin={() => undefined}
          onSignOut={() => undefined}
          onClose={() => setView('home')}
        />
      )}
    </AppShell>
  )
}
