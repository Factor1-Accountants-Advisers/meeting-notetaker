import { desktopCapturer, session } from 'electron'

export function registerMediaPermissions(): void {
  // WASAPI loopback (decision #6): grant getDisplayMedia requests system-audio
  // loopback without showing a picker. Renderer drops the mandatory video track.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
        .catch(() => callback({}))
    },
    { useSystemPicker: false }
  )
}
