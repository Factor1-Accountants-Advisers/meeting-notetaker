import { createHash } from 'crypto'
import type { GraphDecisionReason, GraphEventDecision, GraphFilterOptions, NormalizedGraphEvent } from './types'

export function decideGraphEvent(
  event: NormalizedGraphEvent,
  options: GraphFilterOptions
): GraphEventDecision {
  const exclusion = getExclusionReason(event, options)
  const organizerAllowed = !options.requireOrganizerForAutoRecord || event.isOrganizer
  const dueForAutoStart = isDueForAutoStart(event, options)
  const autoRecordEligible = exclusion === undefined && organizerAllowed && dueForAutoStart
  const reason: GraphDecisionReason = exclusion ?? getCandidateReason(organizerAllowed, dueForAutoStart)

  return {
    eventId: event.id,
    idempotencyKey: event.idempotencyKey,
    metadata: event.metadata,
    status: exclusion ? 'excluded' : 'candidate',
    reason,
    autoRecordEligible,
    logContext: {
      eventIdHash: hashForLog(event.id),
      startUtc: event.startUtc,
      endUtc: event.endUtc,
      isOrganizer: event.isOrganizer,
      isCancelled: event.isCancelled,
      isAllDay: event.isAllDay,
      showAs: event.showAs,
      sensitivity: event.sensitivity,
      attendeeCount: event.attendeeCount,
      isOnlineMeeting: event.isOnlineMeeting,
      onlineMeetingProvider: event.onlineMeetingProvider,
      userResponse: event.userResponse
    }
  }
}

function getExclusionReason(
  event: NormalizedGraphEvent,
  options: GraphFilterOptions
): GraphDecisionReason | undefined {
  if (event.invalidReasons.length > 0) return 'invalid_time_range'
  if (event.isCancelled) return 'cancelled'
  if (event.isAllDay) return 'all_day'
  if (event.showAs?.toLowerCase() === 'free') return 'free_time'
  if (event.userResponse?.toLowerCase() === 'declined') return 'declined'
  if (options.excludePrivateEvents && event.sensitivity?.toLowerCase() === 'private') {
    return 'private_event_pending_policy'
  }
  if (!event.startUtc || !event.endUtc) return 'invalid_time_range'

  const nowMs = options.now.getTime()
  const startMs = new Date(event.startUtc).getTime()
  const endMs = new Date(event.endUtc).getTime()
  if (endMs <= nowMs) return 'already_ended'
  if (startMs > nowMs + options.lookaheadMs) return 'outside_lookahead'

  if (options.requireOnlineMeeting && (!event.isOnlineMeeting || !event.hasJoinUrl)) {
    return 'not_online_meeting'
  }

  return undefined
}

function getCandidateReason(organizerAllowed: boolean, dueForAutoStart: boolean): GraphDecisionReason {
  if (!organizerAllowed) return 'not_organizer'
  if (!dueForAutoStart) return 'not_due_yet'
  return 'eligible'
}

function isDueForAutoStart(event: NormalizedGraphEvent, options: GraphFilterOptions): boolean {
  if (!event.startUtc) return false
  const startMs = new Date(event.startUtc).getTime()
  return startMs <= options.now.getTime() + options.autoStartLeadMs
}

function hashForLog(value: string): string {
  return createHash('sha256').update(value || 'missing').digest('hex').slice(0, 12)
}
