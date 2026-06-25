import { desktopCapturer, session } from 'electron'
import { logger } from './logger'

export function registerMediaPermissions(): void {
  logger().info('[media] registering WASAPI loopback display media handler')
  // WASAPI loopback (decision #6): grant getDisplayMedia requests system-audio
  // loopback without showing a picker. Renderer drops the mandatory video track.
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
