import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
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

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `Status: ${statusLabel}`,
      enabled: false
    },
    { type: 'separator' },
    ...recordingControls,
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
  // Generate a simple 16x16 tray icon: a coloured square with the app initial.
  // In production this should be replaced with a proper .ico file.
  const size = 16
  const canvas = Buffer.alloc(size * size * 4)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4
      // Rounded square with blue fill
      const cx = size / 2, cy = size / 2
      const dx = Math.abs(x - cx + 0.5), dy = Math.abs(y - cy + 0.5)
      const r = size / 2 - 1
      if (dx * dx + dy * dy <= r * r) {
        canvas[offset] = 0x00   // R
        canvas[offset + 1] = 0x76 // G
        canvas[offset + 2] = 0xBF // B — brand blue
        canvas[offset + 3] = 0xFF // A
      }
    }
  }

  return nativeImage.createFromBuffer(canvas, {
    width: size,
    height: size
  })
}
