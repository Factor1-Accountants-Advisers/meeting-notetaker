import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleCheck,
  Fingerprint,
  Loader2,
  LogOut,
  MessageSquareWarning,
  Send,
  SlidersHorizontal,
  X
} from 'lucide-react'
import { Card } from '@renderer/components/ui/Card'
import { SelectMenu, type SelectOption } from '@renderer/components/ui/SelectMenu'
import { loadPrefs, savePrefs } from '@renderer/lib/prefs'
import type { Theme } from '@renderer/lib/theme'

interface Props {
  previewMode?: boolean
  theme: Theme
  onSetTheme: (theme: Theme) => void
  userName: string
  userEmail: string
  isStorageAdmin: boolean
  onOpenVoiceprintAdmin: () => void
  onSignOut: () => void
  onClose: () => void
}

interface AutoLaunchStatus {
  supported: boolean
  enabled: boolean
  managedByDefault: boolean
  reason?: string
}

const THEME_OPTIONS: SelectOption<Theme>[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
]

export function SettingsScreen({
  previewMode = false,
  theme,
  onSetTheme,
  userName,
  userEmail,
  isStorageAdmin,
  onOpenVoiceprintAdmin,
  onSignOut,
  onClose
}: Props): JSX.Element {
  const [page, setPage] = useState<'main' | 'advanced'>('main')
  const [prefs, setPrefs] = useState(loadPrefs)
  const [devices, setDevices] = useState<{ id: string; label: string }[]>([])
  const [autoLaunch, setAutoLaunch] = useState<AutoLaunchStatus | null>(null)
  const [autoLaunchBusy, setAutoLaunchBusy] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [reportIssue, setReportIssue] = useState('')
  const [reportSending, setReportSending] = useState(false)
  const [reportDone, setReportDone] = useState(false)
  const [reportError, setReportError] = useState<string | null>(null)
  const [appVersion, setAppVersion] = useState<string | null>(null)

  useEffect(() => {
    // Real version from the main process — the label was previously a
    // hardcoded string that shipped stale in 2.0.8 (showed 2.0.7).
    if (previewMode) {
      setAppVersion('0.0.0-preview')
      return
    }
    void window.api?.getAppVersion
      ?.()
      .then(setAppVersion)
      .catch(() => setAppVersion(null))
  }, [previewMode])

  useEffect(() => {
    if (previewMode) {
      setAutoLaunch({
        supported: true,
        enabled: true,
        managedByDefault: false
      })
      return
    }
    void window.api?.getAutoLaunch
      ?.()
      .then(setAutoLaunch)
      .catch(() =>
        setAutoLaunch({
          supported: false,
          enabled: false,
          managedByDefault: false,
          reason: 'Startup settings are only available in the desktop app.'
        })
      )
  }, [previewMode])

  useEffect(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((all) => {
        const unique = new Map<string, string>()
        all
          .filter((device) => device.kind === 'audioinput' && device.deviceId)
          .forEach((device, index) => {
            unique.set(device.deviceId, device.label || `Microphone ${index + 1}`)
          })
        setDevices(Array.from(unique, ([id, label]) => ({ id, label })))
      })
      .catch(() => setDevices([]))
  }, [])

  const microphoneOptions = useMemo<SelectOption<string>[]>(
    () => [
      { value: '', label: 'Follow Windows communications device' },
      ...devices.map((device) => ({ value: device.id, label: device.label }))
    ],
    [devices]
  )

  const updatePrefs = (changes: Partial<typeof prefs>): void => {
    const next = { ...prefs, ...changes }
    setPrefs(next)
    savePrefs(next)
  }

  const updateAutoLaunch = async (enabled: boolean): Promise<void> => {
    if (previewMode) {
      setAutoLaunch((current) =>
        current ? { ...current, enabled } : { supported: true, enabled, managedByDefault: false }
      )
      return
    }
    if (typeof window.api?.setAutoLaunch !== 'function') return
    setAutoLaunchBusy(true)
    try {
      setAutoLaunch(await window.api.setAutoLaunch(enabled))
    } finally {
      setAutoLaunchBusy(false)
    }
  }

  const openReport = (): void => {
    setReportOpen(true)
    setReportDone(false)
    setReportError(null)
    setReportIssue('')
  }

  const sendReport = async (): Promise<void> => {
    setReportSending(true)
    setReportError(null)
    if (previewMode) {
      await new Promise((resolve) => window.setTimeout(resolve, 350))
      setReportDone(true)
      setReportSending(false)
      return
    }
    try {
      const response = await window.api.request<{ ok: boolean; error?: string }>(
        'POST',
        '/api/v1/report-problem',
        { issue: reportIssue }
      )
      if (response.ok && response.body?.ok) {
        setReportDone(true)
      } else {
        setReportError(response.body?.error || 'Failed to send report.')
      }
    } catch {
      setReportError('Could not reach the backend. Check that the app is running.')
    } finally {
      setReportSending(false)
    }
  }

  return (
    <>
      {page === 'main' ? (
        <div key="settings-main" className="ui-enter flex flex-col gap-3">
          <SettingsHeader eyebrow="Preferences" title="Settings" onClose={onClose} />

          <div>
            <h3 className="mb-2 mt-0 text-[18px] font-medium text-content-primary">
              Audio capture
            </h3>
            <Card className="!overflow-visible">
              <SettingRow
                label="Microphone"
                hint="Falls back to the system default if disconnected"
              >
                <SelectMenu
                  ariaLabel="Microphone"
                  value={
                    prefs.micRoutingMode === 'pinned' ? prefs.pinnedMicDeviceId : ''
                  }
                  options={microphoneOptions}
                  onChange={(deviceId) =>
                    updatePrefs({
                      micRoutingMode: deviceId ? 'pinned' : 'follow_communications',
                      pinnedMicDeviceId: deviceId || prefs.pinnedMicDeviceId
                    })
                  }
                  className="w-[224px] max-[560px]:w-full"
                />
              </SettingRow>
              <SettingRow
                label="System audio"
                hint="Captures remote participants in online meetings"
              >
                <span className="flex items-center gap-1.5 text-[14px] text-content-secondary">
                  <CircleCheck
                    size={15}
                    className="text-[var(--color-status-ok)]"
                    aria-hidden="true"
                  />
                  Ready
                </span>
              </SettingRow>
            </Card>
          </div>

          <button
            type="button"
            onClick={() => setPage('advanced')}
            className="ui-control flex w-full items-center gap-[7px] border-y border-edge-tertiary py-2.5 text-left text-[14px] text-content-primary hover:bg-bg-secondary max-[400px]:grid max-[400px]:grid-cols-[1fr_auto]"
          >
            <SlidersHorizontal size={16} strokeWidth={1.75} />
            <span>App and advanced settings</span>
            <span className="ml-auto text-[12px] text-content-tertiary max-[400px]:hidden">
              Theme, startup, updates and support
            </span>
            <ChevronRight size={16} strokeWidth={1.75} className="text-content-tertiary" />
          </button>

          {isStorageAdmin && (
            <SettingsGroup title="Administration">
              <button
                type="button"
                onClick={onOpenVoiceprintAdmin}
                className="ui-control flex w-full items-center justify-between gap-3 py-2.5 text-left text-[14px] text-content-primary hover:text-content-info"
              >
                <span className="flex items-center gap-2">
                  <Fingerprint size={16} strokeWidth={1.75} />
                  Voiceprint management
                </span>
                <ChevronRight size={16} className="text-content-tertiary" />
              </button>
            </SettingsGroup>
          )}
        </div>
      ) : (
        <div key="settings-advanced" className="ui-enter flex flex-col gap-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <button
                type="button"
                onClick={() => setPage('main')}
                className="ui-control mb-0.5 flex items-center gap-1.5 rounded-md py-1 pr-2 text-[14px] text-content-secondary hover:text-content-primary"
              >
                <ArrowLeft size={15} />
                Settings
              </button>
              <h2 className="m-0 text-[20px] font-medium text-content-primary">
                App and advanced settings
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="ui-control flex min-h-7 items-center gap-1.5 rounded-control px-2 text-[14px] text-content-secondary hover:bg-bg-secondary hover:text-content-primary"
            >
              <X size={15} />
              Close
            </button>
          </div>

          <SettingsGroup title="Appearance">
            <SettingRow label="Theme" hint="Match Windows or choose a fixed appearance">
              <SelectMenu
                ariaLabel="Theme"
                value={theme}
                options={THEME_OPTIONS}
                onChange={onSetTheme}
                className="w-[224px] max-[560px]:w-full"
              />
            </SettingRow>
          </SettingsGroup>

          <SettingsGroup title="App behaviour">
            <SettingRow
              label="Launch at sign-in"
              hint={
                autoLaunch?.reason ??
                'Keep Meeting Notetaker ready in the system tray'
              }
            >
              <Toggle
                checked={autoLaunch?.enabled ?? false}
                disabled={!autoLaunch?.supported || autoLaunchBusy}
                busy={autoLaunchBusy}
                onChange={(checked) => void updateAutoLaunch(checked)}
              />
            </SettingRow>
            <SettingRow
              label="Automatic updates"
              hint="Install approved updates when the app restarts"
            >
              <Toggle
                checked
                disabled={false}
                busy={false}
                readOnly
                ariaLabel="Automatic updates"
                onChange={() => undefined}
              />
            </SettingRow>
          </SettingsGroup>

          <SettingsGroup title="About and support">
            <SettingRow
              label={appVersion ? `Meeting Notetaker ${appVersion}` : 'Meeting Notetaker'}
              hint="Updates download and install automatically"
            >
              <UpdateCheck previewMode={previewMode} />
            </SettingRow>
            <button
              type="button"
              onClick={openReport}
              className="ui-control flex w-full items-center justify-between gap-3 border-t border-edge-tertiary py-2.5 text-left text-[14px] text-content-primary hover:text-content-info"
            >
              <span className="flex items-center gap-2">
                <MessageSquareWarning size={16} />
                Report a problem
              </span>
              <ChevronRight size={16} className="text-content-tertiary" />
            </button>
          </SettingsGroup>

          <SettingsGroup title="Account">
            <SettingRow label={userName} hint={`${userEmail} · signed in with Microsoft`}>
              <button
                type="button"
                onClick={onSignOut}
                className="ui-control flex items-center gap-1.5 rounded-control border border-edge-secondary px-3 py-2 text-[14px] text-content-primary hover:bg-bg-secondary"
              >
                <LogOut size={14} strokeWidth={1.75} />
                Sign out
              </button>
            </SettingRow>
          </SettingsGroup>
        </div>
      )}

      {reportOpen &&
        createPortal(
          <ReportProblemModal
            issue={reportIssue}
            onChangeIssue={setReportIssue}
            sending={reportSending}
            done={reportDone}
            error={reportError}
            onSend={() => void sendReport()}
            onClose={() => setReportOpen(false)}
          />,
          document.body
        )}
    </>
  )
}

