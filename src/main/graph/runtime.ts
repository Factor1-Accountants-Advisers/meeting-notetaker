import { GraphClient, GraphClientError, GraphThrottleError } from './client'
import { detectGraphMeetings } from './poller'
import {
  EMPTY_GRAPH_SCHEDULER_STATE,
  readGraphSchedulerState,
  writeGraphSchedulerState,
  type GraphSchedulerState
} from './store'
import type { GraphCollectionResponse } from './client'
import type { GraphEventDecision, GraphFilterOptions, RawGraphEvent } from './types'

const DEFAULT_LOOKAHEAD_MS = 24 * 60 * 60 * 1000
const DEFAULT_GRACE_MS = 10 * 60 * 1000
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000
const RESUME_DEBOUNCE_MS = 15_000

export interface GraphRuntimeLogger {
  info: (message: string, context?: Record<string, unknown>) => void
  warn: (message: string, context?: Record<string, unknown>) => void
}

export interface GraphRuntimeOptions {
  statePath: string
  getAccessToken: () => Promise<string | null>
  getSignedInEmail?: () => string | undefined
  logger: GraphRuntimeLogger
  now?: () => Date
  clientFactory?: (accessToken: string) => GraphCalendarClient
  resumeDebounceMs?: number
}

export interface GraphCalendarClient {
  fetchCalendarView: (request: { startUtc: string; endUtc: string }) => Promise<GraphCollectionResponse<RawGraphEvent>>
  fetchDeltaLink: (deltaLink: string) => Promise<GraphCollectionResponse<RawGraphEvent>>
}

export type GraphSyncStatus =
  | 'skipped_no_token'
  | 'skipped_backoff'
  | 'success'
  | 'throttled'
  | 'auth_required'
  | 'error'

export interface GraphSyncResult {
  status: GraphSyncStatus
  state: GraphSchedulerState
  decisions: GraphEventDecision[]
  errorMessage?: string
}

export interface GraphDetectionRuntime {
  syncNow: () => Promise<GraphSyncResult>
  startPolling: (intervalMs?: number) => void
  stopPolling: () => void
  scheduleResumeSync: () => void
}

export function startGraphDetectionRuntime(options: GraphRuntimeOptions): GraphDetectionRuntime {
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let resumeTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let consecutiveFailures = 0

  const syncNow = (): Promise<GraphSyncResult> => syncGraphDetectionOnce(options)

  const startPolling = (intervalMs = DEFAULT_POLL_INTERVAL_MS): void => {
    if (pollTimer) return

    options.logger.info('[graph] polling started', { intervalMs })
    stopped = false
    consecutiveFailures = 0

    const poll = async (): Promise<void> => {
      if (stopped) return
      const result = await syncNow()

      if (stopped) return

      if (result.status === 'auth_required') {
        options.logger.warn('[graph] polling paused: sign-in required')
        stopPolling()
        return
      }

      if (result.status === 'error' || result.status === 'throttled') {
        consecutiveFailures++
        if (consecutiveFailures >= 5) {
          options.logger.warn('[graph] polling paused after consecutive failures', { consecutiveFailures })
          stopPolling()
          return
        }
      } else {
        consecutiveFailures = 0
      }
    }

    pollTimer = setInterval(poll, intervalMs)
  }

  const stopPolling = (): void => {
    stopped = true
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
      options.logger.info('[graph] polling stopped')
    }
    if (resumeTimer) {
      clearTimeout(resumeTimer)
      resumeTimer = null
    }
  }

  const scheduleResumeSync = (): void => {
    if (resumeTimer) clearTimeout(resumeTimer)

    const debounceMs = options.resumeDebounceMs ?? RESUME_DEBOUNCE_MS
    resumeTimer = setTimeout(() => {
      resumeTimer = null
      options.logger.info('[graph] resume sync triggered')
      void syncNow().then((result) => {
        options.logger.info('[graph] resume sync finished', {
          status: result.status,
          decisions: result.decisions.length
        })
      })
    }, debounceMs)
  }

  // Startup sync
  void syncNow().then((result) => {
    options.logger.info('[graph] startup sync finished', {
      status: result.status,
      decisions: result.decisions.length
    })
    // Auto-start polling only when we have a working token and the sync succeeded.
    // On skipped_no_token, skipped_backoff, or error, the caller must call
    // startPolling() explicitly (e.g., after sign-in).
    if (result.status === 'success') startPolling()
  })

  return { syncNow, startPolling, stopPolling, scheduleResumeSync }
}

