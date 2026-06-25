import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { registerApiProxyIpc } from './api-proxy'
import { registerAuthSessionIpc } from './auth-session'
import { registerMediaPermissions } from './media-permissions'
import { registerRecordingStorageIpc } from './recording-storage'
import { checkForUpdatesOnLaunch, registerUpdaterIpc } from './updater'
import { createWindow } from './window'

registerAuthSessionIpc()
registerApiProxyIpc()
registerRecordingStorageIpc()
registerUpdaterIpc()

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.factor1.notetaker')

  checkForUpdatesOnLaunch()
  registerMediaPermissions()

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
