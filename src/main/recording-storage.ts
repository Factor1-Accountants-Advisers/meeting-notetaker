import { app, ipcMain } from 'electron'
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { logger } from './logger'

// Lazy (not @electron-toolkit/utils `is.dev`, which reads app.isPackaged at
// import time): this module's pure helpers run under plain node in
// verify:saved-captures, where electron exports are undefined.
function isDev(): boolean {
  return !app.isPackaged
}

function recordingDir(): string {
  // Dev: save inside the repo — when the app is launched from a sandboxed
  // shell (e.g. Claude's MSIX package), AppData writes get virtualized into
  // the package's LocalCache and become invisible in Explorer. Repo paths
  // are not redirected. Production keeps userData.
  return isDev() ? join(app.getAppPath(), 'recordings') : join(app.getPath('userData'), 'recordings')
}

function safeRecordingName(name: string): string {
  // Keep the name strictly ours: id + extension only.
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}

// ---------------------------------------------------------------------------
// Crash-safe capture spill (IN-129).
//
// The renderer's MediaRecorder emits a chunk every second; each chunk is
// appended here so a lid-close/sleep/crash loses at most ~1s of audio instead
// of the whole meeting. Concatenated timeslice chunks from one MediaRecorder
// session form a valid WebM stream, so the .part file IS the recording.
// A clean stop discards the spill; leftovers are offered for recovery on the
// next launch via recording:spill-list.
// ---------------------------------------------------------------------------

export type SpillStream = 'mic' | 'sys'

export interface SpillMeta {
  title: string
  meetingId: string | null
  source: 'online' | 'in_person'
  mimeType: string
  startedAtUtc: string
  graphMetadata?: unknown
}

export interface SpillEntry extends SpillMeta {
  key: string
  micBytes: number
  sysBytes: number
  /** Last chunk write time — approximates when the recording was interrupted. */
  endedAtUtc: string
}

// ---------------------------------------------------------------------------
// Saved-capture recovery (resurface on restart, 25 Aug 2026).
//
// A failed upload's retry notice dies with the renderer session, but the
// saved capture set and the backend's pending_audio meeting record survive.
// These helpers let the startup scan find the sets, and retry/cleanup treat
// a meeting's files as one unit. The backend record — never the files — is
// the gate that decides whether a recovery card is offered.
// ---------------------------------------------------------------------------

export interface SavedCaptureEntry {
  meetingId: string
  savedAtUtc: string
}

const PRIMARY_CAPTURE_NAME =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.webm$/i

/** The meeting id when `name` is a primary saved capture (`{uuid}.webm`). */
export function primarySavedMeetingId(name: string): string | null {
  const match = name.match(PRIMARY_CAPTURE_NAME)
  return match ? match[1] : null
}

/** Every file in a meeting's saved capture set (mic, system tracks, manifest). */
export function savedCaptureSetNames(names: string[], meetingId: string): string[] {
  return names.filter((name) => name.startsWith(`${meetingId}.`))
}

function spillDir(): string {
  return join(recordingDir(), 'spill')
}

function spillPartPath(key: string, stream: SpillStream): string {
  return join(spillDir(), `${safeRecordingName(key)}.${stream}.part`)
}

function spillMetaPath(key: string): string {
  return join(spillDir(), `${safeRecordingName(key)}.meta.json`)
}

// Appends for the same part file must land in emission order or the WebM
// stream corrupts; chain them per file. Entries are dropped on discard.
const appendChains = new Map<string, Promise<void>>()

