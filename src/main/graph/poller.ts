import { decideGraphEvent } from './filter'
import { normaliseGraphEvent } from './normalise'
import type { GraphEventDecision, GraphFilterOptions, RawGraphEvent } from './types'

export interface DetectGraphMeetingsOptions {
  signedInEmail?: string
  filter: GraphFilterOptions
  logDecision?: (decision: GraphEventDecision) => void
}

export interface DetectGraphMeetingsResult {
  decisions: GraphEventDecision[]
  candidates: GraphEventDecision[]
  autoRecordEligible: GraphEventDecision[]
  excluded: GraphEventDecision[]
}

export function detectGraphMeetings(
  events: RawGraphEvent[],
  options: DetectGraphMeetingsOptions
): DetectGraphMeetingsResult {
  const decisions = events.map((event) =>
    decideGraphEvent(normaliseGraphEvent(event, { signedInEmail: options.signedInEmail }), options.filter)
  )

  for (const decision of decisions) options.logDecision?.(decision)

  return {
    decisions,
    candidates: decisions.filter((decision) => decision.status === 'candidate'),
    autoRecordEligible: decisions.filter((decision) => decision.autoRecordEligible),
    excluded: decisions.filter((decision) => decision.status === 'excluded')
  }
}
