import { app, ipcMain } from 'electron'
import updater from 'electron-updater'

// electron-updater is CommonJS; named ESM imports fail at runtime.
const { autoUpdater } = updater

// Updates (decision #12): electron-updater against the static Blob feed.
// Background download, install on restart. No-ops in dev / unpackaged builds.
export interface UpdateStatus {
  state: 'dev' | 'checking' | 'up-to-date' | 'available' | 'downloaded' | 'error'
  version?: string
  message?: string
}

autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true

export function registerUpdaterIpc(): void {
  ipcMain.handle('updates:check', async (): Promise<UpdateStatus> => {
    if (!app.isPackaged) return { state: 'dev', version: app.getVersion() }
    try {
      const result = await autoUpdater.checkForUpdates()
      const latest = result?.updateInfo.version
      if (latest && latest !== app.getVersion()) {
        return { state: 'available', version: latest }
      }
      return { state: 'up-to-date', version: app.getVersion() }
    } catch (err) {
      return { state: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  })
}

export function checkForUpdatesOnLaunch(): void {
  // Silent background check on launch (packaged builds only).
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {
      // Feed unreachable (e.g. not provisioned yet) — never block startup.
    })
  }
}