function SettingsHeader({
  eyebrow,
  title,
  onClose
}: {
  eyebrow: string
  title: string
  onClose: () => void
}): JSX.Element {
  return (
    <div className="flex items-start justify-between">
      <div>
        <div className="mb-0.5 text-[12px] text-content-tertiary">{eyebrow}</div>
        <h2 className="m-0 text-[20px] font-medium text-content-primary">{title}</h2>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="ui-control flex min-h-7 items-center gap-1.5 rounded-control px-2 text-[14px] text-content-secondary hover:bg-bg-secondary hover:text-content-primary"
      >
        <X size={15} strokeWidth={1.75} />
        Close
      </button>
    </div>
  )
}

function SettingsGroup({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div>
      <h3 className="mb-2 mt-0 text-[18px] font-medium text-content-primary">{title}</h3>
      <Card className="!overflow-visible">{children}</Card>
    </div>
  )
}

function ReportProblemModal({
  issue,
  onChangeIssue,
  sending,
  done,
  error,
  onSend,
  onClose
}: {
  issue: string
  onChangeIssue: (value: string) => void
  sending: boolean
  done: boolean
  error: string | null
  onSend: () => void
  onClose: () => void
}): JSX.Element {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !sending) onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [onClose, sending])

  return (
    <div
      className="ui-backdrop fixed inset-0 z-[80] flex items-center justify-center bg-[var(--color-background-modal)] p-4"
      role="presentation"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-title"
        className="ui-enter w-full max-w-[400px] rounded-card bg-bg-primary p-3"
      >
        <div className="mb-3.5 flex items-start justify-between gap-4">
          <h2 id="report-title" className="m-0 text-[20px] font-medium text-content-primary">
            Report a problem
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            aria-label="Close report"
            className="ui-control rounded-md p-1.5 text-content-tertiary hover:bg-bg-secondary hover:text-content-primary disabled:opacity-50"
          >
            <X size={17} strokeWidth={1.75} />
          </button>
        </div>

        {done ? (
          <div className="grid justify-items-center gap-2.5 p-2.5 text-center">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-bg-info text-content-info">
              <Check size={16} />
            </span>
            <h2 className="m-0 text-[20px] font-medium text-content-primary">Report sent</h2>
            <p className="m-0 text-[14px] text-content-tertiary">
              Thank you. The Notetaker team will look into it.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="ui-control rounded-control bg-[var(--color-button-primary)] px-4 py-2 text-[14px] text-[var(--color-button-primary-text)] hover:bg-[var(--color-button-primary-hover)]"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <label
              htmlFor="report-issue"
              className="mb-1.5 block text-[14px] font-medium text-content-primary"
            >
              What happened?
            </label>
            <textarea
              id="report-issue"
              autoFocus
              value={issue}
              onChange={(event) => onChangeIssue(event.target.value)}
              placeholder="Include any error message or unexpected behaviour"
              rows={3}
              className="ui-control w-full resize-none rounded-control border border-edge-secondary bg-bg-secondary px-3 py-2.5 text-[14px] text-content-primary placeholder:text-content-tertiary focus:border-brand-blue focus:outline-none"
            />
            {error && (
              <div className="mt-2 rounded-md bg-bg-danger px-3 py-2 text-[12px] text-content-danger">
                {error}
              </div>
            )}
            <div className="mt-2.5 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={sending}
                className="ui-control min-h-7 rounded-control border border-edge-secondary px-2 text-[14px] text-content-primary hover:bg-bg-secondary disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!issue.trim() || sending}
                onClick={onSend}
                className="ui-control flex min-h-7 items-center justify-center gap-1 rounded-control bg-[var(--color-button-primary)] px-2 text-[14px] text-[var(--color-button-primary-text)] hover:bg-[var(--color-button-primary-hover)] disabled:cursor-not-allowed disabled:opacity-45"
              >
                {sending ? (
                  <Loader2
                    size={15}
                    strokeWidth={1.75}
                    className="animate-spin motion-reduce:animate-none"
                  />
                ) : (
                  <Send size={15} strokeWidth={1.75} />
                )}
                {sending ? 'Sending…' : 'Send report'}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  )
}

function Toggle({
  checked,
  disabled,
  busy,
  readOnly = false,
  ariaLabel = 'Launch at sign-in',
  onChange
}: {
  checked: boolean
  disabled: boolean
  busy: boolean
  readOnly?: boolean
  ariaLabel?: string
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-readonly={readOnly}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={readOnly ? undefined : () => onChange(!checked)}
      className={`ui-control relative h-5 w-8 rounded-full border-0 ${
        checked
          ? 'bg-content-info'
          : 'bg-[var(--color-background-muted)]'
      } ${readOnly ? 'cursor-default' : ''} disabled:cursor-not-allowed disabled:opacity-45`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-[left] duration-150 ${
          checked ? 'left-[14px]' : 'left-0.5'
        }`}
      />
      <span className="sr-only">{busy ? 'Saving' : checked ? 'On' : 'Off'}</span>
    </button>
  )
}

function UpdateCheck({ previewMode }: { previewMode: boolean }): JSX.Element {
  const [status, setStatus] = useState('Current')
  const [busy, setBusy] = useState(false)

  const check = async (): Promise<void> => {
    if (previewMode) {
      setBusy(true)
      await new Promise((resolve) => window.setTimeout(resolve, 350))
      setStatus('Current')
      setBusy(false)
      return
    }
    if (typeof window.api?.checkUpdates !== 'function') return
    setBusy(true)
    const result = await window.api.checkUpdates()
    setBusy(false)
    switch (result.state) {
      case 'dev':
        setStatus('Development build')
        break
      case 'up-to-date':
        setStatus('Current')
        break
      case 'available':
        setStatus('Downloading')
        break
      case 'error':
        setStatus('Update check unavailable')
        break
      default:
        setStatus('Current')
    }
  }

  return (
    <button
      type="button"
      title="Check for updates"
      disabled={busy}
      onClick={() => void check()}
      className="ui-control flex items-center gap-1.5 rounded-md py-1 text-[14px] text-content-secondary hover:text-content-primary disabled:opacity-45"
    >
      <CircleCheck size={15} className="text-[var(--color-status-ok)]" />
      {busy ? 'Checking…' : status}
    </button>
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
    <div className="grid grid-cols-[1fr_auto] items-center gap-4 border-t border-edge-tertiary py-2.5 first:border-t-0 max-[560px]:grid-cols-1">
      <div className="min-w-0">
        <div className="text-[14px] font-medium text-content-primary">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] text-content-tertiary">{hint}</div>}
      </div>
      <div className="shrink-0 max-[560px]:w-full max-[560px]:justify-self-start">{children}</div>
    </div>
  )
}
