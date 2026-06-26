import { app, BrowserWindow, powerMonitor } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { join } from 'path'
import { registerApiProxyIpc } from './api-proxy'
import { getCurrentUserEmail, getGraphAccessToken, registerAuthSessionIpc } from './auth-session'
import { startGraphDetectionRuntime } from './graph/runtime'
import { evaluateHostGate, hostGateLogContext } from './graph/host-gate'
import { initLogger, logger } from './logger'
import { registerMediaPermissions } from './media-permissions'
import { createRecordingStateMachine } from './recording-state'
import { registerRecordingStorageIpc } from './recording-storage'
import { checkForUpdatesOnLaunch, registerUpdaterIpc } from './updater'
import { createWindow } from './window'
import type { GraphEventDecision } from './graph/types'

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

  const recordingSM = createRecordingStateMachine()

  function handleAutoRecordEligible(decisions: GraphEventDecision[]): void {
    const eligible = decisions.filter((d) => d.autoRecordEligible && d.status === 'candidate')

    for (const decision of eligible) {
      const gate = evaluateHostGate(decision, getCurrentUserEmail())
      if (!gate.allowed) {
        logger().info('[app] auto-record skipped by host-gate', {
          ...hostGateLogContext(gate),
          ...decision.logContext
        })
        continue
      }

      const key = decision.idempotencyKey ?? decision.eventId
      if (!recordingSM.canStartAutoRecording(key)) {
        logger().info('[app] auto-record skipped: already recorded or recording active', {
          idempotencyKey: key
        })
        continue
      }

      logger().info('[app] auto-record candidate detected', {
        idempotencyKey: key,
        ...decision.logContext
      })

      // TODO: Trigger actual recording via IPC to renderer when auto-start
      // timing logic is implemented. For now, log the candidate.
    }
  }

  const graphRuntime = startGraphDetectionRuntime({
    statePath: join(app.getPath('userData'), 'graph', 'scheduler-state.json'),
    getAccessToken: getGraphAccessToken,
    getSignedInEmail: getCurrentUserEmail,
    logger: logger(),
    onAutoRecordEligible: handleAutoRecordEligible
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

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
