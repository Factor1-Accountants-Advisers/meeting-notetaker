import { app, BrowserWindow, ipcMain, nativeTheme, screen, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { logger } from './logger'
import { setMainWindow } from './recording-ipc'

interface CreateWindowOptions {
  showOnReady?: boolean
}

const DEFAULT_CONTENT_WIDTH = 620
const DEFAULT_CONTENT_HEIGHT = 560
const MIN_CONTENT_WIDTH = 400
const MIN_CONTENT_HEIGHT = 320
const MAX_CONTENT_HEIGHT = 680
const TITLE_BAR_HEIGHT = 40

type TitleBarTheme = 'light' | 'dark'

const titleBarOverlay = (theme: TitleBarTheme): Electron.TitleBarOverlay => ({
  color: theme === 'dark' ? '#2f2f2f' : '#e8e8e9',
  symbolColor: theme === 'dark' ? '#ffffff' : '#1a1c1f',
  height: TITLE_BAR_HEIGHT
})

const windowBackground = (theme: TitleBarTheme): string =>
  theme === 'dark' ? '#181818' : '#ffffff'

let appIsQuitting = false
app.on('before-quit', () => {
  appIsQuitting = true
})

export function createWindow(options: CreateWindowOptions = {}): void {
  const showOnReady = options.showOnReady ?? true
  const initialTheme: TitleBarTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  logger().info('[window] creating main window')
  const mainWindow = new BrowserWindow({
    width: DEFAULT_CONTENT_WIDTH,
    height: DEFAULT_CONTENT_HEIGHT,
    minWidth: MIN_CONTENT_WIDTH,
    minHeight: MIN_CONTENT_HEIGHT,
    useContentSize: true,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(initialTheme),
    backgroundColor: windowBackground(initialTheme),
    icon: join(__dirname, '../../build/icon.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // Expose the window for main→renderer IPC (recording commands, etc.)
  setMainWindow(mainWindow)
  mainWindow.center()

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

export function registerWindowSizingIpc(): void {
  ipcMain.on('window:set-content-height', (event, requestedHeight: number) => {
    if (!Number.isFinite(requestedHeight)) return
    const targetWindow = BrowserWindow.fromWebContents(event.sender)
    if (!targetWindow || targetWindow.isDestroyed() || targetWindow.isMaximized()) return

    const previousBounds = targetWindow.getBounds()
    const display = screen.getDisplayMatching(previousBounds)
    const availableHeight = Math.max(
      MIN_CONTENT_HEIGHT,
      display.workArea.height - 48
    )
    const nextHeight = Math.round(
      Math.min(MAX_CONTENT_HEIGHT, availableHeight, Math.max(MIN_CONTENT_HEIGHT, requestedHeight))
    )
    const [contentWidth, contentHeight] = targetWindow.getContentSize()
    if (Math.abs(contentHeight - nextHeight) < 2) return

    const centreX = previousBounds.x + previousBounds.width / 2
    const centreY = previousBounds.y + previousBounds.height / 2
    targetWindow.setContentSize(contentWidth, nextHeight)

    const nextBounds = targetWindow.getBounds()
    const workArea = display.workArea
    const nextX = Math.min(
      workArea.x + workArea.width - nextBounds.width,
      Math.max(workArea.x, Math.round(centreX - nextBounds.width / 2))
    )
    const nextY = Math.min(
      workArea.y + workArea.height - nextBounds.height,
      Math.max(workArea.y, Math.round(centreY - nextBounds.height / 2))
    )
    targetWindow.setPosition(nextX, nextY)
  })

  ipcMain.on('window:set-titlebar-theme', (event, theme: TitleBarTheme) => {
    if (theme !== 'light' && theme !== 'dark') return
    const targetWindow = BrowserWindow.fromWebContents(event.sender)
    if (!targetWindow || targetWindow.isDestroyed()) return
    targetWindow.setTitleBarOverlay(titleBarOverlay(theme))
    targetWindow.setBackgroundColor(windowBackground(theme))
  })
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return 'invalid-url'
  }
}
