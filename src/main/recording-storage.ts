import { app, ipcMain } from 'electron'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { logger } from './logger'

export function registerRecordingStorageIpc(): void {
  // Save a finished capture to disk. Files live under userData/recordings until
  // the upload-to-Blob pipeline lands; raw audio retention rules apply there.
  ipcMain.handle(
    'recording:save',
    async (_event, name: string, data: ArrayBuffer): Promise<{ path: string }> => {
      // Dev: save inside the repo — when the app is launched from a sandboxed
      // shell (e.g. Claude's MSIX package), AppData writes get virtualized into
      // the package's LocalCache and become invisible in Explorer. Repo paths
      // are not redirected. Production keeps userData.
      const dir = is.dev
        ? join(app.getAppPath(), 'recordings')
        : join(app.getPath('userData'), 'recordings')
      await mkdir(dir, { recursive: true })
      // Keep the name strictly ours: id + extension only.
      const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const filePath = join(dir, safe)
      await writeFile(filePath, Buffer.from(data))
      logger().info('[recording] saved local capture', {
        fileName: safe,
        bytes: data.byteLength,
        devMode: is.dev
      })
      return { path: filePath }
    }
  )
}
