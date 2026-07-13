import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { join } from 'path'
import { registerApiProxyIpc } from './api-proxy'
import { getCurrentUserEmail, getGraphAccessToken, onMsalSignedIn, registerAuthSessionIpc } from './auth-session'
import { startGraphDetectionRuntime } from './graph/runtime'
import { loadPublicEnv } from './env'
import { evaluateHostGate, hostGateLogContext } from './graph/host-gate'
import { initLogger, logger } from './logger'
import { registerMediaPermissions } from './media-permissions'
import {
  cleanupRecordingIpc,
  extendActiveRecordingFromMain,
  extendAutoStop,
  getRecordingStateMachine,
  handleRendererRecordingError,
  handleRendererRecordingReady,
  handleRendererRecordingStarted,
  handleRendererRecordingStopped,
  sendAutoStartRequest
} from './recording-ipc'
import { registerRecordingStorageIpc } from './recording-storage'
import { ensureDefaultAutoLaunchEnabled, isBackgroundLaunch, registerStartupIpc } from './startup'
import { createTray, destroyTray, setTraySkipped, updateTrayMenu } from './tray'
import { checkForUpdatesOnLaunch, registerUpdaterIpc } from './updater'
import { startBackendSupervisor, stopBackendSupervisor } from './backend-supervisor'
import { createWindow } from './window'
import type { GraphEventDecision } from './graph/types'

loadPublicEnv()
initLogger()
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
}

registerAuthSessionIpc()
registerApiProxyIpc()
registerRecordingStorageIpc()
registerUpdaterIpc()
registerStartupIpc()

function registerRecordingIpcHandlers(): void {
  ipcMain.on('renderer:debug-log', (_event, message: string, details?: unknown) => {
    logger().info('[renderer]', { message, details })
  })

  ipcMain.on('recording:ready', () => {
    handleRendererRecordingReady()
  })
  ipcMain.on('recording:started', () => {
    handleRendererRecordingStarted()
    updateTrayMenu()
  })
  ipcMain.on('recording:stopped', () => {
    handleRendererRecordingStopped()
    updateTrayMenu()
  })
  ipcMain.on('recording:error', (_event, message: string) => {
    handleRendererRecordingError(message)
    updateTrayMenu()
  })
  ipcMain.handle('recording:extend', () => extendAutoStop())
}

registerRecordingIpcHandlers()

function showMainWindow(): void {
  const windows = BrowserWindow.getAllWindows()
  if (windows.length > 0) {
    windows[0].show()
    windows[0].focus()
  } else {
    createWindow()
  }
}

app.on('second-instance', (_event, argv) => {
  // Toast "Extend 10 min" button (IN-124): Windows activates the app with this
  // argument. Extend in place without stealing focus to the window.
  if (argv.includes('mn-extend')) {
    logger().info('[app] extend requested from toast notification')
    extendActiveRecordingFromMain()
    return
  }
  if (argv.includes('--background') || argv.includes('--hidden')) {
    logger().info('[app] background second instance ignored')
    return
  }
  showMainWindow()
})

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.factor1.notetaker')
  logger().info('[app] ready')
  ensureDefaultAutoLaunchEnabled()

  checkForUpdatesOnLaunch()
  registerMediaPermissions()

  function handleAutoRecordEligible(decisions: GraphEventDecision[]): void {
    const eligible = decisions.filter((d) => d.autoRecordEligible && d.status === 'candidate')

    for (const decision of eligible) {
      const gate = evaluateHostGate(decision, getCurrentUserEmail())
      if (!gate.allowed) {
        logger().info('[app] auto-record skipped by host-gate', {
          ...hostGateLogContext(gate),
          ...decision.logContext
        })
        setTraySkipped(decision.metadata?.title ?? null)
        continue
      }

      const key = decision.idempotencyKey ?? decision.eventId
      const sm = getRecordingStateMachine()
      if (!sm.canStartAutoRecording(key)) {
        logger().info('[app] auto-record skipped: already recorded or recording active', {
          idempotencyKey: key
        })
        continue
      }

      logger().info('[app] auto-record triggered', {
        idempotencyKey: key,
        startUtc: decision.logContext.startUtc,
        endUtc: decision.logContext.endUtc,
        ...decision.logContext
      })

      sendAutoStartRequest({
        eventId: decision.eventId,
        idempotencyKey: key,
        startTimeUtc: decision.logContext.startUtc ?? '',
        endTimeUtc: decision.logContext.endUtc ?? '',
        source: 'auto',
        metadata: decision.metadata
      })
    }
  }

  const graphRuntime = startGraphDetectionRuntime({
    statePath: join(app.getPath('userData'), 'graph', 'scheduler-state.json'),
    getAccessToken: getGraphAccessToken,
    getSignedInEmail: getCurrentUserEmail,
    logger: logger(),
    onAutoRecordEligible: handleAutoRecordEligible
  })

  onMsalSignedIn(() => {
    logger().info('[graph] sign-in completed; triggering immediate sync')
    void graphRuntime.syncNow().then((result) => {
      logger().info('[graph] post-sign-in sync finished', {
        status: result.status,
        decisions: result.decisions.length
      })
      if (result.status === 'success') graphRuntime.startPolling()
    })
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Trigger a sync when the system wakes from sleep.
  if (powerMonitor) {
    powerMonitor.on('resume', () => {
      logger().info('[app] system resumed from sleep')
      graphRuntime.scheduleResumeSync()
    })
    powerMonitor.on('unlock-screen', () => {
      logger().info('[app] screen unlocked')
      graphRuntime.scheduleResumeSync()
    })
  }

  createWindow({ showOnReady: !isBackgroundLaunch() })
  createTray(showMainWindow)

  // Packaged builds: spawn + supervise backend (dev uses external uvicorn).
  startBackendSupervisor().catch((err) => {
    logger().error('[app] backend supervisor failed to start', {
      message: err instanceof Error ? err.message : String(err)
    })
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// With a tray, closing all windows should not quit the app.
app.on('window-all-closed', () => {
  // Keep running in tray on all platforms.
})

app.on('before-quit', () => {
  cleanupRecordingIpc()
  stopBackendSupervisor()
  destroyTray()
})
