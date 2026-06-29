import { app, ipcMain } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { logger } from './logger'

const STARTUP_ARG = '--background'
const PREFS_FILE = 'startup-preferences.json'

interface StartupPreferences {
  userConfiguredAutoLaunch?: boolean
}

export interface AutoLaunchStatus {
  supported: boolean
  enabled: boolean
  managedByDefault: boolean
  reason?: string
}

export function isBackgroundLaunch(): boolean {
  return process.argv.includes(STARTUP_ARG) || process.argv.includes('--hidden')
}

export function ensureDefaultAutoLaunchEnabled(): void {
  const prefs = readStartupPreferences()
  if (prefs.userConfiguredAutoLaunch) {
    logger().info('[startup] auto-launch default skipped; user has configured preference')
    return
  }

  if (!app.isPackaged) {
    logger().info('[startup] auto-launch default skipped in dev build')
    return
  }

  setAutoLaunchEnabled(true, false)
  logger().info('[startup] auto-launch enabled by default for packaged build')
}

export function registerStartupIpc(): void {
  ipcMain.handle('startup:get-auto-launch', () => getAutoLaunchStatus())
  ipcMain.handle('startup:set-auto-launch', (_event, enabled: boolean) => {
    setAutoLaunchEnabled(Boolean(enabled), true)
    return getAutoLaunchStatus()
  })
}

export function getAutoLaunchStatus(): AutoLaunchStatus {
  if (!isAutoLaunchSupported()) {
    return {
      supported: false,
      enabled: false,
      managedByDefault: false,
      reason: 'Auto-launch is available in the packaged Windows app.'
    }
  }

  const settings = app.getLoginItemSettings(loginItemSettings())
  return {
    supported: true,
    enabled: settings.openAtLogin,
    managedByDefault: !readStartupPreferences().userConfiguredAutoLaunch
  }
}

export function setAutoLaunchEnabled(enabled: boolean, userConfigured: boolean): void {
  if (!isAutoLaunchSupported()) {
    logger().info('[startup] auto-launch change skipped; unsupported in this runtime', {
      enabled,
      packaged: app.isPackaged,
      platform: process.platform
    })
    if (userConfigured) writeStartupPreferences({ userConfiguredAutoLaunch: true })
    return
  }

  app.setLoginItemSettings({
    ...loginItemSettings(),
    openAtLogin: enabled
  })

  if (userConfigured) writeStartupPreferences({ userConfiguredAutoLaunch: true })
  logger().info('[startup] auto-launch updated', { enabled, userConfigured })
}

function isAutoLaunchSupported(): boolean {
  return process.platform === 'win32' && app.isPackaged
}

function loginItemSettings(): Electron.Settings {
  return {
    path: process.execPath,
    args: [STARTUP_ARG]
  }
}

function preferencesPath(): string {
  return join(app.getPath('userData'), PREFS_FILE)
}

function readStartupPreferences(): StartupPreferences {
  try {
    return JSON.parse(readFileSync(preferencesPath(), 'utf-8')) as StartupPreferences
  } catch {
    return {}
  }
}

function writeStartupPreferences(prefs: StartupPreferences): void {
  const path = preferencesPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(prefs, null, 2))
}
