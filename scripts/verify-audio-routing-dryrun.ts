import assert from 'node:assert/strict'
import { resolveDryRunMatch, formatDryRunLog } from '../src/renderer/src/lib/audioRoutingDryRun'
import type { AudioEndpointSnapshot } from '../src/shared/audio-endpoints'

const snapshot = (label: string | null): AudioEndpointSnapshot => ({
  schemaVersion: 1,
  kind: 'snapshot',
  generation: 3,
  endpoints: {
    captureConsole: { id: 'cap-console', label: 'Microphone Array (Realtek)' },
    captureCommunications: label ? { id: 'cap-comms', label } : null,
    renderConsole: { id: 'rend-console', label: 'Speakers (Realtek)' },
    renderCommunications: { id: 'rend-comms', label: 'Headset Earphone (Jabra)' }
  }
})

const device = (deviceId: string, label: string, groupId = 'g1'): MediaDeviceInfo =>
  ({ deviceId, kind: 'audioinput', label, groupId, toJSON: () => ({}) }) as MediaDeviceInfo

// 1. Unique label match → matched, pseudo-devices excluded from the pool.
{
  const result = resolveDryRunMatch(snapshot('Headset Microphone (Jabra)'), [
    device('default', 'Default - Headset Microphone (Jabra)'),
    device('communications', 'Communications - Headset Microphone (Jabra)'),
    device('real-1', 'Headset Microphone (Jabra)'),
    device('real-2', 'Microphone Array (Realtek)', 'g2')
  ])
  assert.equal(result.outcome, 'matched')
  assert.equal(result.deviceId, 'real-1')
}

// 2. Blank labels (no getUserMedia grant yet) → labels_blank, no device chosen.
{
  const result = resolveDryRunMatch(snapshot('Headset Microphone (Jabra)'), [
    device('default', ''),
    device('real-1', '')
  ])
  assert.equal(result.outcome, 'labels_blank')
  assert.equal(result.deviceId, null)
}

// 3. Two devices sharing the label with DISTINCT groupIds → genuinely different
//    hardware → ambiguous. (Same groupId would mean duplicate enumerations of
//    one device → matched; not exercised here.)
{
  const result = resolveDryRunMatch(snapshot('USB Microphone'), [
    device('real-1', 'USB Microphone', 'ga'),
    device('real-2', 'USB Microphone', 'gb')
  ])
  assert.equal(result.outcome, 'ambiguous')
}

// 4. No communications capture endpoint in the snapshot → no_snapshot.
{
  const result = resolveDryRunMatch(snapshot(null), [device('real-1', 'Headset Microphone (Jabra)')])
  assert.equal(result.outcome, 'no_snapshot')
}

// 5. Populated labels, nothing matches → no_match.
{
  const result = resolveDryRunMatch(snapshot('Headset Microphone (Jabra)'), [
    device('real-2', 'Microphone Array (Realtek)')
  ])
  assert.equal(result.outcome, 'no_match')
}

// 6. Log line is single-line JSON carrying the essentials.
{
  const line = formatDryRunLog(
    'recording-start',
    snapshot('Headset Microphone (Jabra)'),
    {
      outcome: 'matched',
      deviceId: 'real-1',
      deviceLabel: 'Headset Microphone (Jabra)'
    },
    'Microphone Array (Realtek)'
  )
  const parsed = JSON.parse(line)
  assert.equal(parsed.event, 'recording-start')
  assert.equal(parsed.generation, 3)
  assert.equal(parsed.outcome, 'matched')
  assert.equal(parsed.wouldUse, 'Headset Microphone (Jabra)')
  assert.equal(parsed.activeMic, 'Microphone Array (Realtek)')
  assert.ok(!line.includes('\n'))
}

console.log('verify-audio-routing-dryrun: all assertions passed')
