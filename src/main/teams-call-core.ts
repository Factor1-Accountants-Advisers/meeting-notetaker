import { randomUUID } from 'node:crypto'

/**
 * Pure state machine for the FD-97 unscheduled Teams-call prompt.
 *
 * Native observations are deliberately treated as hints: a prompt requires a
 * fresh calendar answer, a classified Teams call window, a stable connected
 * observation, and an explicit user action. `active: null` and observer
 * failures are unknown; neither is allowed to stop a recording.
 */

export interface TeamsCallObservation {
  schemaVersion: 1
  kind: 'teams-call'
  generation: number
  active: boolean | null
  preJoin: boolean
  windowTitles: string[]
}

export interface TeamsCallCalendarDecision {
  eventId?: string
  isTeamsMeeting?: boolean
  title: string
  startUtc?: string
  endUtc?: string
  status: 'candidate' | 'excluded'
  reason: string
}

export interface PromptedTeamsCall {
  nonce: string
  title: string
  observedStartUtc: string
}

/** Recording effects must never target a new manual/calendar capture after
 * the consented call was stopped. Keep the guard shared by end and stop. */
export function isPromptedTeamsCallRecording(
  call: PromptedTeamsCall,
  recording: { trigger?: string; metadata?: unknown } | null | undefined
): boolean {
  if (!recording || recording.trigger !== 'prompt') return false
  const metadata = recording.metadata
  if (!metadata || typeof metadata !== 'object' || !('promptedTeamsCall' in metadata)) return false
  const marker = (metadata as { promptedTeamsCall?: unknown }).promptedTeamsCall
  return !!marker && typeof marker === 'object' && 'nonce' in marker && marker.nonce === call.nonce
}

export interface TeamsCallCoreActions {
  showPrompt(call: PromptedTeamsCall): void
  closePrompt(): void
  /** Return false when the existing recording/capture gate refused the start. */
  start(call: PromptedTeamsCall): boolean
  observedEnd(call: PromptedTeamsCall, endedAtUtc: string): void
  pause(call: PromptedTeamsCall): void
  resume(call: PromptedTeamsCall): void
  showUncertainty(call: PromptedTeamsCall, decisionNonce: string): void
  closeUncertainty(): void
  stop(call: PromptedTeamsCall): void
}

export interface TeamsCallCoreTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface TeamsCallCoreOptions {
  enabled: boolean
  now: () => number
  isRecordingActive: () => boolean
  /** A late action must never control a replacement manual/scheduled capture. */
  isCurrentRecording: (call: PromptedTeamsCall) => boolean
  isRecordingPaused: () => boolean
  isReady: () => boolean
  actions: TeamsCallCoreActions
  timers?: TeamsCallCoreTimers
  promptDelayMs?: number
  promptLifetimeMs?: number
  falseObservationDebounceMs?: number
  uncertaintyTimeoutMs?: number
  pauseAckTimeoutMs?: number
  calendarStaleMs?: number
  /** The effectful runtime enables this; deterministic fixtures may omit it. */
  observationStaleMs?: number
  createNonce?: () => string
}

export interface TeamsCallCore {
  observe(observation: TeamsCallObservation): void
  setCalendar(decisions: readonly TeamsCallCalendarDecision[], observedAtMs?: number, fullSnapshot?: boolean): void
  observerUnavailable(): void
  onRecordingPaused(): void
  onRecordingResumed(): void
  onRecordingStopped(): void
  respondToUncertainty(decisionNonce: string, answer: 'stop' | 'continue'): boolean
  accept(nonce: string): boolean
  invalidate(): void
  dispose(): void
  getCurrentCall(): PromptedTeamsCall | null
  isPromptOpen(): boolean
}

/** ProgramData/bundled layers win over process env; default is off. */
export function readTeamsCallPromptEnabled(
  layers: Record<string, string | undefined>,
  env: Record<string, string | undefined>
): boolean {
  const raw = (layers.MN_TEAMS_CALL_PROMPT_ENABLED ?? env.MN_TEAMS_CALL_PROMPT_ENABLED ?? '')
    .trim()
    .toLocaleLowerCase()
  return raw === 'true'
}

interface TrackedCall extends PromptedTeamsCall {
  accepted: boolean
  promptAttempted: boolean
  controlDetached: boolean
}

