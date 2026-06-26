import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireGraphTokenSilent, getMsalConfigStatus } from '../src/main/auth-msal.ts'
import { getRetryAfterMs } from '../src/main/graph/client.ts'
import { decideGraphEvent } from '../src/main/graph/filter.ts'
import { normaliseGraphEvent } from '../src/main/graph/normalise.ts'
import { detectGraphMeetings } from '../src/main/graph/poller.ts'
import { syncGraphDetectionOnce } from '../src/main/graph/runtime.ts'
import { parseGraphDateTime } from '../src/main/graph/time.ts'
import type { GraphDecisionReason, GraphFilterOptions, RawGraphEvent } from '../src/main/graph/types.ts'

const now = new Date('2026-06-26T00:00:00.000Z')
const options: GraphFilterOptions = {
  now,
  lookaheadMs: 24 * 60 * 60 * 1000,
  graceMs: 10 * 60 * 1000,
  requireOnlineMeeting: true,
  requireOrganizerForAutoRecord: true,
  excludePrivateEvents: true
}

const signedInEmail = 'joseph@factor1.com.au'

function baseEvent(overrides: Partial<RawGraphEvent> = {}): RawGraphEvent {
  return {
    id: 'event-base',
    subject: 'Client meeting',
    start: { dateTime: '2026-06-26T01:00:00', timeZone: 'UTC' },
    end: { dateTime: '2026-06-26T02:00:00', timeZone: 'UTC' },
    isCancelled: false,
    isAllDay: false,
    showAs: 'busy',
    sensitivity: 'normal',
    isOrganizer: true,
    organizer: { emailAddress: { name: 'Joseph', address: signedInEmail } },
    attendees: [
      { emailAddress: { name: 'Joseph', address: signedInEmail }, status: { response: 'accepted' } },
      { emailAddress: { name: 'Client', address: 'client@example.com' }, status: { response: 'accepted' } }
    ],
    responseStatus: { response: 'accepted' },
    isOnlineMeeting: true,
    onlineMeetingProvider: 'teamsForBusiness',
    onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/redacted' },
    ...overrides
  }
}

function decisionFor(event: RawGraphEvent) {
  return decideGraphEvent(normaliseGraphEvent(event, { signedInEmail }), options)
}

function expectReason(name: string, event: RawGraphEvent, reason: GraphDecisionReason): void {
  const decision = decisionFor(event)
  assert.equal(decision.reason, reason, `${name}: expected ${reason}, got ${decision.reason}`)
}

