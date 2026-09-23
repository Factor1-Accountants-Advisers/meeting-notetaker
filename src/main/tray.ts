import {
  app,
  Menu,
  nativeImage,
  nativeTheme,
  Tray,
  type MenuItemConstructorOptions
} from 'electron'
import { execFileSync } from 'child_process'
import {
  parseRegDword,
  resolveTrayTheme,
  trayIconPath,
  type TrayIconVariant,
  type TrayTheme,
  type TrayThemeSignals
} from './tray-icon'
import { setWindowRecordingIcon } from './window'
import {
  extendActiveRecordingFromMain,
  getRecordingStateMachine,
  hasExtendableRecording,
  isRecordingPaused,
  meetingTitleFrom,
  sendTrayRecordingControl
} from './recording-ipc'
import { logger } from './logger'

let tray: Tray | null = null
let showWindowCallback: (() => void) | null = null

// IN-472 fix: which icon variant is currently on screen, so we only call setImage
// when the theme actually flips. Recording (red-dot) is tracked the same way.
let appliedTrayTheme: TrayTheme | null = null
let appliedRecording = false
let themeListener: (() => void) | null = null

// IN-469: downloaded-update surfacing. tray.ts deliberately does not import
// updater.ts — the restart action is injected from index.ts (same pattern as
// showWindowCallback) so no tray↔updater dependency can form.
let updateReadyVersion: string | null = null
let onRestartRequested: (() => void) | null = null

export function setUpdateRestartHandler(fn: () => void): void {
  onRestartRequested = fn
}

/** Show/clear the "Restart to update" tray item. Pass null to clear. */
export function setUpdateReady(version: string | null): void {
  updateReadyVersion = version
  updateTrayMenu()
}

export function createTray(onShowWindow: () => void): void {
  if (tray) return

  const theme = currentTrayTheme()
  tray = new Tray(createTrayIcon(theme))
  appliedTrayTheme = theme
  showWindowCallback = onShowWindow
  // Logged so a "my tray icon is blank" report can be diagnosed from the log
  // alone, without asking the user to read their Windows colour settings.
  logger().info('[tray] icon theme at startup', { theme })

  tray.setToolTip('Meeting Notetaker')
  updateTrayMenu()

  // IN-472 fix: Windows users flip theme at runtime and the tray must follow, or
  // the icon goes invisible until the next restart. 'updated' does not say what
  // changed, so the handler re-resolves from scratch.
  //
  // Measured on Windows 11 (Electron 33.4.11): 'updated' DOES fire when only
  // SystemUsesLightTheme changes, even though shouldUseDarkColors is unmoved by
  // it. So this listener alone is sufficient — no polling, and no re-check on
  // click. It fires TWICE per change (~30ms apart), which applyTrayIcon's
  // no-change guard absorbs.
  themeListener = () => applyTrayIcon()
  nativeTheme.on('updated', themeListener)

  tray.on('click', () => {
    showWindowCallback?.()
  })
}

export function updateTrayMenu(): void {
  const sm = getRecordingStateMachine()
  const state = sm.getState()
  setWindowRecordingIcon(state === 'recording')
  if (!tray) return

  // Surface the meeting title in the tooltip per IN-77 acceptance criteria.
  // Auto-recordings carry it in metadata; manual/ad-hoc fall back to generic.
  const title = meetingTitleFrom(sm.getActiveRecording()?.metadata)

  const statusLabel = state === 'recording'
    ? (title ? `Recording: ${title}` : 'Recording…')
    : state === 'processing'
      ? (title ? `Processing: ${title}` : 'Processing…')
      : 'Idle'

  const recordingControls: MenuItemConstructorOptions[] =
    state === 'recording'
      ? [
          isRecordingPaused()
            ? { label: 'Resume recording', click: () => sendTrayRecordingControl('resume') }
            : { label: 'Pause recording', click: () => sendTrayRecordingControl('pause') },
          ...(hasExtendableRecording()
            ? [{ label: 'Extend 10 min', click: () => extendActiveRecordingFromMain() }]
            : []),
          { label: 'Stop recording', click: () => sendTrayRecordingControl('stop') },
          { type: 'separator' }
        ]
      : []

  const updateControls: MenuItemConstructorOptions[] = updateReadyVersion
    ? [
        {
          label: `Restart to update to ${updateReadyVersion}`,
          click: () => onRestartRequested?.()
        },
        { type: 'separator' }
      ]
    : []

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `Status: ${statusLabel}`,
      enabled: false
    },
    { type: 'separator' },
    ...recordingControls,
    ...updateControls,
    {
      label: 'Show Notetaker',
      click: () => showWindowCallback?.()
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        // destroyTray (not tray.destroy) so the nativeTheme listener comes off too.
        destroyTray()
        app.quit()
      }
    }
  ])

  tray.setContextMenu(contextMenu)
  tray.setToolTip(`Meeting Notetaker — ${statusLabel}`)
  applyTrayIcon()
}

