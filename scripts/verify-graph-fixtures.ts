import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireGraphTokenSilent, getMsalConfigStatus } from '../src/main/auth-msal.ts'
import { getRetryAfterMs } from '../src/main/graph/client.ts'
import { decideGraphEvent } from '../src/main/graph/filter.ts'
import { normaliseGraphEvent } from '../src/main/graph/normalise.ts'
import { detectGraphMeetings } from '../src/main/graph/poller.ts'
import { syncGraphDetectionOnce, startGraphDetectionRuntime } from '../src/main/graph/runtime.ts'
import { evaluateHostGate } from '../src/main/graph/host-gate.ts'
import { createRecordingStateMachine } from '../src/main/recording-state.ts'
import {
  cleanupRecordingIpc,
  getEndReminderPlan,
  getRecordingStateMachine,
  handleRendererRecordingReady,
  handleRendererRecordingStarted,
  handleRendererRecordingStopped,
  registerManualRecording,
  sendAutoStartRequest,
  sendTrayRecordingControl,
  setAutoStartAckTimeoutMsForTest,
  setMainWindow
} from '../src/main/recording-ipc.ts'
import { parseGraphDateTime } from '../src/main/graph/time.ts'
import type { GraphDecisionReason, GraphFilterOptions, RawGraphEvent } from '../src/main/graph/types.ts'

