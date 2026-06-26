import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { join } from 'path'
import { registerApiProxyIpc } from './api-proxy'
import { getCurrentUserEmail, getGraphAccessToken, registerAuthSessionIpc } from './auth-session'
import { startGraphDetectionRuntime } from './graph/runtime'
import { initLogger, logger } from './logger'
import { registerMediaPermissions } from './media-permissions'
import { registerRecordingStorageIpc } from './recording-storage'
import { checkForUpdatesOnLaunch, registerUpdaterIpc } from './updater'
import { createWindow } from './window'

initLogger()
registerAuthSessionIpc()
registerApiProxyIpc()
registerRecordingStorageIpc()
registerUpdaterIpc()

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.factor1.notetaker')
  logger().info('[app] ready')

  checkForUpdatesOnLaunch()
  registerMediaPermissions()
  startGraphDetectionRuntime({
    statePath: join(app.getPath('userData'), 'graph', 'scheduler-state.json'),
    getAccessToken: getGraphAccessToken,
    getSignedInEmail: getCurrentUserEmail,
    logger: logger()
  })

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
