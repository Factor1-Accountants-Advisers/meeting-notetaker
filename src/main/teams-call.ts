import { Notification } from 'electron'
import {
  buildTeamsCallPromptToastXml,
  buildTeamsCallUncertaintyToastXml,
  TOAST_PROTOCOL_SCHEME,
  teamsCallToastUri
} from './toast-xml'
import {
  createTeamsCallCore,
  type PromptedTeamsCall,
  type TeamsCallCalendarDecision,
  type TeamsCallCore,
  type TeamsCallObservation
} from './teams-call-core'

export interface TeamsCallRuntimeLog {
  info(message: string, details?: Record<string, unknown>): void
  warn(message: string, details?: Record<string, unknown>): void
}

export interface TeamsCallRuntimeOptions {
  enabled: boolean
  isRecordingActive: () => boolean
  isCurrentRecording: (call: PromptedTeamsCall) => boolean
  isRecordingPaused: () => boolean
  isReady: () => boolean
  start: (call: PromptedTeamsCall) => boolean
  observedEnd: (call: PromptedTeamsCall, endedAtUtc: string) => void
  pause: (call: PromptedTeamsCall) => void
  resume: (call: PromptedTeamsCall) => void
  stop: (call: PromptedTeamsCall) => void
  chime: () => void
  log: TeamsCallRuntimeLog
}

let core: TeamsCallCore | null = null
let promptNotification: Notification | null = null
let uncertaintyNotification: Notification | null = null

function closeUncertaintyNotification(): void {
  const notification = uncertaintyNotification
  uncertaintyNotification = null
  try { notification?.close() } catch { /* Windows may already have dismissed it. */ }
}

function showUncertaintyNotification(
  call: PromptedTeamsCall, decisionNonce: string, options: TeamsCallRuntimeOptions
): void {
  closeUncertaintyNotification()
  if (!Notification?.isSupported?.()) {
    options.log.warn('[teams-call] uncertainty notification unsupported; timeout remains active')
    return
  }
  try {
    uncertaintyNotification = process.platform === 'win32'
      ? new Notification({ toastXml: buildTeamsCallUncertaintyToastXml(call.nonce, decisionNonce) })
      : new Notification({
          title: 'Meeting Notetaker',
          body: 'Recording paused. Is the call still live? Open the app to stop or continue.',
          silent: true
        })
    uncertaintyNotification.show()
    options.chime()
    options.log.info('[teams-call] uncertainty prompt requested')
  } catch (error) {
    uncertaintyNotification = null
    options.log.warn('[teams-call] uncertainty notification failed; timeout remains active', {
      message: error instanceof Error ? error.message : String(error)
    })
  }
}

function closeNotification(): void {
  const notification = promptNotification
  promptNotification = null
  try {
    notification?.close()
  } catch {
    // Windows may already have dismissed it.
  }
}

function showNotification(call: PromptedTeamsCall, log: TeamsCallRuntimeLog): void {
  closeNotification()
  if (!Notification?.isSupported?.()) {
    log.warn('[teams-call] prompt notification unsupported')
    return
  }
  try {
    promptNotification =
      process.platform === 'win32'
        ? new Notification({ toastXml: buildTeamsCallPromptToastXml(call.title, call.nonce) })
        : new Notification({
            title: 'Record this call?',
            body: call.title ? `Call with ${call.title}` : 'Teams call detected',
            silent: true
          })
    promptNotification.show()
  } catch (error) {
    promptNotification = null
    log.warn('[teams-call] prompt notification failed', {
      message: error instanceof Error ? error.message : String(error)
    })
  }
}

export function configureTeamsCallRuntime(options: TeamsCallRuntimeOptions | null): void {
  closeNotification()
  closeUncertaintyNotification()
  core?.dispose()
  core = options
    ? createTeamsCallCore({
        enabled: options.enabled,
        now: Date.now,
        observationStaleMs: 3_500,
        isRecordingActive: options.isRecordingActive,
        isCurrentRecording: options.isCurrentRecording,
        isRecordingPaused: options.isRecordingPaused,
        isReady: options.isReady,
        actions: {
          showPrompt: (call) => showNotification(call, options.log),
          closePrompt: closeNotification,
          start: options.start,
          observedEnd: options.observedEnd,
          pause: options.pause,
          resume: options.resume,
          showUncertainty: (call, decisionNonce) => showUncertaintyNotification(call, decisionNonce, options),
          closeUncertainty: closeUncertaintyNotification,
          stop: options.stop
        }
      })
    : null
}

export function observeTeamsCall(observation: TeamsCallObservation): void {
  core?.observe(observation)
}

export function setTeamsCallCalendar(
  decisions: readonly TeamsCallCalendarDecision[],
  observedAtMs = Date.now(),
  fullSnapshot = true
): void {
  core?.setCalendar(decisions, observedAtMs, fullSnapshot)
}

export function teamsCallObserverUnavailable(): void {
  core?.observerUnavailable()
}

export function teamsCallRecordingPaused(): void { core?.onRecordingPaused() }
export function teamsCallRecordingResumed(): void { core?.onRecordingResumed() }
export function teamsCallRecordingStopped(): void { core?.onRecordingStopped() }

export function answerTeamsCallUncertainty(
  callNonce: string | null | undefined,
  decisionNonce: string | null | undefined,
  answer: 'stop' | 'continue'
): boolean {
  if (!callNonce || !decisionNonce || core?.getCurrentCall()?.nonce !== callNonce) return false
  return core.respondToUncertainty(decisionNonce, answer)
}

export function acceptTeamsCall(nonce: string | null | undefined): boolean {
  return nonce ? core?.accept(nonce) === true : false
}

export function invalidateTeamsCallTracking(): void {
  core?.invalidate()
  closeNotification()
}

export function disposeTeamsCallRuntime(): void {
  core?.dispose()
  core = null
  closeNotification()
  closeUncertaintyNotification()
}

export { teamsCallToastUri, TOAST_PROTOCOL_SCHEME }