export async function syncGraphDetectionOnce(options: GraphRuntimeOptions): Promise<GraphSyncResult> {
  const now = options.now?.() ?? new Date()
  const state = await readGraphSchedulerState(options.statePath)

  if (isInBackoff(state, now)) {
    options.logger.info('[graph] sync skipped during backoff', { backoffUntilUtc: state.backoffUntilUtc })
    return { status: 'skipped_backoff', state, decisions: [] }
  }

  const accessToken = await options.getAccessToken()
  if (!accessToken) {
    options.logger.info('[graph] sync skipped until MSAL token is available')
    return { status: 'skipped_no_token', state, decisions: [] }
  }

  const windowStartUtc = new Date(now.getTime() - DEFAULT_GRACE_MS).toISOString()
  const windowEndUtc = new Date(now.getTime() + DEFAULT_LOOKAHEAD_MS).toISOString()
  const client = options.clientFactory?.(accessToken) ??
    new GraphClient({ getAccessToken: async () => accessToken })

  try {
    const response = state.deltaLink
      ? await client.fetchDeltaLink(state.deltaLink)
      : await client.fetchCalendarView({ startUtc: windowStartUtc, endUtc: windowEndUtc })

    const detection = detectGraphMeetings(response.value, {
      signedInEmail: options.getSignedInEmail?.(),
      filter: buildFilterOptions(now),
      logDecision: (decision) => {
        options.logger.info('[graph] event decision', {
          reason: decision.reason,
          autoRecordEligible: decision.autoRecordEligible,
          ...decision.logContext
        })
      }
    })

    const nextState = buildNextState(state, {
      windowStartUtc,
      windowEndUtc,
      deltaLink: response['@odata.deltaLink'] ?? state.deltaLink,
      decisions: detection.decisions,
      now
    })
    await writeGraphSchedulerState(options.statePath, nextState)

    options.logger.info('[graph] sync completed', {
      total: detection.decisions.length,
      candidates: detection.candidates.length,
      autoRecordEligible: detection.autoRecordEligible.length,
      excluded: detection.excluded.length
    })

    return { status: 'success', state: nextState, decisions: detection.decisions }
  } catch (err) {
    if (err instanceof GraphThrottleError) {
      const nextState = { ...state, backoffUntilUtc: new Date(now.getTime() + err.retryAfterMs).toISOString() }
      await writeGraphSchedulerState(options.statePath, nextState)
      options.logger.warn('[graph] sync throttled', { retryAfterMs: err.retryAfterMs })
      return { status: 'throttled', state: nextState, decisions: [] }
    }

    if (err instanceof GraphClientError && err.status === 401) {
      options.logger.warn('[graph] sync requires refreshed sign-in')
      return { status: 'auth_required', state, decisions: [] }
    }

    options.logger.warn('[graph] sync failed', { message: err instanceof Error ? err.message : String(err) })
    return {
      status: 'error',
      state,
      decisions: [],
      errorMessage: err instanceof Error ? err.message : String(err)
    }
  }
}

function buildFilterOptions(now: Date): GraphFilterOptions {
  return {
    now,
    lookaheadMs: DEFAULT_LOOKAHEAD_MS,
    graceMs: DEFAULT_GRACE_MS,
    requireOnlineMeeting: true,
    requireOrganizerForAutoRecord: true,
    excludePrivateEvents: true
  }
}

function isInBackoff(state: GraphSchedulerState, now: Date): boolean {
  if (!state.backoffUntilUtc) return false
  return new Date(state.backoffUntilUtc).getTime() > now.getTime()
}

function buildNextState(
  previous: GraphSchedulerState,
  input: {
    windowStartUtc: string
    windowEndUtc: string
    deltaLink?: string
    decisions: GraphEventDecision[]
    now: Date
  }
): GraphSchedulerState {
  const decisions = { ...previous.decisions }
  for (const decision of input.decisions) {
    const key = decision.idempotencyKey ?? decision.eventId
    decisions[key] = {
      reason: decision.reason,
      autoRecordEligible: decision.autoRecordEligible,
      startUtc: decision.logContext.startUtc,
      endUtc: decision.logContext.endUtc,
      updatedAtUtc: input.now.toISOString()
    }
  }

  return {
    ...EMPTY_GRAPH_SCHEDULER_STATE,
    ...previous,
    windowStartUtc: input.windowStartUtc,
    windowEndUtc: input.windowEndUtc,
    deltaLink: input.deltaLink,
    lastSuccessfulSyncUtc: input.now.toISOString(),
    backoffUntilUtc: undefined,
    decisions
  }
}
