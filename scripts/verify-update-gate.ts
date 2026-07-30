import assert from 'node:assert/strict'
import {
  AUTO_RECORD_GRACE_MS,
  AUTO_RECORD_LEAD_MS,
  COUNTDOWN_SECONDS,
  PENDING_AUDIO_BUSY_WINDOW_MS,
  SNOOZE_MS,
  SYSTEM_IDLE_MIN_SECONDS,
  evaluateUpdateGate,
  isBackendBusy,
  type UpdateGateInput
} from '../src/main/update-gate'

const NOW_UTC_MS = 1_800_000_000_000
const MINUTE_MS = 60_000

function base(): UpdateGateInput {
  return {
    updateDownloaded: true,
    recordingState: 'idle',
    pendingAutoStart: false,
    nextAutoRecordStartUtcMs: null,
    backendBusy: false,
    systemIdleSeconds: 300,
    snoozedUntilUtcMs: 0,
    nowUtcMs: NOW_UTC_MS
  }
}

async function main(): Promise<void> {
  // 1. All-clear allows.
  assert.deepEqual(
    evaluateUpdateGate(base()),
    { allow: true },
    'an all-clear input should allow the install'
  )

  // 2. No update downloaded blocks first.
  assert.deepEqual(
    evaluateUpdateGate({ ...base(), updateDownloaded: false }),
    { allow: false, reason: 'no_update_downloaded' },
    'no downloaded update must block'
  )

  // 3. Non-idle recording states block.
  assert.deepEqual(
    evaluateUpdateGate({ ...base(), recordingState: 'recording' }),
    { allow: false, reason: 'recording_active' },
    'an active recording must block'
  )
  assert.deepEqual(
    evaluateUpdateGate({ ...base(), recordingState: 'processing' }),
    { allow: false, reason: 'recording_active' },
    'a processing recording must block (covers paused, which is a separate flag on top of non-idle)'
  )

  // 4. Pending auto-start blocks.
  assert.deepEqual(
    evaluateUpdateGate({ ...base(), pendingAutoStart: true }),
    { allow: false, reason: 'auto_start_pending' },
    'a pending auto-start dispatch must block'
  )

  // 5. Auto-record proximity window, including the stale-past regression case.
  assert.deepEqual(
    evaluateUpdateGate({ ...base(), nextAutoRecordStartUtcMs: NOW_UTC_MS + 14 * MINUTE_MS }),
    { allow: false, reason: 'auto_record_imminent' },
    'a meeting starting in 14 minutes is within the 15-minute lead and must block'
  )
  assert.deepEqual(
    evaluateUpdateGate({ ...base(), nextAutoRecordStartUtcMs: NOW_UTC_MS + 16 * MINUTE_MS }),
    { allow: true },
    'a meeting starting in 16 minutes is outside the lead window and must allow'
  )
  assert.deepEqual(
    evaluateUpdateGate({ ...base(), nextAutoRecordStartUtcMs: NOW_UTC_MS - 1 * MINUTE_MS }),
    { allow: false, reason: 'auto_record_imminent' },
    'a meeting that started 1 minute ago is within the 2-minute grace and must still block'
  )
  assert.deepEqual(
    evaluateUpdateGate({ ...base(), nextAutoRecordStartUtcMs: NOW_UTC_MS - 30 * MINUTE_MS }),
    { allow: true },
    'regression: a stale start 30 minutes in the past must not block forever'
  )

  // 6. Backend busy blocks.
  assert.deepEqual(
    evaluateUpdateGate({ ...base(), backendBusy: true }),
    { allow: false, reason: 'backend_processing' },
    'a busy backend must block'
  )

  // 7. System idle threshold.
  assert.deepEqual(
    evaluateUpdateGate({ ...base(), systemIdleSeconds: 299 }),
    { allow: false, reason: 'user_active' },
    'just under the idle threshold must block'
  )
  assert.deepEqual(
    evaluateUpdateGate({ ...base(), systemIdleSeconds: 300 }),
    { allow: true },
    'exactly at the idle threshold must allow'
  )

  // 8. Snooze window.
  assert.deepEqual(
    evaluateUpdateGate({ ...base(), snoozedUntilUtcMs: NOW_UTC_MS + 1 }),
    { allow: false, reason: 'snoozed' },
    'a snooze that has not yet expired must block'
  )
  assert.deepEqual(
    evaluateUpdateGate({ ...base(), snoozedUntilUtcMs: NOW_UTC_MS }),
    { allow: true },
    'a snooze expiring exactly now must allow'
  )

  // 9. Priority: recording is checked before snooze.
  assert.deepEqual(
    evaluateUpdateGate({
      ...base(),
      recordingState: 'recording',
      snoozedUntilUtcMs: NOW_UTC_MS + 1
    }),
    { allow: false, reason: 'recording_active' },
    'recording state must take priority over an active snooze'
  )

  // 10. isBackendBusy pipeline-status and pending_audio age handling.
  assert.equal(
    isBackendBusy(
      [{ pipeline_status: 'queued', created_at: new Date(NOW_UTC_MS).toISOString() }],
      NOW_UTC_MS
    ),
    true,
    'a queued meeting is busy'
  )
  assert.equal(
    isBackendBusy(
      [{ pipeline_status: 'processing', created_at: new Date(NOW_UTC_MS).toISOString() }],
      NOW_UTC_MS
    ),
    true,
    'a processing meeting is busy'
  )
  assert.equal(
    isBackendBusy(
      [{ pipeline_status: 'ready', created_at: new Date(NOW_UTC_MS).toISOString() }],
      NOW_UTC_MS
    ),
    false,
    'a ready meeting is not busy'
  )
  assert.equal(
    isBackendBusy(
      [{ pipeline_status: 'failed', created_at: new Date(NOW_UTC_MS).toISOString() }],
      NOW_UTC_MS
    ),
    false,
    'a failed meeting is not busy'
  )
  assert.equal(
    isBackendBusy(
      [
        {
          pipeline_status: 'pending_audio',
          created_at: new Date(NOW_UTC_MS - 29 * MINUTE_MS).toISOString()
        }
      ],
      NOW_UTC_MS
    ),
    true,
    'a pending_audio meeting created 29 minutes ago is still within the busy window'
  )
  assert.equal(
    isBackendBusy(
      [
        {
          pipeline_status: 'pending_audio',
          created_at: new Date(NOW_UTC_MS - 31 * MINUTE_MS).toISOString()
        }
      ],
      NOW_UTC_MS
    ),
    false,
    'a pending_audio meeting created 31 minutes ago is stale and must not block forever'
  )
  assert.equal(
    isBackendBusy([{ pipeline_status: 'pending_audio', created_at: 'not-a-date' }], NOW_UTC_MS),
    false,
    'an unparsable created_at must not count as busy'
  )
  assert.equal(isBackendBusy([], NOW_UTC_MS), false, 'no meetings means the backend is not busy')

  // 11. Pin exported constants.
  assert.equal(SNOOZE_MS, 4 * 60 * 60_000, 'SNOOZE_MS must stay pinned at 4 hours')
  assert.equal(COUNTDOWN_SECONDS, 60, 'COUNTDOWN_SECONDS must stay pinned at 60')
  assert.equal(AUTO_RECORD_LEAD_MS, 15 * 60_000, 'AUTO_RECORD_LEAD_MS must stay pinned at 15 minutes')
  assert.equal(AUTO_RECORD_GRACE_MS, 2 * 60_000, 'AUTO_RECORD_GRACE_MS must stay pinned at 2 minutes')
  assert.equal(SYSTEM_IDLE_MIN_SECONDS, 300, 'SYSTEM_IDLE_MIN_SECONDS must stay pinned at 300')
  assert.equal(
    PENDING_AUDIO_BUSY_WINDOW_MS,
    30 * 60_000,
    'PENDING_AUDIO_BUSY_WINDOW_MS must stay pinned at 30 minutes'
  )

  console.log('Update gate verification passed')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