function chainAppend(path: string, data: Buffer): Promise<void> {
  const prev = appendChains.get(path) ?? Promise.resolve()
  const next = prev.then(() => appendFile(path, data)).catch((err) => {
    logger().warn('[recording] spill append failed', {
      path,
      message: err instanceof Error ? err.message : String(err)
    })
  })
  appendChains.set(path, next)
  return next
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
        devMode: isDev()
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
          devMode: isDev()
        })
        return {
          exists: true,
          data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          logger().warn('[recording] local capture missing for retry', { fileName: safe, devMode: isDev() })
          return { exists: false }
        }
        throw err
      }
    }
  )

  // List saved capture sets so the startup scan can offer recovery for
  // meetings the backend still marks pending_audio (resurface on restart).
  ipcMain.handle('recording:list-saved', async (): Promise<SavedCaptureEntry[]> => {
    let names: string[]
    try {
      names = await readdir(recordingDir())
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const entries: SavedCaptureEntry[] = []
    for (const name of names) {
      const meetingId = primarySavedMeetingId(name)
      if (!meetingId) continue
      try {
        const info = await stat(join(recordingDir(), name))
        entries.push({ meetingId, savedAtUtc: new Date(info.mtimeMs).toISOString() })
      } catch {
        // Raced deletion — skip.
      }
    }
    if (entries.length) {
      logger().info('[recording] saved capture sets found', { count: entries.length })
    }
    return entries
  })

  // Remove a meeting's whole capture set — after a successful upload (the
  // server owns the audio now) or an explicit discard from the recovery card.
  ipcMain.handle('recording:delete-saved', async (_event, meetingId: string): Promise<void> => {
    if (!primarySavedMeetingId(`${meetingId}.webm`)) {
      logger().warn('[recording] delete-saved refused non-uuid id', { meetingId })
      return
    }
    let names: string[]
    try {
      names = await readdir(recordingDir())
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    const targets = savedCaptureSetNames(names, meetingId)
    for (const name of targets) {
      await rm(join(recordingDir(), name), { force: true })
    }
    logger().info('[recording] saved capture set removed', {
      meetingId,
      files: targets.length
    })
  })

  // --- Spill IPC (IN-129) ---

  ipcMain.handle('recording:spill-open', async (_event, key: string, meta: SpillMeta): Promise<void> => {
    await mkdir(spillDir(), { recursive: true })
    await writeFile(spillMetaPath(key), JSON.stringify(meta, null, 2))
    logger().info('[recording] spill session opened', { key, meetingId: meta.meetingId, devMode: isDev() })
  })

  ipcMain.handle(
    'recording:spill-chunk',
    (_event, key: string, stream: SpillStream, data: ArrayBuffer): Promise<void> =>
      chainAppend(spillPartPath(key, stream), Buffer.from(data))
  )

  ipcMain.handle('recording:spill-discard', async (_event, key: string): Promise<void> => {
    for (const stream of ['mic', 'sys'] as const) {
      const path = spillPartPath(key, stream)
      // Let any in-flight append settle before deleting under it.
      await appendChains.get(path)
      appendChains.delete(path)
      await rm(path, { force: true })
    }
    await rm(spillMetaPath(key), { force: true })
    logger().info('[recording] spill session discarded', { key })
  })

  ipcMain.handle('recording:spill-list', async (): Promise<SpillEntry[]> => {
    let names: string[]
    try {
      names = await readdir(spillDir())
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }

    const entries: SpillEntry[] = []
    for (const name of names) {
      if (!name.endsWith('.meta.json')) continue
      const key = name.slice(0, -'.meta.json'.length)
      try {
        const meta = JSON.parse(await readFile(spillMetaPath(key), 'utf8')) as SpillMeta
        const micStat = await stat(spillPartPath(key, 'mic')).catch(() => null)
        const sysStat = await stat(spillPartPath(key, 'sys')).catch(() => null)
        // A session with no audio bytes is unrecoverable noise — clean it up.
        if (!micStat?.size && !sysStat?.size) {
          await rm(spillMetaPath(key), { force: true })
          continue
        }
        const lastWrite = Math.max(micStat?.mtimeMs ?? 0, sysStat?.mtimeMs ?? 0)
        entries.push({
          ...meta,
          key,
          micBytes: micStat?.size ?? 0,
          sysBytes: sysStat?.size ?? 0,
          endedAtUtc: new Date(lastWrite).toISOString()
        })
      } catch (err) {
        logger().warn('[recording] unreadable spill meta skipped', {
          key,
          message: err instanceof Error ? err.message : String(err)
        })
      }
    }
    if (entries.length) {
      logger().info('[recording] interrupted recordings found', { count: entries.length })
    }
    return entries
  })

  ipcMain.handle(
    'recording:spill-read',
    async (_event, key: string, stream: SpillStream): Promise<{ exists: boolean; data?: ArrayBuffer }> => {
      try {
        const data = await readFile(spillPartPath(key, stream))
        return {
          exists: true,
          data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }
        throw err
      }
    }
  )
}
