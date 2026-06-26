import { app, Menu, nativeImage, Tray } from 'electron'
import { getRecordingStateMachine } from './recording-ipc'
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

  const statusLabel = state === 'recording'
    ? 'Recording…'
    : state === 'processing'
      ? 'Processing…'
      : 'Idle'

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `Status: ${statusLabel}`,
      enabled: false
    },
    { type: 'separator' },
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
