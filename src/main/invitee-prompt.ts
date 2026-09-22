/**
 * Invitee prompt runtime (IN-488): the Electron half of invitee-prompt-core.
 *
 * Toasts live in the main process; the renderer cannot show one. The renderer
 * owns delivery, so it asks main to prompt (`delivery:prompt-invitees`), and
 * main relays the first answer back (`delivery:invitee-decision`), the same
 * direction as the tray's Pause/Stop relay. When the owner answers on the
 * in-app card instead, the renderer sends `delivery:close-invitee-prompt` so
 * main's timer cannot fire "declined" while they are looking at the card.
 */
import { BrowserWindow, ipcMain, Notification } from 'electron'
import {
  createInviteePromptEngine,
  inviteeDisplayNames,
  parseInviteePromptRequest,
  type InviteeDecisionMessage,
  type InviteePromptEngine,
  type InviteePromptRequest
} from './invitee-prompt-core'
import { logger } from './logger'
import { playNotificationChime } from './recording-ipc'
import { buildInviteePromptToastXml, inviteeToastLines } from './toast-xml'

let engine: InviteePromptEngine | null = null

/** Same win32-toast / other-platform split as the join prompt. */
function showToast(request: InviteePromptRequest): (() => void) | null {
  if (!Notification?.isSupported?.()) {
    logger().warn('[invitee-prompt] toast unsupported by Electron', { meetingId: request.meetingId })
    return null
  }
  const names = inviteeDisplayNames(request.candidates)
  const lines = inviteeToastLines(request.title, names)
  const toast =
    process.platform === 'win32'
      ? new Notification({
          toastXml: buildInviteePromptToastXml({
            meetingId: request.meetingId,
            title: request.title,
            names
          })
        })
      : new Notification({ title: lines[0], body: lines.slice(1).join('\n'), silent: true })
  toast.show()
  return () => toast.close()
}

/** The window hides to the tray but is never destroyed, so the relay normally
 *  lands. If it cannot, nothing is sent to anyone: the meeting stays
 *  undelivered and resurfaces as a card on the next launch. */
function sendDecision(message: InviteeDecisionMessage): void {
  const window = BrowserWindow.getAllWindows()[0]
  if (!window || window.isDestroyed()) {
    logger().warn('[invitee-prompt] cannot relay decision: no main window', { ...message })
    return
  }
  window.webContents.send('delivery:invitee-decision', message)
}

function getEngine(): InviteePromptEngine {
  engine ??= createInviteePromptEngine({
    showToast,
    playChime: playNotificationChime,
    sendDecision,
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
    },
    log: (level, message, context) => logger()[level](message, context)
  })
  return engine
}

export function registerInviteePromptIpc(): void {
  ipcMain.on('delivery:prompt-invitees', (_event, payload: unknown) => {
    const request = parseInviteePromptRequest(payload)
    if (!request) {
      logger().warn('[invitee-prompt] ignored malformed prompt request')
      return
    }
    getEngine().show(request)
  })
  ipcMain.on('delivery:close-invitee-prompt', (_event, payload: { meetingId?: unknown }) => {
    if (typeof payload?.meetingId === 'string') getEngine().closeFromApp(payload.meetingId)
  })
}

/** A `notetaker://invitees-*?meeting=<id>` toast button (index.ts). */
export function inviteePromptToastAnswered(meetingId: string, approved: boolean): void {
  getEngine().answerFromToast(meetingId, approved)
}

export function disposeInviteePrompt(): void {
  engine?.dispose()
  engine = null
}
