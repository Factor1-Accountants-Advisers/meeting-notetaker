import { useState } from 'react'
import { Download, Languages, LogOut, Mic, Moon, Sun, User } from 'lucide-react'
import { Card, SectionHeader } from '@renderer/components/ui/Card'
import { Avatar } from '@renderer/components/ui/Avatar'
import { Pill } from '@renderer/components/ui/Pill'
import type { Theme } from '@renderer/lib/theme'

interface Props {
  theme: Theme
  onToggleTheme: () => void
}

export function SettingsScreen({ theme, onToggleTheme }: Props): JSX.Element {
  const [inputDevice, setInputDevice] = useState('default')
  const [language, setLanguage] = useState('auto')

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[22px] font-medium text-content-primary">Settings</h1>

      <Card>
        <SectionHeader icon={User} title="Account" />
        <div className="flex items-center gap-2.5">
          <Avatar initials="GG" tone="info" />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] text-content-primary">Gerd Guerrero</div>
            <div className="text-[11px] text-content-tertiary">
              gerd@factor1.ph · signed in with Microsoft
            </div>
          </div>
          <button
            type="button"
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
            value={inputDevice}
            aria-label="Microphone"
            onChange={(e) => setInputDevice(e.target.value)}
            className="h-8 rounded-md border-[0.5px] border-edge-tertiary bg-bg-primary px-2 text-[13px] text-content-primary focus:outline-none"
          >
            <option value="default">System default</option>
            <option value="headset">Headset microphone</option>
            <option value="room">Conference room array</option>
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
            value={language}
            aria-label="Default language"
            onChange={(e) => setLanguage(e.target.value)}
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
        <SettingRow label="Version" hint="Updates download in the background and install on restart">
          <span className="flex items-center gap-2">
            <span className="text-[13px] text-content-secondary">0.1.0</span>
            <button
              type="button"
              className="rounded-md border-[0.5px] border-edge-secondary px-2.5 py-1.5 text-[12px] text-content-primary hover:bg-bg-secondary"
            >
              Check for updates
            </button>
          </span>
        </SettingRow>
      </Card>
    </div>
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
