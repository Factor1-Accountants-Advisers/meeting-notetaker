import type { GraphMeetingMetadata } from '../../../main/graph/types'

interface RecoverablePromptedMeeting {
  source: string
  status?: string
  graph_metadata?: { prompted_call?: { observed_end_utc?: string | null } | null } | null
  call_lookup_status?: string
  call_lookup_next_retry_at?: string | null
  delivery_status: string
  invitee_delivery_status?: string
}

/** Durable resolved state must still offer sharing after a restart. */
export async function resumeApprovedPromptedSharing(
  state: { prompt_enabled: boolean; decision: string; invitee_delivery_status?: string; candidates: unknown[] },
  meetingId: string,
  inFlight: Set<string>,
  deliver: () => Promise<void>
): Promise<boolean> {
  if (!state.prompt_enabled || state.decision !== 'approved' ||
      state.invitee_delivery_status !== 'not_started' || state.candidates.length === 0 ||
      inFlight.has(meetingId)) return false
  // Share the same flight set as the owner's explicit Send action.
  inFlight.add(meetingId)
  try {
    await deliver()
    return true
  } finally {
    inFlight.delete(meetingId)
  }
}

export function promptedCallRecoveryAction(
  meeting: RecoverablePromptedMeeting,
  nowMs: number
): 'resolve' | 'share' | null {
  if (meeting.source !== 'online' || meeting.status === 'finalized' || !meeting.graph_metadata?.prompted_call?.observed_end_utc) return null
  if (meeting.call_lookup_status === 'resolved') {
    return meeting.delivery_status === 'emailed' && meeting.invitee_delivery_status !== 'sent' ? 'share' : null
  }
  if (!meeting.call_lookup_status || !['pending', 'unavailable', 'ambiguous'].includes(meeting.call_lookup_status)) return null
  if (meeting.call_lookup_next_retry_at && Date.parse(meeting.call_lookup_next_retry_at) > nowMs) return null
  return 'resolve'
}

/** Persist the original call's end even after its recording was manually
 * stopped. Multiple matches are ambiguous: never choose a different capture. */
export function findPromptedCallMeetingId(
  meetings: readonly { id: string; source: string; graph_metadata?: { prompted_call?: { nonce?: string } | null } | null }[],
  nonce: string
): string | null {
  const matches = meetings.filter((meeting) =>
    meeting.source === 'online' && meeting.graph_metadata?.prompted_call?.nonce === nonce
  )
  return matches.length === 1 ? matches[0].id : null
}

/** Include hang-up in the upload/recovery metadata before capture is stopped. */
export function withPromptedCallEnded(
  metadata: GraphMeetingMetadata | null,
  nonce: string,
  endedAtUtc: string
): GraphMeetingMetadata | null {
  if (!metadata?.promptedTeamsCall || metadata.promptedTeamsCall.nonce !== nonce) return metadata
  return {
    ...metadata,
    promptedTeamsCall: { ...metadata.promptedTeamsCall, observedEndUtc: endedAtUtc }
  }
}
