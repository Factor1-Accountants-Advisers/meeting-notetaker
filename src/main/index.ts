import { app, shell, BrowserWindow, desktopCapturer, ipcMain, session } from 'electron'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

// All backend traffic goes through the main process: the renderer never holds
// credentials or talks to the network directly (thin-client rule). Entra ID
// tokens will be attached here once auth lands.
const API_BASE = process.env.MN_API_BASE ?? 'http://127.0.0.1:8787'

interface ApiRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
}

ipcMain.handle('api:request', async (_event, req: ApiRequest) => {
  try {
    const res = await fetch(`${API_BASE}${req.path}`, {
      method: req.method,
      headers: req.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined
    })
    const text = await res.text()
    return { ok: res.ok, status: res.status, body: text ? JSON.parse(text) : null }
  } catch {
    // Backend not running / unreachable — renderer falls back to sample data.
    return { ok: false, status: 0, body: null }
  }
})

function createWindow(): void {
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

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
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

// Save a finished capture to disk. Files live under userData/recordings until
// the upload-to-Blob pipeline lands; raw audio retention rules apply there.
ipcMain.handle(
  'recording:save',
  async (_event, name: string, data: ArrayBuffer): Promise<{ path: string }> => {
    const dir = join(app.getPath('userData'), 'recordings')
    await mkdir(dir, { recursive: true })
    // Keep the name strictly ours: id + extension only.
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const filePath = join(dir, safe)
    await writeFile(filePath, Buffer.from(data))
    return { path: filePath }
  }
)

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.factor1.notetaker')

  // WASAPI loopback (decision #6): grant getDisplayMedia requests system-audio
  // loopback without showing a picker. Renderer drops the mandatory video track.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
        .catch(() => callback({}))
    },
    { useSystemPicker: false }
  )

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
