export interface GraphDateTimeTimeZone {
  dateTime?: string
  timeZone?: string
}

export interface GraphEmailAddress {
  name?: string
  address?: string
}

export interface GraphAttendee {
  emailAddress?: GraphEmailAddress
  status?: {
    response?: string
    time?: string
  }
  type?: string
}

export interface RawGraphEvent {
  id?: string
  iCalUId?: string
  subject?: string
  start?: GraphDateTimeTimeZone
  end?: GraphDateTimeTimeZone
  isCancelled?: boolean
  isAllDay?: boolean
  showAs?: string
  sensitivity?: string
  isOrganizer?: boolean
  organizer?: {
    emailAddress?: GraphEmailAddress
  }
  attendees?: GraphAttendee[]
  responseStatus?: {
    response?: string
    time?: string
  }
  isOnlineMeeting?: boolean
  onlineMeetingProvider?: string
  onlineMeeting?: {
    joinUrl?: string
  }
  webLink?: string
}

export interface NormalizedGraphEvent {
  id: string
  iCalUId?: string
  subject?: string
  startUtc?: string
  endUtc?: string
  startTimeZone?: string
  endTimeZone?: string
  isCancelled: boolean
  isAllDay: boolean
  showAs?: string
  sensitivity?: string
  isOrganizer: boolean
  organizerAddress?: string
  attendeeCount: number
  userResponse?: string
  isOnlineMeeting: boolean
  onlineMeetingProvider?: string
  hasJoinUrl: boolean
  idempotencyKey?: string
  invalidReasons: GraphEventInvalidReason[]
}

export type GraphEventInvalidReason = 'missing_id' | 'invalid_start' | 'invalid_end' | 'invalid_time_range'

export type GraphDecisionReason =
  | 'eligible'
  | 'cancelled'
  | 'all_day'
  | 'free_time'
  | 'declined'
  | 'private_event_pending_policy'
  | 'invalid_time_range'
  | 'already_ended'
  | 'outside_lookahead'
  | 'not_online_meeting'
  | 'not_organizer'

export interface GraphEventDecision {
  eventId: string
  idempotencyKey?: string
  status: 'candidate' | 'excluded'
  reason: GraphDecisionReason
  autoRecordEligible: boolean
  logContext: {
    eventIdHash: string
    startUtc?: string
    endUtc?: string
    isOrganizer: boolean
    isCancelled: boolean
    isAllDay: boolean
    showAs?: string
    sensitivity?: string
    attendeeCount: number
    isOnlineMeeting: boolean
    onlineMeetingProvider?: string
    userResponse?: string
  }
}

export interface GraphFilterOptions {
  now: Date
  lookaheadMs: number
  graceMs: number
  requireOnlineMeeting: boolean
  requireOrganizerForAutoRecord: boolean
  excludePrivateEvents: boolean
}
