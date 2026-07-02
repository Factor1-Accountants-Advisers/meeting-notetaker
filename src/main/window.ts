import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { logger } from './logger'
import { setMainWindow } from './recording-ipc'

interface CreateWindowOptions {
  showOnReady?: boolean
}

let appIsQuitting = false
app.on('before-quit', () => {
  appIsQuitting = true
})

export function createWindow(options: CreateWindowOptions = {}): void {
  const showOnReady = options.showOnReady ?? true
  logger().info('[window] creating main window')
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 880,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#dfe3e9',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // Expose the window for main→renderer IPC (recording commands, etc.)
  setMainWindow(mainWindow)

  mainWindow.on('ready-to-show', () => {
    logger().info('[window] ready to show')
    if (showOnReady) mainWindow.show()
  })

  mainWindow.on('close', (event) => {
    if (appIsQuitting) return
    event.preventDefault()
    logger().info('[window] hiding main window to tray')
    mainWindow.hide()
  })

  mainWindow.on('closed', () => {
    setMainWindow(null)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    logger().info('[window] opening external URL', { origin: safeOrigin(details.url) })
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Renderer: HMR in dev, built file in prod.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return 'invalid-url'
  }
}
