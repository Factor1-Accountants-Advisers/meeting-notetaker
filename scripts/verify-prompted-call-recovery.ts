import { loadCallEndOutbox, queueCallEnd, acknowledgeCallEnd, replayCallEndOutbox } from '../src/renderer/src/lib/promptedCallEndOutbox'
import assert from 'node:assert/strict'
import { findPromptedCallMeetingId, promptedCallRecoveryAction, withPromptedCallEnded, resumeApprovedPromptedSharing } from '../src/renderer/src/lib/promptedCallRecovery'

const now = Date.parse('2026-10-06T08:30:00Z')
const meeting = {
  source: 'online', status: 'draft',
  graph_metadata: { prompted_call: { observed_end_utc: '2026-10-06T08:00:00Z' } },
  call_lookup_status: 'pending', call_lookup_next_retry_at: null,
  delivery_status: 'emailed', invitee_delivery_status: 'not_started'
}
assert.equal(promptedCallRecoveryAction(meeting, now), 'resolve')
assert.equal(promptedCallRecoveryAction({ ...meeting, call_lookup_next_retry_at: '2026-10-06T09:00:00Z' }, now), null)
assert.equal(promptedCallRecoveryAction({ ...meeting, call_lookup_status: 'resolved' }, now), 'share')
assert.equal(promptedCallRecoveryAction({ ...meeting, call_lookup_status: 'resolved', delivery_status: 'not_started' }, now), null)
assert.equal(promptedCallRecoveryAction({ ...meeting, call_lookup_status: 'resolved', invitee_delivery_status: 'sent' }, now), null)
assert.equal(promptedCallRecoveryAction({ ...meeting, call_lookup_status: 'expired' }, now), null)
assert.equal(promptedCallRecoveryAction({ ...meeting, status: 'finalized' }, now), null)
assert.equal(promptedCallRecoveryAction({ ...meeting, source: 'manual' }, now), null)
assert.equal(promptedCallRecoveryAction({ ...meeting, graph_metadata: null }, now), null)
const metadata = { attendees: [], meetingId: 'nonce', promptedTeamsCall: { nonce: 'nonce', observedStartUtc: '2026-10-06T07:45:00Z' } }
const ended = withPromptedCallEnded(metadata, 'nonce', '2026-10-06T08:00:00Z')
assert.equal(ended?.promptedTeamsCall?.observedEndUtc, '2026-10-06T08:00:00Z')
assert.equal(withPromptedCallEnded(metadata, 'stale', '2026-10-06T08:00:00Z'), metadata)
assert.equal(metadata.promptedTeamsCall.observedStartUtc, '2026-10-06T07:45:00Z')
const stored = { id: 'original-recording', source: 'online', graph_metadata: { prompted_call: { nonce: 'nonce' } } }
assert.equal(findPromptedCallMeetingId([stored], 'nonce'), 'original-recording', 'hang-up still targets the original recording after tray Stop')
assert.equal(findPromptedCallMeetingId([stored], 'stale'), null)
assert.equal(findPromptedCallMeetingId([stored, { ...stored, id: 'duplicate' }], 'nonce'), null)
assert.equal(findPromptedCallMeetingId([{ ...stored, source: 'manual' }], 'nonce'), null)
const storageData = new Map<string, string>()
const storage = { getItem: (key: string) => storageData.get(key) ?? null, setItem: (key: string, value: string) => { storageData.set(key, value) } }
const queued = { nonce: 'nonce', endedAtUtc: '2026-10-06T08:00:00Z' }
queueCallEnd(storage, 'owner-a', queued)
assert.deepEqual(loadCallEndOutbox(storage, 'owner-a'), [queued], 'a lost observation request survives reload')
assert.deepEqual(loadCallEndOutbox(storage, 'owner-b'), [], 'other accounts cannot replay the outbox')
assert.equal(acknowledgeCallEnd(storage, 'owner-a', queued, null), false)
assert.equal(acknowledgeCallEnd(storage, 'owner-a', queued, { graph_metadata: { prompted_call: { nonce: 'other', observed_end_utc: queued.endedAtUtc } } }), false)
assert.equal(loadCallEndOutbox(storage, 'owner-a').length, 1)
assert.equal(acknowledgeCallEnd(storage, 'owner-a', queued, { graph_metadata: { prompted_call: { nonce: 'nonce', observed_end_utc: '2026-10-06T08:00:00+00:00' } } }), true)
assert.deepEqual(loadCallEndOutbox(storage, 'owner-a'), [])
queueCallEnd(storage, 'owner-a', queued)
queueCallEnd(storage, 'owner-a', { ...queued, endedAtUtc: '2026-10-06T08:01:00Z' })
assert.deepEqual(loadCallEndOutbox(storage, 'owner-a'), [queued], 'duplicate notifications preserve the first observed end')
assert.equal(queueCallEnd(storage, 'owner-a', { nonce: 'invalid', endedAtUtc: 'bad' }), false)
assert.equal(queueCallEnd(storage, '', queued), false)
assert.equal(acknowledgeCallEnd(storage, 'owner-a', { ...queued, endedAtUtc: '2026-10-06T08:01:00Z' }, { graph_metadata: { prompted_call: { nonce: 'nonce', observed_end_utc: '2026-10-06T08:01:00Z' } } }), false)
assert.deepEqual(loadCallEndOutbox(storage, 'owner-a'), [queued], 'an acknowledgement for a different timestamp cannot remove the pending end')
const storedOriginal = { id: 'original-recording', source: 'online', graph_metadata: { prompted_call: { nonce: 'nonce' } } }
async function verifyReplay(): Promise<void> {
  const sharing = { prompt_enabled: true, decision: 'approved', invitee_delivery_status: 'not_started', candidates: [{}] }
  const flights = new Set<string>()
  let deliveries = 0
  const deliver = async () => { deliveries++ }
  for (const status of ['sending', 'sent', 'failed', 'unconfirmed']) {
    assert.equal(await resumeApprovedPromptedSharing({ ...sharing, invitee_delivery_status: status }, 'original-recording', flights, deliver), false, `${status} cannot auto-send`)
  }
  for (const decision of ['pending', 'declined']) {
    assert.equal(await resumeApprovedPromptedSharing({ ...sharing, decision }, 'original-recording', flights, deliver), false)
  }
  assert.equal(await resumeApprovedPromptedSharing({ ...sharing, prompt_enabled: false }, 'original-recording', flights, deliver), false)
  assert.equal(await resumeApprovedPromptedSharing({ ...sharing, candidates: [] }, 'original-recording', flights, deliver), false)
  assert.equal(deliveries, 0)
  assert.equal(await resumeApprovedPromptedSharing(sharing, 'original-recording', flights, deliver), true, 'durable approval resumes the existing delivery pass')
  assert.equal(deliveries, 1)
  let release!: () => void
  const blocked = resumeApprovedPromptedSharing(sharing, 'original-recording', flights, () => new Promise<void>((resolve) => { release = resolve }))
  assert.equal(await resumeApprovedPromptedSharing(sharing, 'original-recording', flights, deliver), false, 'click/recovery overlap stays single-flight')
  release()
  await blocked
  assert.equal(flights.size, 0)
  await assert.rejects(resumeApprovedPromptedSharing(sharing, 'original-recording', flights, async () => { throw new Error('delivery fixture failure') }))
  assert.equal(flights.size, 0, 'failure releases only the flight; authoritative send status controls future retries')
  let calls = 0
  const options = {
    storage, account: 'owner-a', isCurrent: () => true,
    fetchMeetings: async () => [storedOriginal],
    recordEnded: async (id: string, endedAtUtc: string) => {
      calls++
      assert.equal(id, 'original-recording')
      return { graph_metadata: { prompted_call: { nonce: 'nonce', observed_end_utc: endedAtUtc } } }
    }
  }
  await replayCallEndOutbox({ ...options, fetchMeetings: async () => null })
  assert.equal(calls, 0)
  await replayCallEndOutbox({ ...options, fetchMeetings: async () => [storedOriginal, { ...storedOriginal, id: 'ambiguous' }] })
  assert.equal(calls, 0, 'ambiguous nonce cannot select a recording')
  await replayCallEndOutbox({ ...options, recordEnded: async () => null })
  assert.equal(loadCallEndOutbox(storage, 'owner-a').length, 1)
  await replayCallEndOutbox({ ...options, recordEnded: async () => { throw new Error('offline fixture') } })
  assert.equal(loadCallEndOutbox(storage, 'owner-a').length, 1)
  let current = true
  await replayCallEndOutbox({ ...options, isCurrent: () => current, fetchMeetings: async () => { current = false; return [storedOriginal] } })
  assert.equal(calls, 0, 'account change during fetch prevents an observation request')
  await replayCallEndOutbox({ ...options, account: 'owner-b' })
  assert.equal(calls, 0)
  await replayCallEndOutbox(options)
  assert.equal(calls, 1)
  assert.deepEqual(loadCallEndOutbox(storage, 'owner-a'), [])
  await replayCallEndOutbox(options)
  assert.equal(calls, 1, 'acknowledged observations do not replay')
  const brokenStorage = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  assert.deepEqual(loadCallEndOutbox(brokenStorage, 'owner-a'), [])
  assert.equal(queueCallEnd(brokenStorage, 'owner-a', queued), false)
  console.log('Prompted-call renderer recovery verification passed')
}
void verifyReplay().catch((error) => { console.error(error); process.exitCode = 1 })
