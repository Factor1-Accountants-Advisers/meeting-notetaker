import { app, ipcMain } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { logger } from './logger'

function recordingDir(): string {
  // Dev: save inside the repo — when the app is launched from a sandboxed
  // shell (e.g. Claude's MSIX package), AppData writes get virtualized into
  // the package's LocalCache and become invisible in Explorer. Repo paths
  // are not redirected. Production keeps userData.
  return is.dev ? join(app.getAppPath(), 'recordings') : join(app.getPath('userData'), 'recordings')
}

function safeRecordingName(name: string): string {
  // Keep the name strictly ours: id + extension only.
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}

export function registerRecordingStorageIpc(): void {
  // Save a finished capture to disk. Files live under userData/recordings until
  // the upload-to-Blob pipeline lands; raw audio retention rules apply there.
  ipcMain.handle(
    'recording:save',
    async (_event, name: string, data: ArrayBuffer): Promise<{ path: string }> => {
      const dir = recordingDir()
      await mkdir(dir, { recursive: true })
      const safe = safeRecordingName(name)
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

  // Read a previously saved capture so upload failures are recoverable without rerecording.
  ipcMain.handle(
    'recording:read',
    async (_event, name: string): Promise<{ exists: boolean; data?: ArrayBuffer }> => {
      const safe = safeRecordingName(name)
      const filePath = join(recordingDir(), safe)
      try {
        const data = await readFile(filePath)
        logger().info('[recording] loaded local capture for retry', {
          fileName: safe,
          bytes: data.byteLength,
          devMode: is.dev
        })
        return {
          exists: true,
          data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          logger().warn('[recording] local capture missing for retry', { fileName: safe, devMode: is.dev })
          return { exists: false }
        }
        throw err
      }
    }
  )
}
