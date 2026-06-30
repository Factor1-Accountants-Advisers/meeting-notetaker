import type { GraphEventDecision } from './types'

/**
 * Host-only gate (IN-67).
 *
 * Confirms that an auto-recording candidate was organised by the signed-in user.
 * Manual recordings bypass this gate entirely — it only applies to automated
 * detection-based recording.
 */
export interface HostGateResult {
  /** Whether this meeting passes the host gate. */
  allowed: boolean
  /** Human-readable reason for the decision. */
  reason: string
}

/**
 * Evaluate whether an event decision should proceed to auto-recording.
 *
 * The gate only applies to auto-record-eligible candidates. Decisions that
 * are already excluded or not auto-record-eligible (e.g. non-organiser,
 * cancelled, declined) are deferred to the filter layer and do not reach
 * this gate.
 *
 * Manual recordings bypass the gate entirely.
 */
export function evaluateHostGate(decision: GraphEventDecision, signedInEmail?: string): HostGateResult {
  if (decision.status === 'excluded') {
    return { allowed: false, reason: 'excluded_by_filter' }
  }

  if (!decision.autoRecordEligible) {
    return { allowed: false, reason: 'not_auto_record_eligible' }
  }

  if (!decision.logContext.isOrganizer) {
    return { allowed: false, reason: 'not_organizer' }
  }

  if (signedInEmail && decision.logContext.isOrganizer) {
    return { allowed: true, reason: 'organizer_verified' }
  }

  // If we have the organiser flag set but no email match to confirm,
  // still allow — Graph's isOrganizer is authoritative.
  return { allowed: true, reason: 'organizer_confirmed' }
}

/**
 * Return a safe log summary of the host gate decision.
 * Never includes email addresses, event subjects, or join URLs.
 */
export function hostGateLogContext(result: HostGateResult): Record<string, unknown> {
  return {
    hostGateAllowed: result.allowed,
    hostGateReason: result.reason
  }
}
