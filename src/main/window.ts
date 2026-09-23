import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, screen, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { logger } from './logger'
import { getRecordingStateMachine, setMainWindow } from './recording-ipc'
import { appIconPath } from './tray-icon'

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
    icon: loadWindowIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // Expose the window for main→renderer IPC (recording commands, etc.)
  setMainWindow(mainWindow)
  setWindowRecordingIcon(getRecordingStateMachine().getState() === 'recording')
  // Hiding to tray removes the taskbar button, and its overlay with it; put
  // the badge back whenever the button reappears.
  mainWindow.on('show', () => applyRecordingOverlay(mainWindow))
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

function loadWindowIcon(): Electron.NativeImage {
  const iconPath = appIconPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    mainDir: __dirname
  })
  try {
    const icon = nativeImage.createFromPath(iconPath)
    if (!icon.isEmpty()) return icon
  } catch {
    // Fall through to the empty image.
  }
  logger().warn('[window] app icon not found', { path: iconPath })
  return nativeImage.createEmpty()
}

// IN-495: the taskbar button shows a red-dot badge while recording. This is an
// overlay (ITaskbarList3::SetOverlayIcon), not setIcon(): the window shares
// the Start Menu shortcut's AppUserModelID, so Windows draws the button with
// the shortcut's icon and ignores setIcon() (confirmed in the IN-495 test).
let recordingOverlayOn = false
let recordingOverlayImage: Electron.NativeImage | null = null

/** Red dot, drawn in code so no extra asset has to ship. */
function recordingOverlay(): Electron.NativeImage {
  if (recordingOverlayImage) return recordingOverlayImage
  const image = nativeImage.createEmpty()
  for (const scaleFactor of [1, 1.25, 1.5, 2]) {
    const size = Math.round(16 * scaleFactor)
    image.addRepresentation({
      scaleFactor,
      width: size,
      height: size,
      buffer: redDotBitmap(size)
    })
  }
  recordingOverlayImage = image
  return image
}

/** size×size premultiplied BGRA (Skia N32 on Windows), anti-aliased edge. */
function redDotBitmap(size: number): Buffer {
  const buf = Buffer.alloc(size * size * 4)
  const c = size / 2
  const r = size / 2 - 0.5
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = Math.max(0, Math.min(1, r + 0.5 - Math.hypot(x + 0.5 - c, y + 0.5 - c)))
      const o = (y * size + x) * 4
      buf[o] = Math.round(0x2b * a) // B
      buf[o + 1] = Math.round(0x2b * a) // G
      buf[o + 2] = Math.round(0xe0 * a) // R
      buf[o + 3] = Math.round(255 * a)
    }
  }
  return buf
}

function applyRecordingOverlay(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.setOverlayIcon(recordingOverlayOn ? recordingOverlay() : null, recordingOverlayOn ? 'Recording' : '')
}

/** Show / clear the taskbar red-dot badge when recording starts or stops. */
export function setWindowRecordingIcon(recording: boolean): void {
  if (recording === recordingOverlayOn) return
  recordingOverlayOn = recording
  for (const win of BrowserWindow.getAllWindows()) applyRecordingOverlay(win)
  logger().info('[window] taskbar recording badge', { recording })
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return 'invalid-url'
  }
}