export function destroyTray(): void {
  if (themeListener) {
    nativeTheme.off('updated', themeListener)
    themeListener = null
  }
  if (tray) {
    tray.destroy()
    tray = null
  }
  appliedTrayTheme = null
  appliedRecording = false
  showWindowCallback = null
}

/**
 * Show the transient "Skipped: [title] (not host)" tooltip when a meeting is
 * skipped because the user is not the organiser (IN-77/IN-84). Cleared on the
 * next recording state change via updateTrayMenu().
 */
export function setTraySkipped(title: string | null): void {
  if (!tray) return
  const label = title ? `Skipped: ${title} (not host)` : 'Skipped (not host)'
  tray.setToolTip(`Meeting Notetaker — ${label}`)
}

/** Set an alert tooltip override (e.g. \"Backend unavailable\"). Pass null to restore. */
export function setTrayAlert(message: string | null): void {
  if (!tray) return
  if (message) {
    tray.setToolTip(`Meeting Notetaker — ⚠ ${message}`)
  } else {
    updateTrayMenu() // restores normal tooltip
  }
}

export function setAutoLaunch(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath
  })
  logger().info('[tray] auto-launch updated', { enabled })
}

export function isAutoLaunchEnabled(): boolean {
  return app.getLoginItemSettings().openAtLogin
}

const PERSONALIZE_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'

/**
 * Read one REG_DWORD from the Personalize key. Fixed arguments, no shell —
 * same pattern as the netstat call in backend-supervisor.ts. Returns null on
 * any failure (non-Windows, locked-down profile, missing value), which the
 * resolver is required to tolerate.
 */
function readPersonalizeFlag(valueName: string): boolean | null {
  if (process.platform !== 'win32') return null
  try {
    const output = execFileSync('reg', ['query', PERSONALIZE_KEY, '/v', valueName], {
      encoding: 'utf8',
      timeout: 2_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return parseRegDword(output, valueName)
  } catch {
    return null
  }
}

function readTrayThemeSignals(): TrayThemeSignals {
  return {
    systemUsesLightTheme: readPersonalizeFlag('SystemUsesLightTheme'),
    appsUseLightTheme: readPersonalizeFlag('AppsUseLightTheme'),
    electronPrefersDark: nativeTheme.shouldUseDarkColors
  }
}

/**
 * Resolve the theme, defensively. A throw here would take out tray creation
 * on startup, so a resolver bug degrades to Electron's own signal — the
 * pre-fix behaviour — rather than leaving the user with no tray at all.
 */
function currentTrayTheme(): TrayTheme {
  try {
    const theme = resolveTrayTheme(readTrayThemeSignals())
    if (theme === 'light' || theme === 'dark') return theme
    logger().error('[tray] resolveTrayTheme returned an invalid theme', { theme })
  } catch (error) {
    logger().error('[tray] resolveTrayTheme threw', { error: String(error) })
  }
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

function trayRecordingVariant(): TrayIconVariant {
  return getRecordingStateMachine().getState() === 'recording' ? 'recording' : 'idle'
}

/** Re-resolve and swap the icon if the taskbar theme or recording state changed. */
function applyTrayIcon(): void {
  if (!tray) return
  const theme = currentTrayTheme()
  const recording = trayRecordingVariant() === 'recording'
  if (theme === appliedTrayTheme && recording === appliedRecording) return
  tray.setImage(createTrayIcon(theme, recording))
  appliedTrayTheme = theme
  appliedRecording = recording
  logger().info('[tray] icon updated', { theme, recording })
}

function createTrayIcon(theme: TrayTheme, recording = false): Electron.NativeImage {
  // IN-472 fix: multi-size .ico (16/20/24/32) per taskbar theme, from resources/
  // (dev) or extraResources (packaged). Recording uses the red-dot twin.
  const paths = {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    mainDir: __dirname
  }
  const variants: TrayIconVariant[] = recording ? ['recording', 'idle'] : ['idle']

  for (const variant of variants) {
    const iconPath = trayIconPath(theme, paths, variant)
    try {
      const icon = nativeImage.createFromPath(iconPath)
      if (!icon.isEmpty()) {
        return icon
      }
    } catch {
      // Try the next variant, then the generated fallback.
    }
  }

  const iconPath = trayIconPath(theme, paths, recording ? 'recording' : 'idle')
  logger().warn('[tray] logo not found, using generated fallback', { path: iconPath, theme, recording })
  // Generated fallback — same blue circle as before, kept as a safety net.
  // Deliberately brand blue rather than monochrome: it has to stay legible on
  // both taskbar themes, since reaching here means we could not load either
  // theme-specific icon.
  const size = 16
  const canvas = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4
      const cx = size / 2, cy = size / 2
      const dx = Math.abs(x - cx + 0.5), dy = Math.abs(y - cy + 0.5)
      const r = size / 2 - 1
      if (dx * dx + dy * dy <= r * r) {
        canvas[offset] = 0x00
        canvas[offset + 1] = 0x76
        canvas[offset + 2] = 0xBF
        canvas[offset + 3] = 0xFF
      }
    }
  }
  return nativeImage.createFromBuffer(canvas, { width: size, height: size })
}
