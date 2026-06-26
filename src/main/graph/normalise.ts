import { buildIdempotencyKey, parseGraphDateTime } from './time'
import type { GraphEventInvalidReason, NormalizedGraphEvent, RawGraphEvent } from './types'

export interface NormaliseGraphEventOptions {
  signedInEmail?: string
}

export function normaliseGraphEvent(
  raw: RawGraphEvent,
  options: NormaliseGraphEventOptions = {}
): NormalizedGraphEvent {
  const id = raw.id ?? ''
  const invalidReasons: GraphEventInvalidReason[] = []
  if (!id) invalidReasons.push('missing_id')

  const start = parseGraphDateTime(raw.start)
  const end = parseGraphDateTime(raw.end)
  if (!start.ok) invalidReasons.push('invalid_start')
  if (!end.ok) invalidReasons.push('invalid_end')
  if (start.utc && end.utc && new Date(end.utc).getTime() <= new Date(start.utc).getTime()) {
    invalidReasons.push('invalid_time_range')
  }

  const attendees = raw.attendees ?? []
  const signedInEmail = options.signedInEmail?.toLowerCase()
  const signedInAttendee = signedInEmail
    ? attendees.find((attendee) => attendee.emailAddress?.address?.toLowerCase() === signedInEmail)
    : undefined

  return {
    id,
    iCalUId: raw.iCalUId,
    subject: raw.subject,
    startUtc: start.utc,
    endUtc: end.utc,
    startTimeZone: raw.start?.timeZone,
    endTimeZone: raw.end?.timeZone,
    isCancelled: raw.isCancelled === true,
    isAllDay: raw.isAllDay === true,
    showAs: raw.showAs,
    sensitivity: raw.sensitivity,
    isOrganizer: raw.isOrganizer === true,
    organizerAddress: raw.organizer?.emailAddress?.address,
    attendeeCount: attendees.length,
    userResponse: signedInAttendee?.status?.response ?? raw.responseStatus?.response,
    isOnlineMeeting: raw.isOnlineMeeting === true,
    onlineMeetingProvider: raw.onlineMeetingProvider,
    hasJoinUrl: Boolean(raw.onlineMeeting?.joinUrl),
    idempotencyKey: buildIdempotencyKey(id, start.utc),
    invalidReasons
  }
}