const DEFAULT_PROMPT_DELAY_MS = 5_000
const DEFAULT_PROMPT_LIFETIME_MS = 2 * 60_000
const DEFAULT_FALSE_DEBOUNCE_MS = 1_000
const DEFAULT_UNCERTAINTY_TIMEOUT_MS = 60_000
const DEFAULT_PAUSE_ACK_TIMEOUT_MS = 5_000
const DEFAULT_CALENDAR_STALE_MS = 10 * 60_000
const SCHEDULED_WAIT_LEAD_MS = 10 * 60_000
const SCHEDULED_TAIL_MS = 5 * 60_000

const DEFAULT_TIMERS: TeamsCallCoreTimers = {
  setTimeout,
  clearTimeout
}

/**
 * Window titles are an intentionally conservative classifier. It excludes
 * known Teams shell surfaces and accepts a call-specific title or the common
 * `person | Microsoft Teams` call-window form. This is not a promise of
 * perfect meeting identification; the fresh-calendar gate remains the
 * fail-closed boundary when titles are ambiguous.
 */
function isPreConnectionTeamsWindow(title: string): boolean {
  return /\b(calling|incoming|outgoing|ringing|connecting)\b/i.test(title)
}

export function classifyTeamsCallWindow(windowTitles: readonly string[]): string | null {
  for (const raw of windowTitles) {
    const title = raw.trim()
    if (!title || isPreConnectionTeamsWindow(title)) continue
    const lower = title.toLocaleLowerCase()
    if (
      /^(microsoft teams|teams)$/.test(lower) ||
      /^(meeting compact view|sharing control bar)(?:\s*\||$)/.test(lower) ||
      /\b(chat|calendar|settings|options|activity|teams and channels|meeting details)\b/.test(lower)
    ) {
      continue
    }
    if (
      /\b(call|joined|meeting|with)\b/.test(lower) ||
      /\|\s*microsoft teams\s*$/i.test(title)
    ) {
      return title
    }
  }
  return null
}

