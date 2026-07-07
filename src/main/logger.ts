import { app } from 'electron'
import log from 'electron-log/main'
import { mkdirSync, renameSync } from 'fs'
import { dirname, join } from 'path'

export interface LogInfo {
  logDir: string
  mainLog: string
  backendLog: string
  rendererLog: string
}

let initialized = false
let logInfo: LogInfo | null = null

export function initLogger(): LogInfo {
  if (initialized && logInfo) return logInfo

  const logDir = join(app.getPath('userData'), 'logs')
  const mainLog = join(logDir, 'main.log')
  const backendLog = join(logDir, 'backend.log')
  const rendererLog = join(logDir, 'renderer.log')
  logInfo = { logDir, mainLog, backendLog, rendererLog }

  mkdirSync(logDir, { recursive: true })
  log.initialize()
  log.transports.file.resolvePathFn = () => mainLog
  log.transports.file.maxSize = 5 * 1024 * 1024
  log.transports.file.archiveLogFn = (oldLogFile) => {
    const archivedPath = join(dirname(oldLogFile.path), 'main.old.log')
    try {
      renameSync(oldLogFile.path, archivedPath)
    } catch {
      oldLogFile.clear()
    }
  }

  console.log = log.info.bind(log)
  console.info = log.info.bind(log)
  console.warn = log.warn.bind(log)
  console.error = log.error.bind(log)
  console.debug = log.debug.bind(log)

  process.on('uncaughtException', (error) => {
    log.error('[process] uncaughtException', error)
    // Rethrow crashes the main process; backend-supervisor's process 'exit'
    // hook force-kills the backend child on that path, so no orphan remains.
    throw error
  })

  process.on('unhandledRejection', (reason) => {
    log.error('[process] unhandledRejection', reason)
  })

  initialized = true
  log.info('[app] startup', {
    version: typeof app.getVersion === 'function' ? app.getVersion() : 'unknown',
    packaged: app.isPackaged,
    userData: app.getPath('userData'),
    mainLog
  })

  return logInfo
}

export function getLogInfo(): LogInfo {
  return logInfo ?? initLogger()
}

export function logger(): typeof log {
  return log
}