const now = new Date('2026-06-26T00:58:00.000Z')
const options: GraphFilterOptions = {
  now,
  lookaheadMs: 24 * 60 * 60 * 1000,
  autoStartLeadMs: 3 * 60 * 1000,
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

function fakeWindow(): { window: any; sent: { channel: string; data: unknown }[] } {
  const sent: { channel: string; data: unknown }[] = []
  return {
    window: {
      isDestroyed: () => false,
      show: () => undefined,
      hide: () => undefined,
      webContents: {
        send: (channel: string, data: unknown) => sent.push({ channel, data })
      }
    },
    sent
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await wait(10)
  }
  assert.fail(`${label} did not complete within ${timeoutMs}ms`)
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
  expectReason(
    'future meeting before auto-start window',
    baseEvent({ id: 'not-due-yet', start: { dateTime: '2026-06-26T03:00:00Z' }, end: { dateTime: '2026-06-26T03:30:00Z' } }),
    'not_due_yet'
  )
  expectReason(
    'recently ended meeting is not auto eligible',
    baseEvent({ id: 'recently-ended', start: { dateTime: '2026-06-26T00:00:00Z' }, end: { dateTime: '2026-06-26T00:55:00Z' } }),
    'already_ended'
  )

  const notDueYet = decisionFor(baseEvent({ id: 'not-due-auto', start: { dateTime: '2026-06-26T03:00:00Z' }, end: { dateTime: '2026-06-26T03:30:00Z' } }))
  assert.equal(notDueYet.status, 'candidate')
  assert.equal(notDueYet.autoRecordEligible, false)

  const organiser = decisionFor(baseEvent({ id: 'organiser' }))
  assert.equal(organiser.status, 'candidate')
  assert.equal(organiser.reason, 'eligible')
  assert.equal(organiser.autoRecordEligible, true)
  assert.equal(organiser.idempotencyKey, 'organiser:2026-06-26T01:00:00.000Z')
  assert.equal(organiser.metadata.title, 'Client meeting')
  assert.equal(organiser.metadata.meetingId, 'organiser')
  assert.equal(organiser.metadata.onlineMeetingId, undefined)
  assert.equal(organiser.metadata.joinWebUrl, 'https://teams.microsoft.com/l/meetup-join/redacted')
  assert.equal(organiser.metadata.organizerEmail, signedInEmail)
  assert.equal(organiser.metadata.attendees.length, 2)
  assert.equal(organiser.metadata.attendees[1].email, 'client@example.com')
  assert.equal(organiser.logContext.eventIdHash.length, 12)

  const nonOrganiser = decisionFor(baseEvent({ id: 'non-organiser-auto', isOrganizer: false }))
  assert.equal(nonOrganiser.status, 'candidate')
  assert.equal(nonOrganiser.autoRecordEligible, false)

  // Host-gate (IN-67): explicit organiser-only boundary
  const organiserGate = evaluateHostGate(organiser, signedInEmail)
  assert.equal(organiserGate.allowed, true)
  assert.equal(organiserGate.reason, 'organizer_verified')

  const nonOrganiserGate = evaluateHostGate(nonOrganiser, signedInEmail)
  assert.equal(nonOrganiserGate.allowed, false)
  assert.equal(nonOrganiserGate.reason, 'not_auto_record_eligible')

  const excludedGate = evaluateHostGate(
    decisionFor(baseEvent({ id: 'excluded-gate', isCancelled: true })),
    signedInEmail
  )
  assert.equal(excludedGate.allowed, false)
  assert.equal(excludedGate.reason, 'excluded_by_filter')

  const noEmailGate = evaluateHostGate(organiser)
  assert.equal(noEmailGate.allowed, true)
  assert.equal(noEmailGate.reason, 'organizer_confirmed')

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

  // IN-124: an ending reminder must not disappear when recording starts inside
  // its five-minute window. There is exactly one attempt per scheduled end.
  const reminderNow = Date.parse('2026-07-13T00:00:00.000Z')
  assert.deepEqual(getEndReminderPlan(reminderNow + 10 * 60_000, reminderNow), {
    kind: 'scheduled',
    delayMs: 5 * 60_000
  })
  assert.deepEqual(getEndReminderPlan(reminderNow + 2 * 60_000, reminderNow), { kind: 'immediate' })
  assert.deepEqual(getEndReminderPlan(reminderNow, reminderNow), { kind: 'skip', reason: 'ended' })

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

  // Recording state machine (IN-66)
  const sm = createRecordingStateMachine()
  assert.equal(sm.getState(), 'idle')
  assert.equal(sm.getActiveRecording(), null)

  // Can start auto when idle
  assert.equal(sm.canStartAutoRecording('key-1'), true)

  // Start auto recording
  sm.startAutoRecording({
    eventId: 'event-1',
    idempotencyKey: 'key-1',
    startTimeUtc: '2026-06-26T01:00:00.000Z',
    endTimeUtc: '2026-06-26T02:00:00.000Z',
    source: 'auto'
  })
  assert.equal(sm.getState(), 'recording')
  assert.equal(sm.getActiveRecording()?.eventId, 'event-1')

  // Cannot start another auto while recording
  assert.equal(sm.canStartAutoRecording('key-2'), false)

  // Stop transitions to processing
  const finished = sm.stopRecording()
  assert.equal(finished?.eventId, 'event-1')
  assert.equal(sm.getState(), 'processing')

  // Complete processing returns to idle
  sm.completeProcessing()
  assert.equal(sm.getState(), 'idle')

  // IN-126: a manual Home recording is tracked in the same state machine so
  // tray Pause/Resume/Stop controls work and Graph cannot start over it.
  sm.startManualRecording({
    eventId: 'manual-event',
    idempotencyKey: 'manual-key',
    startTimeUtc: '2026-06-26T02:00:00.000Z',
    endTimeUtc: '2026-06-26T10:00:00.000Z',
    source: 'manual'
  })
  assert.equal(sm.getState(), 'recording')
  assert.equal(sm.getActiveRecording()?.source, 'manual')
  assert.equal(sm.canStartAutoRecording('key-after-manual'), false)
  sm.stopRecording()
  sm.completeProcessing()
  assert.equal(sm.getState(), 'idle')

  // Cannot re-record the same key
  assert.equal(sm.canStartAutoRecording('key-1'), false)
  assert.equal(sm.canStartAutoRecording('key-2'), true)
  assert.equal(sm.canStartAutoRecording('key-3'), true)

  // Auto-start IPC must not move to recording until the renderer acknowledges capture start.
  cleanupRecordingIpc()
  setAutoStartAckTimeoutMsForTest(10)
  const firstWindow = fakeWindow()
  setMainWindow(firstWindow.window)
  handleRendererRecordingReady()
  sendAutoStartRequest({
    eventId: 'ipc-event-1',
    idempotencyKey: 'ipc-key-1',
    startTimeUtc: '2026-06-26T01:00:00.000Z',
    endTimeUtc: '2026-06-26T02:00:00.000Z',
    source: 'auto'
  })
  assert.equal(firstWindow.sent.length, 1)
  assert.equal(firstWindow.sent[0].channel, 'recording:auto-start-request')
  assert.equal(getRecordingStateMachine().getState(), 'idle')
  handleRendererRecordingStarted()
  assert.equal(getRecordingStateMachine().getState(), 'recording')
  handleRendererRecordingStopped()
  assert.equal(getRecordingStateMachine().getState(), 'idle')

  // If the renderer misses the message, the pending start times out and does not wedge the session.
  sendAutoStartRequest({
    eventId: 'ipc-event-timeout',
    idempotencyKey: 'ipc-key-timeout',
    startTimeUtc: '2026-06-26T01:00:00.000Z',
    endTimeUtc: '2026-06-26T02:00:00.000Z',
    source: 'auto'
  })
  await wait(20)
  assert.equal(getRecordingStateMachine().getState(), 'idle')
  sendAutoStartRequest({
    eventId: 'ipc-event-after-timeout',
    idempotencyKey: 'ipc-key-after-timeout',
    startTimeUtc: '2026-06-26T01:00:00.000Z',
    endTimeUtc: '2026-06-26T02:00:00.000Z',
    source: 'auto'
  })
  assert.equal(firstWindow.sent.at(-1)?.channel, 'recording:auto-start-request')
  handleRendererRecordingStarted()
  handleRendererRecordingStopped()

  // Renderer-ready notification replays a pending auto-start after the listener mounts.
  const replayWindow = fakeWindow()
  cleanupRecordingIpc()
  setAutoStartAckTimeoutMsForTest(100)
  setMainWindow(replayWindow.window)
  sendAutoStartRequest({
    eventId: 'ipc-event-replay',
    idempotencyKey: 'ipc-key-replay',
    startTimeUtc: '2026-06-26T01:00:00.000Z',
    endTimeUtc: '2026-06-26T02:00:00.000Z',
    source: 'auto'
  })
  assert.equal(replayWindow.sent.length, 0)
  handleRendererRecordingReady()
  assert.equal(replayWindow.sent.length, 1)
  handleRendererRecordingStarted()
  assert.equal(getRecordingStateMachine().getState(), 'recording')
  handleRendererRecordingStopped()

  // IN-126: manual Home starts register through the IPC state machine, making
  // the tray controls available while keeping Graph auto-starts blocked.
  cleanupRecordingIpc()
  const manualWindow = fakeWindow()
  setMainWindow(manualWindow.window)
  registerManualRecording({
    eventId: 'manual-ipc-event',
    idempotencyKey: 'manual-ipc-key',
    startTimeUtc: '2026-06-26T02:00:00.000Z',
    endTimeUtc: '2026-06-26T10:00:00.000Z',
    source: 'manual',
    title: 'Manual client meeting'
  })
  assert.equal(getRecordingStateMachine().getActiveRecording()?.source, 'manual')
  assert.deepEqual(getRecordingStateMachine().getActiveRecording()?.metadata, { title: 'Manual client meeting' })
  assert.equal(getRecordingStateMachine().canStartAutoRecording('auto-during-manual'), false)
  handleRendererRecordingStopped()

  // IN-120: tray commands are forwarded to the active renderer only; the
  // automatic recording lifecycle retains ownership of start and stop state.
  cleanupRecordingIpc()
  const controlWindow = fakeWindow()
  setMainWindow(controlWindow.window)
  sendTrayRecordingControl('pause')
  sendTrayRecordingControl('resume')
  sendTrayRecordingControl('stop')
  assert.deepEqual(controlWindow.sent, [
    { channel: 'recording:tray-control', data: { action: 'pause' } },
    { channel: 'recording:tray-control', data: { action: 'resume' } },
    { channel: 'recording:tray-control', data: { action: 'stop' } }
  ])
  cleanupRecordingIpc()

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

    // Verify onAutoRecordEligible callback is invoked (IN-66)
    let callbackDecisions: typeof synced.decisions = []
    const callbackRuntime = startGraphDetectionRuntime({
      statePath: join(runtimeDir, 'callback.json'),
      getAccessToken: async () => 'redacted-token',
      getSignedInEmail: () => signedInEmail,
      logger: { info: () => undefined, warn: () => undefined },
      now: () => now,
      clientFactory: () => ({
        fetchCalendarView: async () => ({ value: [baseEvent({ id: 'callback-eligible' })] }),
        fetchDeltaLink: async () => ({ value: [] })
      }),
      onAutoRecordEligible: (decisions) => {
        callbackDecisions = decisions
      }
    })
    // Wait for startup sync to complete and call the callback
    await new Promise((resolve) => setTimeout(resolve, 30))
    callbackRuntime.stopPolling()
    assert.equal(callbackDecisions.length, 1)
    assert.equal(callbackDecisions[0].autoRecordEligible, true)

    // Polling lifecycle: start/stop/resume API surface
    const pollRuntime = startGraphDetectionRuntime({
      statePath: join(runtimeDir, 'poll.json'),
      getAccessToken: async () => null,
      getSignedInEmail: () => signedInEmail,
      logger: { info: () => undefined, warn: () => undefined },
      now: () => now
    })
    assert.equal(typeof pollRuntime.syncNow, 'function')
    assert.equal(typeof pollRuntime.startPolling, 'function')
    assert.equal(typeof pollRuntime.stopPolling, 'function')
    assert.equal(typeof pollRuntime.scheduleResumeSync, 'function')

    // start/stop shouldn't throw
    pollRuntime.startPolling(100)
    pollRuntime.stopPolling()
    pollRuntime.startPolling()
    pollRuntime.stopPolling()

    // scheduleResumeSync should trigger a sync after debounce
    let resumeSynced = false
    const resumeRuntime = startGraphDetectionRuntime({
      statePath: join(runtimeDir, 'resume.json'),
      getAccessToken: async () => 'redacted-token',
      getSignedInEmail: () => signedInEmail,
      logger: {
        info: (msg: string) => { if (msg === '[graph] resume sync finished') resumeSynced = true },
        warn: () => undefined
      },
      now: () => now,
      resumeDebounceMs: 0,
      clientFactory: () => ({
        fetchCalendarView: async () => ({ value: [] }),
        fetchDeltaLink: async () => ({ value: [] })
      })
    })
    // Wait for startup sync to complete (it auto-starts polling on success)
    await new Promise((resolve) => setTimeout(resolve, 30))
    resumeRuntime.stopPolling()
    resumeRuntime.scheduleResumeSync()
    // Wait for the debounced resume sync to finish. Poll the observable
    // condition instead of assuming a fixed 30ms scheduler window.
    await waitUntil('resume sync', () => resumeSynced)
    resumeRuntime.stopPolling()
    assert.equal(resumeSynced, true)
  } finally {
    await rm(runtimeDir, { recursive: true, force: true })
  }

  console.log('Graph fixture verification passed')
}

void main()
