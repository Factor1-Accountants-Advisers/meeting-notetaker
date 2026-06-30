import type { GraphDateTimeTimeZone } from './types'

const UTC_TIME_ZONES = new Set(['utc', 'etc/utc', 'gmt', 'greenwich standard time'])
const OFFSET_PATTERN = /(?:z|[+-]\d{2}:?\d{2})$/i

export interface ParsedGraphDateTime {
  ok: boolean
  utc?: string
  reason?: 'missing_datetime' | 'unsupported_timezone' | 'invalid_datetime'
}

export function parseGraphDateTime(value: GraphDateTimeTimeZone | undefined): ParsedGraphDateTime {
  const dateTime = value?.dateTime?.trim()
  if (!dateTime) return { ok: false, reason: 'missing_datetime' }

  const timeZone = value?.timeZone?.trim()
  const parseable = hasExplicitOffset(dateTime)
    ? dateTime
    : timeZone && UTC_TIME_ZONES.has(timeZone.toLowerCase())
      ? `${dateTime}Z`
      : undefined

  if (!parseable) return { ok: false, reason: 'unsupported_timezone' }

  const parsed = new Date(parseable)
  if (Number.isNaN(parsed.getTime())) return { ok: false, reason: 'invalid_datetime' }
  return { ok: true, utc: parsed.toISOString() }
}

export function buildIdempotencyKey(eventId: string, startUtc: string | undefined): string | undefined {
  if (!eventId || !startUtc) return undefined
  return `${eventId}:${startUtc}`
}

function hasExplicitOffset(value: string): boolean {
  return OFFSET_PATTERN.test(value)
}
