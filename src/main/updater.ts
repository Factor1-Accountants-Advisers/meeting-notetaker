import { app, ipcMain } from 'electron'
import updater from 'electron-updater'
import { logger } from './logger'
import { isBackendBusy } from './update-gate'

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

// IN-469: probe the local backend for in-flight pipeline work before letting
// an update auto-install. Every failure path returns true (busy) — we only
// install when the backend provably has nothing in flight.
async function fetchBackendBusy(getActor: () => string): Promise<boolean> {
  const actor = getActor()
  // Fail-open guard: list_meetings filters by can_see(actor). An
  // unauthenticated/default actor gets an EMPTY list — which would read
  // as "not busy" while work may be in flight. Can't prove quiet → busy.
  if (!actor || actor === 'Unknown user') return true
  try {
    const res = await fetch('http://127.0.0.1:8787/api/v1/meetings', {
      headers: { 'X-MN-User': actor },
      signal: AbortSignal.timeout(5_000)
    })
    if (!res.ok) return true // can't prove quiet — fail safe, block install
    const meetings = (await res.json()) as Array<{ pipeline_status: string; created_at: string }>
    return isBackendBusy(meetings, Date.now())
  } catch {
    return true // backend unreachable mid-restart etc. — block install this cycle
  }
}
void fetchBackendBusy // wired in Task 5

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
