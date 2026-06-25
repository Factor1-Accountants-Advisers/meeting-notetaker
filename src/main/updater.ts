import { app, ipcMain } from 'electron'
import updater from 'electron-updater'
import { logger } from './logger'

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
    logger().info('[updater] manual check requested', { packaged: app.isPackaged })
    if (!app.isPackaged) return { state: 'dev', version: app.getVersion() }
    try {
      const result = await autoUpdater.checkForUpdates()
      const latest = result?.updateInfo.version
      if (latest && latest !== app.getVersion()) {
        logger().info('[updater] update available', { version: latest })
        return { state: 'available', version: latest }
      }
      logger().info('[updater] app is up to date', { version: app.getVersion() })
      return { state: 'up-to-date', version: app.getVersion() }
    } catch (err) {
      logger().warn('[updater] manual check failed', {
        message: err instanceof Error ? err.message : String(err)
      })
      return { state: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  })
}

export function checkForUpdatesOnLaunch(): void {
  // Silent background check on launch (packaged builds only).
  if (app.isPackaged) {
    logger().info('[updater] launch check started')
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      // Feed unreachable (e.g. not provisioned yet) — never block startup.
      logger().warn('[updater] launch check failed', {
        message: err instanceof Error ? err.message : String(err)
      })
    })
  } else {
    logger().info('[updater] launch check skipped in dev/unpackaged build')
  }
}
