import { desktopCapturer, session } from 'electron'
import { logger } from './logger'

export function registerMediaPermissions(): void {
  logger().info('[media] registering WASAPI loopback display media handler')

  // Auto-grant microphone + display-capture permissions for our own app.
  // Without this, some Electron/Chromium versions may show an OS-level
  // permission prompt or silently block the capture stream even when
  // useSystemPicker is false.
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      if (permission === 'media' || permission === 'display-capture') {
        callback(true)
      } else {
        callback(false)
      }
    }
  )

  // WASAPI loopback (decision #6): grant getDisplayMedia requests system-audio
  // loopback without showing a picker.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          logger().info('[media] granted loopback capture source', { sourceCount: sources.length })
          callback({ video: sources[0], audio: 'loopback' })
        })
        .catch((err) => {
          logger().warn('[media] failed to grant loopback capture source', {
            message: err instanceof Error ? err.message : String(err)
          })
          callback({})
        })
    },
    { useSystemPicker: false }
  )
}