async function main(): Promise<void> {
  expectReason('cancelled Teams meeting', baseEvent({ id: 'cancelled', isCancelled: true }), 'cancelled')
  expectReason('all-day event', baseEvent({ id: 'all-day', isAllDay: true }), 'all_day')
  expectReason('free focus block', baseEvent({ id: 'free', showAs: 'free' }), 'free_time')
  expectReason(
    'declined meeting',
    baseEvent({
      id: 'declined',
      attendees: [
        { emailAddress: { name: 'Joseph', address: signedInEmail }, status: { response: 'declined' } }
      ],
      responseStatus: { response: 'accepted' }
    }),
    'declined'
  )
  expectReason('private meeting pending policy', baseEvent({ id: 'private', sensitivity: 'private' }), 'private_event_pending_policy')
  expectReason('non-organiser meeting remains candidate but not auto eligible', baseEvent({ id: 'non-organiser', isOrganizer: false }), 'not_organizer')
  expectReason('missing online metadata', baseEvent({ id: 'offline', isOnlineMeeting: false, onlineMeeting: undefined }), 'not_online_meeting')
  expectReason(
    'already ended meeting',
    baseEvent({ id: 'ended', start: { dateTime: '2026-06-25T22:00:00Z' }, end: { dateTime: '2026-06-25T23:00:00Z' } }),
    'already_ended'
  )
  expectReason(
    'outside lookahead',
    baseEvent({ id: 'future', start: { dateTime: '2026-06-27T02:00:01Z' }, end: { dateTime: '2026-06-27T03:00:00Z' } }),
    'outside_lookahead'
  )

  const organiser = decisionFor(baseEvent({ id: 'organiser' }))
  assert.equal(organiser.status, 'candidate')
  assert.equal(organiser.reason, 'eligible')
  assert.equal(organiser.autoRecordEligible, true)
  assert.equal(organiser.idempotencyKey, 'organiser:2026-06-26T01:00:00.000Z')
  assert.equal(organiser.logContext.eventIdHash.length, 12)

  const nonOrganiser = decisionFor(baseEvent({ id: 'non-organiser-auto', isOrganizer: false }))
  assert.equal(nonOrganiser.status, 'candidate')
  assert.equal(nonOrganiser.autoRecordEligible, false)

  const batch = detectGraphMeetings(
    [baseEvent({ id: 'batch-eligible' }), baseEvent({ id: 'batch-cancelled', isCancelled: true })],
    { signedInEmail, filter: options }
  )
  assert.equal(batch.decisions.length, 2)
  assert.equal(batch.candidates.length, 1)
  assert.equal(batch.autoRecordEligible.length, 1)
  assert.equal(batch.excluded.length, 1)

  const phOffset = parseGraphDateTime({ dateTime: '2026-06-26T09:00:00+08:00', timeZone: 'Singapore Standard Time' })
  assert.deepEqual(phOffset, { ok: true, utc: '2026-06-26T01:00:00.000Z' })

  const auOffset = parseGraphDateTime({ dateTime: '2026-06-26T11:00:00+10:00', timeZone: 'AUS Eastern Standard Time' })
  assert.deepEqual(auOffset, { ok: true, utc: '2026-06-26T01:00:00.000Z' })

  const utcWithoutOffset = parseGraphDateTime({ dateTime: '2026-06-26T01:00:00', timeZone: 'UTC' })
  assert.deepEqual(utcWithoutOffset, { ok: true, utc: '2026-06-26T01:00:00.000Z' })

  const unsupportedNamedZone = parseGraphDateTime({ dateTime: '2026-06-26T09:00:00', timeZone: 'Singapore Standard Time' })
  assert.equal(unsupportedNamedZone.ok, false)
  assert.equal(unsupportedNamedZone.reason, 'unsupported_timezone')

  assert.equal(getRetryAfterMs('10'), 10_000)
  assert.equal(getRetryAfterMs('not-a-date'), 30_000)

  const missingMsalConfig = getMsalConfigStatus({})
  assert.equal(missingMsalConfig.configured, false)
  assert.deepEqual(missingMsalConfig.missing, ['MN_ENTRA_CLIENT_ID', 'MN_ENTRA_TENANT_ID'])
  const noToken = await acquireGraphTokenSilent(undefined, {})
  assert.equal(noToken.accessToken, null)
  assert.equal(noToken.reason, 'missing_config')

  const configuredMsalConfig = getMsalConfigStatus({
    MN_ENTRA_CLIENT_ID: 'client-id',
    MN_ENTRA_TENANT_ID: 'tenant-id'
  })
  assert.equal(configuredMsalConfig.configured, true)
  assert.equal(configuredMsalConfig.config?.authority, 'https://login.microsoftonline.com/tenant-id')

  const runtimeDir = await mkdtemp(join(tmpdir(), 'notetaker-graph-fixtures-'))
  try {
    const skipped = await syncGraphDetectionOnce({
      statePath: join(runtimeDir, 'skipped.json'),
      getAccessToken: async () => null,
      getSignedInEmail: () => signedInEmail,
      logger: { info: () => undefined, warn: () => undefined },
      now: () => now
    })
    assert.equal(skipped.status, 'skipped_no_token')
    assert.equal(skipped.decisions.length, 0)

    const synced = await syncGraphDetectionOnce({
      statePath: join(runtimeDir, 'synced.json'),
      getAccessToken: async () => 'redacted-token',
      getSignedInEmail: () => signedInEmail,
      logger: { info: () => undefined, warn: () => undefined },
      now: () => now,
      clientFactory: () => ({
        fetchCalendarView: async () => ({ value: [baseEvent({ id: 'runtime-eligible' })] }),
        fetchDeltaLink: async () => ({ value: [] })
      })
    })
    assert.equal(synced.status, 'success')
    assert.equal(synced.decisions.length, 1)
    assert.equal(synced.state.decisions['runtime-eligible:2026-06-26T01:00:00.000Z'].autoRecordEligible, true)
  } finally {
    await rm(runtimeDir, { recursive: true, force: true })
  }

  console.log('Graph fixture verification passed')
}

void main()
