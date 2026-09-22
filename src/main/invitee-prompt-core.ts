/**
 * Invitee prompt engine (IN-488): the main-process half of "ask before
 * emailing invitees".
 *
 * Pure on purpose: no Electron, no logger, no clock of its own, so the verify
 * script can drive it under plain Node (same shape as join-watch-core). The
 * runtime (invitee-prompt.ts) injects the real toast, chime, IPC relay and
 * timers.
 *
 * One entry per meeting, because two meetings can finish close together (an
 * ad-hoc upload and a scheduled one). Whatever happens first resolves the
 * entry exactly once: a toast button, the in-app card, or the timer. The
 * timer's answer is always the safe default, organiser only, the same pattern
 * as the paused-recording grace toast.
 */

import { TOAST_LIFETIME_MS } from './toast-xml'

export interface InviteePromptCandidate {
  name: string | null
  email: string
}

export interface InviteePromptRequest {
  meetingId: string
  title: string
  candidates: InviteePromptCandidate[]
}

export type InviteeDecisionSource = 'toast' | 'app' | 'timeout'

export interface InviteeDecisionMessage {
  meetingId: string
  approved: boolean
  source: InviteeDecisionSource
}

export interface InviteePromptTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type InviteePromptLog = (
  level: 'info' | 'warn',
  message: string,
  context?: Record<string, unknown>
) => void

export interface InviteePromptDeps {
  /** Show the OS toast. Returns a function that closes it, or null when it
   *  could not be shown (unsupported, or the OS refused). May throw. */
  showToast: (request: InviteePromptRequest) => (() => void) | null
  playChime: () => void
  /** Relay a decision to the renderer, which owns the delivery pass. */
  sendDecision: (message: InviteeDecisionMessage) => void
  timers: InviteePromptTimers
  log: InviteePromptLog
  lifetimeMs?: number
}

export interface InviteePromptEngine {
  show(request: InviteePromptRequest): void
  /** A toast button was clicked. Ignored when no prompt is open for it. */
  answerFromToast(meetingId: string, approved: boolean): void
  /** The owner answered on the in-app card: close up, send nothing. */
  closeFromApp(meetingId: string): void
  dispose(): void
  openCount(): number
}

/** What the toast shows for each person: their name, else their address. */
export function inviteeDisplayNames(candidates: readonly InviteePromptCandidate[]): string[] {
  return candidates.map((candidate) => candidate.name?.trim() || candidate.email)
}

/** Validate a `delivery:prompt-invitees` payload. IPC input is untrusted
 *  shape-wise, and an empty candidate list means there is nothing to ask. */
export function parseInviteePromptRequest(value: unknown): InviteePromptRequest | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { meetingId?: unknown; title?: unknown; candidates?: unknown }
  if (typeof raw.meetingId !== 'string' || !raw.meetingId) return null
  if (!Array.isArray(raw.candidates) || raw.candidates.length === 0) return null
  const candidates: InviteePromptCandidate[] = []
  for (const entry of raw.candidates) {
    if (!entry || typeof entry !== 'object') return null
    const candidate = entry as { name?: unknown; email?: unknown }
    if (typeof candidate.email !== 'string' || !candidate.email) return null
    candidates.push({
      name: typeof candidate.name === 'string' ? candidate.name : null,
      email: candidate.email
    })
  }
  return {
    meetingId: raw.meetingId,
    title: typeof raw.title === 'string' ? raw.title : '',
    candidates
  }
}

interface OpenPrompt {
  closeToast: (() => void) | null
  timer: unknown
}

export function createInviteePromptEngine(deps: InviteePromptDeps): InviteePromptEngine {
  const lifetimeMs = deps.lifetimeMs ?? TOAST_LIFETIME_MS
  const open = new Map<string, OpenPrompt>()

  /** Remove the entry, cancel its timer, close its toast. Null when there is
   *  none, which is how a stale click and a double answer are both caught. */
  const take = (meetingId: string): OpenPrompt | null => {
    const entry = open.get(meetingId)
    if (!entry) return null
    open.delete(meetingId)
    deps.timers.clearTimeout(entry.timer)
    try {
      entry.closeToast?.()
    } catch {
      // Already gone (dismissed by the user or by Windows): nothing to do.
    }
    return entry
  }

  return {
    show(request) {
      const { meetingId } = request
      take(meetingId)
      let closeToast: (() => void) | null = null
      try {
        closeToast = deps.showToast(request)
      } catch (err) {
        deps.log('warn', '[invitee-prompt] toast failed', {
          meetingId,
          message: err instanceof Error ? err.message : String(err)
        })
      }
      if (closeToast) deps.playChime()
      // The timer is the hold's backstop and runs even without a toast: the
      // in-app card is still up, and delivery must never wait forever.
      const timer = deps.timers.setTimeout(() => {
        if (!take(meetingId)) return
        deps.log('info', '[invitee-prompt] timeout', { meetingId })
        deps.sendDecision({ meetingId, approved: false, source: 'timeout' })
      }, lifetimeMs)
      open.set(meetingId, { closeToast, timer })
      deps.log('info', '[invitee-prompt] shown', {
        meetingId,
        invitees: request.candidates.length,
        toast: closeToast !== null
      })
    },

    answerFromToast(meetingId, approved) {
      if (!take(meetingId)) {
        // A toast that lingered in Action Center after its timer fired. The
        // card is the way to send later; a stale click sends nothing.
        deps.log('info', '[invitee-prompt] stale-click', { meetingId, approved })
        return
      }
      deps.log('info', '[invitee-prompt] answered', { meetingId, approved, source: 'toast' })
      deps.sendDecision({ meetingId, approved, source: 'toast' })
    },

    closeFromApp(meetingId) {
      if (take(meetingId)) {
        deps.log('info', '[invitee-prompt] answered', { meetingId, source: 'app' })
      }
    },

    dispose() {
      for (const meetingId of [...open.keys()]) take(meetingId)
    },

    openCount: () => open.size
  }
}
