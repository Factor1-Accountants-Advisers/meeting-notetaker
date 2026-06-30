import { useEffect, useState } from 'react'
import { Download, Languages, LogOut, Mic, Moon, Sun, User } from 'lucide-react'
import { Card, SectionHeader } from '@renderer/components/ui/Card'
import { Avatar } from '@renderer/components/ui/Avatar'
import { Pill } from '@renderer/components/ui/Pill'
import { loadPrefs, savePrefs } from '@renderer/lib/prefs'
import type { Theme } from '@renderer/lib/theme'

interface Props {
  theme: Theme
  onToggleTheme: () => void
  userName: string
  userEmail: string
  onSignOut: () => void
}

interface AutoLaunchStatus {
  supported: boolean
  enabled: boolean
  managedByDefault: boolean
  reason?: string
}

export function SettingsScreen({
  theme,
  onToggleTheme,
  userName,
  userEmail,
  onSignOut
}: Props): JSX.Element {
  const [prefs, setPrefs] = useState(loadPrefs)
  const [devices, setDevices] = useState<{ id: string; label: string }[]>([])
  const [autoLaunch, setAutoLaunch] = useState<AutoLaunchStatus | null>(null)
  const [autoLaunchBusy, setAutoLaunchBusy] = useState(false)

  useEffect(() => {
    void window.api?.getAutoLaunch?.().then(setAutoLaunch).catch(() =>
      setAutoLaunch({
        supported: false,
        enabled: false,
        managedByDefault: false,
        reason: 'Startup settings are only available in the desktop app.'
      })
    )
  }, [])

  useEffect(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((all) =>
        setDevices(
          all
            .filter((d) => d.kind === 'audioinput')
            .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }))
        )
      )
      .catch(() => setDevices([]))
  }, [])

  const update = (changes: Partial<typeof prefs>): void => {
    const next = { ...prefs, ...changes }
    setPrefs(next)
    savePrefs(next)
  }

  const updateAutoLaunch = async (enabled: boolean): Promise<void> => {
    if (typeof window.api?.setAutoLaunch !== 'function') return
    setAutoLaunchBusy(true)
    try {
      setAutoLaunch(await window.api.setAutoLaunch(enabled))
    } finally {
      setAutoLaunchBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[22px] font-medium text-content-primary">Settings</h1>

      <Card>
        <SectionHeader icon={User} title="Account" />
        <div className="flex items-center gap-2.5">
          <Avatar
            initials={userName
              .split(' ')
              .map((p) => p[0])
              .join('')
              .toUpperCase()
              .slice(0, 2)}
            tone="info"
          />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] text-content-primary">{userName}</div>
            <div className="text-[11px] text-content-tertiary">
              {userEmail} · signed in with Microsoft
            </div>
          </div>
          <button
            type="button"
            onClick={onSignOut}
            className="flex items-center gap-1.5 rounded-md border-[0.5px] border-edge-secondary px-2.5 py-1.5 text-[12px] text-content-primary hover:bg-bg-secondary"
          >
            <LogOut size={13} strokeWidth={1.75} />
            Sign out
          </button>
        </div>
      </Card>

      <Card>
        <SectionHeader icon={Mic} title="Audio capture" />
        <SettingRow
          label="Microphone"
          hint="Mixed with system audio for online meetings"
        >
          <select
            value={prefs.micDeviceId}
            aria-label="Microphone"
            onChange={(e) => update({ micDeviceId: e.target.value })}
            className="h-8 max-w-[220px] rounded-md border-[0.5px] border-edge-tertiary bg-bg-primary px-2 text-[13px] text-content-primary focus:outline-none"
          >
            <option value="">System default</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow
          label="System audio (loopback)"
          hint="Captures remote participants in online meetings. Also captures notifications — silence them while recording."
        >
          <Pill tone="success">Available</Pill>
        </SettingRow>
      </Card>

      <Card>
        <SectionHeader icon={Languages} title="Transcription" />
        <SettingRow
          label="Default language"
          hint="Per-meeting override available; Taglish handling validated on real audio"
        >
          <select
            value={prefs.language}
            aria-label="Default language"
            onChange={(e) => update({ language: e.target.value })}
            className="h-8 rounded-md border-[0.5px] border-edge-tertiary bg-bg-primary px-2 text-[13px] text-content-primary focus:outline-none"
          >
            <option value="auto">Auto-detect (English + Filipino)</option>
            <option value="en-PH">English (Philippines)</option>
            <option value="fil-PH">Filipino</option>
          </select>
        </SettingRow>
      </Card>

      <Card>
        <SectionHeader icon={Download} title="App" />
        <SettingRow label="Theme" hint="Light and dark are both supported">
          <button
            type="button"
            onClick={onToggleTheme}
            className="flex items-center gap-1.5 rounded-md border-[0.5px] border-edge-secondary px-2.5 py-1.5 text-[12px] text-content-primary hover:bg-bg-secondary"
          >
            {theme === 'dark' ? (
              <Sun size={13} strokeWidth={1.75} />
            ) : (
              <Moon size={13} strokeWidth={1.75} />
            )}
            {theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          </button>
        </SettingRow>
        <SettingRow
          label="Start at Windows sign-in"
          hint="On by default in the packaged app so eligible Teams meetings can auto-record from the tray."
        >
          <button
            type="button"
            disabled={!autoLaunch?.supported || autoLaunchBusy}
            onClick={() => void updateAutoLaunch(!(autoLaunch?.enabled ?? false))}
            className={`flex min-w-[84px] items-center justify-center rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              autoLaunch?.enabled
                ? 'bg-bg-info text-content-info'
                : 'border-[0.5px] border-edge-secondary text-content-secondary hover:bg-bg-secondary'
            }`}
            title={autoLaunch?.reason}
          >
            {autoLaunchBusy ? 'Saving…' : autoLaunch?.enabled ? 'On' : 'Off'}
          </button>
        </SettingRow>
        <SettingRow label="Version" hint="Updates download in the background and install on restart">
          <UpdateCheck />
        </SettingRow>
      </Card>
    </div>
  )
}

function UpdateCheck(): JSX.Element {
  const [status, setStatus] = useState<string>('0.1.0')
  const [busy, setBusy] = useState(false)

  const check = async (): Promise<void> => {
    if (typeof window.api?.checkUpdates !== 'function') return
    setBusy(true)
    const result = await window.api.checkUpdates()
    setBusy(false)
    switch (result.state) {
      case 'dev':
        setStatus(`${result.version} (dev build — updates disabled)`)
        break
      case 'up-to-date':
        setStatus(`${result.version} — up to date`)
        break
      case 'available':
        setStatus(`Update ${result.version} downloading — installs on restart`)
        break
      case 'error':
        setStatus('Update check failed — feed not reachable')
        break
      default:
        setStatus(result.version ?? '0.1.0')
    }
  }

  return (
    <span className="flex items-center gap-2">
      <span className="max-w-[220px] text-right text-[12px] text-content-secondary">{status}</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void check()}
        className="rounded-md border-[0.5px] border-edge-secondary px-2.5 py-1.5 text-[12px] text-content-primary hover:bg-bg-secondary disabled:opacity-45"
      >
        {busy ? 'Checking…' : 'Check for updates'}
      </button>
    </span>
  )
}

function SettingRow({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 border-t-[0.5px] border-edge-tertiary py-2.5 first:border-t-0">
      <div className="min-w-0">
        <div className="text-[14px] text-content-primary">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] text-content-tertiary">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}
