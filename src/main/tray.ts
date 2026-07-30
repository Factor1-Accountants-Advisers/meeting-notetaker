import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
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

  const icon = createTrayIcon()
  tray = new Tray(icon)
  showWindowCallback = onShowWindow

  tray.setToolTip('Meeting Notetaker')
  updateTrayMenu()

  tray.on('click', () => {
    showWindowCallback?.()
  })
}

export function updateTrayMenu(): void {
  if (!tray) return

  const sm = getRecordingStateMachine()
  const state = sm.getState()
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
        tray?.destroy()
        tray = null
        app.quit()
      }
    }
  ])

  tray.setContextMenu(contextMenu)
  tray.setToolTip(`Meeting Notetaker — ${statusLabel}`)
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
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

function createTrayIcon(): Electron.NativeImage {
  // IN-472: load the app logo from resources/ (dev) or extraResources (packaged).
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'tray-icon.png')
    : join(__dirname, '..', '..', 'resources', 'tray-icon.png')

  try {
    const icon = nativeImage.createFromPath(iconPath)
    if (!icon.isEmpty()) {
      return icon
    }
  } catch {
    // Fall through to generated fallback.
  }

  logger().warn('[tray] logo not found, using generated fallback', { path: iconPath })
  // Generated fallback — same blue circle as before, kept as a safety net.
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