function parseMs(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function safeAction(action: () => void): void {
  try {
    action()
  } catch {
    // A lost toast or IPC listener must not prevent the state machine from
    // closing a prompt or stopping an already-consented recording.
  }
}

export function createTeamsCallCore(options: TeamsCallCoreOptions): TeamsCallCore {
  const timers = options.timers ?? DEFAULT_TIMERS
  const promptDelayMs = options.promptDelayMs ?? DEFAULT_PROMPT_DELAY_MS
  const falseDebounceMs = options.falseObservationDebounceMs ?? DEFAULT_FALSE_DEBOUNCE_MS
  const calendarStaleMs = options.calendarStaleMs ?? DEFAULT_CALENDAR_STALE_MS

  let lastObservationGeneration = -1
  let observerHealthy = true
  let lastActive: boolean | null = null
  let lastPreJoin = false
  let current: TrackedCall | null = null
  let promptOpen = false
  let promptTimer: unknown = null
  let promptExpiryTimer: unknown = null
  let falseTimer: unknown = null
  const createNonce = options.createNonce ?? (() => 'teams-call-' + randomUUID())
  let observationTimer: unknown = null
  let uncertaintyTimer: unknown = null
  let continuationTimer: unknown = null
  let recoverySinceMs: number | null = null
  let uncertain: { call: TrackedCall; decisionNonce: string; paused: boolean } | null = null
  let calendarAtMs: number | null = null
  let calendar: TeamsCallCalendarDecision[] = []

  const clearPromptTimer = (): void => {
    if (promptTimer === null) return
    timers.clearTimeout(promptTimer)
    promptTimer = null
  }

  const clearPromptExpiryTimer = (): void => {
    if (promptExpiryTimer === null) return
    timers.clearTimeout(promptExpiryTimer)
    promptExpiryTimer = null
  }

  const clearFalseTimer = (): void => {
    if (falseTimer === null) return
    timers.clearTimeout(falseTimer)
    falseTimer = null
  }

  const closePrompt = (): void => {
    clearPromptTimer()
    clearPromptExpiryTimer()
    if (!promptOpen) return
    promptOpen = false
    safeAction(() => options.actions.closePrompt())
  }

  const clearUncertaintyTimer = (): void => {
    if (uncertaintyTimer !== null) timers.clearTimeout(uncertaintyTimer)
    uncertaintyTimer = null
  }
  const clearContinuationTimer = (): void => {
    if (continuationTimer !== null) timers.clearTimeout(continuationTimer)
    continuationTimer = null
    recoverySinceMs = null
  }
  const closeUncertainty = (): void => {
    clearUncertaintyTimer()
    if (uncertain?.paused) safeAction(() => options.actions.closeUncertainty())
    uncertain = null
  }
  // Never infer a Teams call-end timestamp from uncertainty. This stops and
  // saves the original capture, but does not claim Graph participant evidence.
  const stopUncertain = (): void => {
    const call = uncertain?.call ?? current
    closeUncertainty()
    clearContinuationTimer()
    clearFalseTimer()
    current = null
    if (call && call.accepted && options.isCurrentRecording(call)) {
      safeAction(() => options.actions.stop(call))
    }
  }
  const confirmPaused = (): void => {
    const episode = uncertain
    if (!episode || episode.paused || !options.isCurrentRecording(episode.call)) return
    clearUncertaintyTimer()
    episode.paused = true
    safeAction(() => options.actions.showUncertainty(episode.call, episode.decisionNonce))
    uncertaintyTimer = timers.setTimeout(() => {
      if (uncertain === episode) stopUncertain()
    }, options.uncertaintyTimeoutMs ?? DEFAULT_UNCERTAINTY_TIMEOUT_MS)
  }
  const beginUncertainty = (): void => {
    const call = current
    if (!call?.accepted || uncertain || continuationTimer !== null) return
    call.controlDetached = true
    recoverySinceMs = null
    clearFalseTimer()
    closePrompt()
    if (!options.isCurrentRecording(call)) return
    const episode = { call, decisionNonce: createNonce(), paused: false }
    uncertain = episode
    if (options.isRecordingPaused()) {
      confirmPaused()
    } else {
      safeAction(() => options.actions.pause(call))
      // If the pause IPC was lost, finalise rather than capture for hours.
      // The normal one-minute answer window starts only after pause ACK.
      uncertaintyTimer = timers.setTimeout(() => {
        if (uncertain === episode && !episode.paused) stopUncertain()
      }, options.pauseAckTimeoutMs ?? DEFAULT_PAUSE_ACK_TIMEOUT_MS)
    }
  }
  const continueUncertain = (requestResume: boolean): void => {
    const call = uncertain?.call
    if (!call || !options.isCurrentRecording(call)) return
    closeUncertainty()
    recoverySinceMs = null
    if (requestResume) safeAction(() => options.actions.resume(call))
    // Explicit Continue is a bounded extension, not indefinite consent to
    // capture without a trustworthy call identity. Ask again after a minute.
    continuationTimer = timers.setTimeout(() => {
      continuationTimer = null
      if (current === call && options.isCurrentRecording(call)) beginUncertainty()
    }, options.uncertaintyTimeoutMs ?? DEFAULT_UNCERTAINTY_TIMEOUT_MS)
  }

  const calendarAllowsPrompt = (): boolean => {
    const now = options.now()
    if (calendarAtMs === null || now < calendarAtMs || now - calendarAtMs > calendarStaleMs) return false
    // Approved conservative policy: an overlapping Teams booking suppresses
    // suggestions even when its subject differs from the call-window title.
    const matches = calendar.filter((decision) => {
      if (decision.isTeamsMeeting === false) return false
      if (decision.reason === 'cancelled' || decision.reason === 'declined') return false
      const startMs = parseMs(decision.startUtc)
      const endMs = parseMs(decision.endUtc)
      if (startMs === null || endMs === null || endMs < startMs) return true
      return now >= startMs - SCHEDULED_WAIT_LEAD_MS && now <= endMs + SCHEDULED_TAIL_MS
    })
    // Two possible calendar events are not safe to classify as an unscheduled
    // call. We deliberately suppress rather than guess.
    return matches.length === 0
  }

  const finishCall = (): void => {
    const finished = current
    if (!finished) return
    clearFalseTimer()
    clearContinuationTimer()
    closeUncertainty()
    closePrompt()
    current = null
    if (!finished.accepted || finished.controlDetached) return
    const endedAtUtc = new Date(options.now()).toISOString()
    safeAction(() => options.actions.observedEnd(finished, endedAtUtc))
    safeAction(() => options.actions.stop(finished))
  }

  const armFalseObservation = (): void => {
    if (!current || lastActive !== false || falseTimer !== null) return
    const tracked = current
    falseTimer = timers.setTimeout(() => {
      falseTimer = null
      if (current !== tracked || lastActive !== false) return
      finishCall()
    }, falseDebounceMs)
  }

  const schedulePrompt = (call: TrackedCall): void => {
    clearPromptTimer()
    promptTimer = timers.setTimeout(() => {
      promptTimer = null
      if (current !== call || promptOpen || !observerHealthy) return
      if (lastActive !== true || lastPreJoin || !options.isReady()) return
      if (options.isRecordingActive() || !calendarAllowsPrompt()) return
      call.promptAttempted = true
      promptOpen = true
      safeAction(() => options.actions.showPrompt(call))
      promptExpiryTimer = timers.setTimeout(() => {
        promptExpiryTimer = null
        closePrompt()
      }, options.promptLifetimeMs ?? DEFAULT_PROMPT_LIFETIME_MS)
    }, promptDelayMs)
  }

  const maybeSchedulePrompt = (call: TrackedCall): void => {
    if (
      current !== call ||
      call.accepted ||
      call.controlDetached ||
      call.promptAttempted ||
      promptOpen ||
      promptTimer !== null ||
      !options.enabled ||
      !observerHealthy ||
      lastActive !== true ||
      lastPreJoin ||
      !options.isReady() ||
      options.isRecordingActive() ||
      !calendarAllowsPrompt()
    ) return
    schedulePrompt(call)
  }

  const clearObservationTimer = (): void => {
    if (observationTimer === null) return
    timers.clearTimeout(observationTimer)
    observationTimer = null
  }

  const observerUnavailable = (): void => {
    clearObservationTimer()
    clearFalseTimer()
    recoverySinceMs = null
    closePrompt()
    observerHealthy = false
    if (current?.accepted) beginUncertainty()
    lastActive = null
    lastPreJoin = false
    // A replacement observer cannot prove session continuity. Preserve the
    // consented interval but require an explicit Continue or a timed stop.
    lastObservationGeneration = -1
  }

  const observe = (observation: TeamsCallObservation): void => {
    if (observation.generation < lastObservationGeneration) return
    lastObservationGeneration = observation.generation
    clearObservationTimer()
    if (options.observationStaleMs !== undefined) {
      observationTimer = timers.setTimeout(() => {
        observationTimer = null
        observerUnavailable()
      }, options.observationStaleMs)
    }
    observerHealthy = true
    lastActive = observation.active
    lastPreJoin = observation.preJoin

    const preConnection = observation.windowTitles.some(isPreConnectionTeamsWindow)
    const callWindowRemains = classifyTeamsCallWindow(observation.windowTitles) !== null
    // Failed scans, pre-join and pre-connection evidence are true
    // uncertainties: once seen, nothing later may end the consented interval.
    if (observation.active === null || observation.preJoin || preConnection) {
      recoverySinceMs = null
      if (current?.accepted) beginUncertainty()
      lastActive = null
      clearFalseTimer()
      closePrompt()
      return
    }
    // Continue authorizes recovery, never an automatic resume. Require the
    // original sole call candidate and active audio across fresh samples for
    // two seconds; auxiliary sharing surfaces are excluded by the classifier.
    // No evidence, a different call, or an unanswered pause remains bounded.
    if (current?.accepted && current.controlDetached) {
      const candidates = new Set(observation.windowTitles
        .map((candidate) => classifyTeamsCallWindow([candidate])?.trim().toLocaleLowerCase())
        .filter((candidate): candidate is string => Boolean(candidate)))
      const sameCall = observation.active === true && candidates.size === 1 &&
        candidates.has(current.title.trim().toLocaleLowerCase())
      if (continuationTimer === null || uncertain || options.isRecordingPaused() ||
          !options.isReady() || !options.isCurrentRecording(current) || !sameCall) {
        recoverySinceMs = null
        return
      }
      const now = options.now()
      if (recoverySinceMs === null) recoverySinceMs = now
      if (now - recoverySinceMs < 2_000) return
      current.controlDetached = false
      clearContinuationTimer()
    }
    // Audio inactivity while a call window remains is not hang-up yet — during
    // a device transition or mute the call is still up — but it is also not
    // continuity uncertainty: a live hang-up closes the audio session a beat
    // before Teams closes its call window (observed live 8 Oct 2026: ~1.5 s).
    // Hold the interval and wait. If the window clears while audio stays off,
    // the false-observation path below ends the call; if audio returns, the
    // call simply continues. Never detach on this transient alone.
    if (observation.active === false && callWindowRemains) {
      clearFalseTimer()
      closePrompt()
      return
    }
    if (observation.active === false) {
      armFalseObservation()
      return
    }
    clearFalseTimer()

    const titles = new Set(observation.windowTitles
      .map((candidate) => classifyTeamsCallWindow([candidate]))
      .filter((candidate): candidate is string => Boolean(candidate)))
    const title = titles.size === 1 ? [...titles][0] : null
    if (!title) {
      if (current?.accepted) beginUncertainty()
      if (current && !current.accepted) {
        clearPromptTimer()
        closePrompt()
      }
      return
    }
    if (current) {
      if (title.trim().toLocaleLowerCase() !== current.title.trim().toLocaleLowerCase()) {
        if (current.accepted) beginUncertainty()
        else current.controlDetached = true
        closePrompt()
      }
      // Readiness, recording state, and calendar freshness can change after
      // the first connected heartbeat. Re-evaluate without ever replaying a
      // prompt that was already shown for this connection.
      maybeSchedulePrompt(current)
      return
    }

    const call: TrackedCall = {
      nonce: createNonce(),
      title,
      observedStartUtc: new Date(options.now()).toISOString(),
      accepted: false,
      promptAttempted: false,
      controlDetached: false
    }
    current = call

    // A connection is consumed even when it is suppressed. This enforces one
    // prompt per connection and prevents a manual recording ending mid-call
    // from causing a late prompt for the same call.
    maybeSchedulePrompt(call)
  }

  return {
    observe,

    setCalendar(decisions, observedAtMs = options.now(), fullSnapshot = true): void {
      // An empty delta means unchanged, not an empty calendar. Never trust a
      // delta until a complete snapshot establishes this account's baseline.
      if (!fullSnapshot && calendarAtMs === null) return
      const key = (decision: TeamsCallCalendarDecision): string =>
        decision.eventId ?? JSON.stringify([decision.title, decision.startUtc])
      const merged = new Map<string, TeamsCallCalendarDecision>()
      if (!fullSnapshot) for (const decision of calendar) merged.set(key(decision), decision)
      for (const decision of decisions) merged.set(key(decision), { ...decision })
      calendar = [...merged.values()]
      calendarAtMs = observedAtMs
      // A fresh booking can arrive after the toast was shown. Suppression
      // must close that stale suggestion, not only reject its later click.
      if (!calendarAllowsPrompt()) closePrompt()
    },

    observerUnavailable,
    onRecordingPaused(): void { confirmPaused() },
    onRecordingResumed(): void {
      if (uncertain?.paused) continueUncertain(false)
    },
    onRecordingStopped(): void {
      if (!uncertain && continuationTimer === null) return
      closeUncertainty()
      clearContinuationTimer()
      if (current) current.controlDetached = true
    },
    respondToUncertainty(decisionNonce, answer): boolean {
      const episode = uncertain
      if (!episode?.paused || episode.decisionNonce !== decisionNonce ||
          !options.isCurrentRecording(episode.call)) return false
      if (answer === 'stop') stopUncertain()
      else continueUncertain(true)
      return true
    },
    accept(nonce): boolean {
      const call = current
      if (!call || call.nonce !== nonce || !promptOpen) return false
      if (
        call.controlDetached ||
        !observerHealthy ||
        lastActive !== true ||
        lastPreJoin ||
        !options.isReady() ||
        options.isRecordingActive() ||
        !calendarAllowsPrompt()
      ) {
        closePrompt()
        return false
      }
      let started = false
      try {
        started = options.actions.start(call) === true
      } catch {
        started = false
      }
      if (!started) return false
      call.accepted = true
      closePrompt()
      return true
    },

    invalidate(): void {
      observerUnavailable()
      // A sign-out/reload must not erase the timeout for a still-running
      // prompted capture. The exact recording guard prevents affecting a
      // replacement session after an account change.
      if (!current?.accepted || !options.isCurrentRecording(current)) current = null
      calendar = []
      calendarAtMs = null
    },
    dispose(): void {
      clearObservationTimer()
      clearFalseTimer()
      clearContinuationTimer()
      closeUncertainty()
      closePrompt()
      current = null
    },

    getCurrentCall: () => (current ? { ...current } : null),
    isPromptOpen: () => promptOpen
  }
}
