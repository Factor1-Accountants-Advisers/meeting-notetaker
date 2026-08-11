import assert from 'node:assert/strict'
import { parseAudioEndpointLine } from '../src/main/audio-endpoint-protocol'

const parsed = parseAudioEndpointLine(
  JSON.stringify({
    schemaVersion: 1,
    kind: 'snapshot',
    generation: 3,
    endpoints: {
      captureConsole: { id: 'cap-console', label: 'Microphone Array' },
      captureCommunications: { id: 'cap-comms', label: 'Headset Microphone' },
      renderConsole: { id: 'render-console', label: 'Speakers' },
      renderCommunications: { id: 'render-comms', label: 'Headphones' }
    }
  })
)

assert.equal(parsed?.generation, 3)
assert.equal(parsed?.endpoints.captureCommunications?.label, 'Headset Microphone')
assert.equal(parseAudioEndpointLine('{bad json'), null)
assert.equal(parseAudioEndpointLine('{"schemaVersion":2}'), null)
assert.equal(
  parseAudioEndpointLine(
    JSON.stringify({
      schemaVersion: 1,
      kind: 'snapshot',
      generation: -1,
      endpoints: {}
    })
  ),
  null
)
assert.equal(
  parseAudioEndpointLine(
    JSON.stringify({
      schemaVersion: 1,
      kind: 'snapshot',
      generation: 1,
      endpoints: {
        captureConsole: { id: 123, label: 'Broken' },
        captureCommunications: null,
        renderConsole: null,
        renderCommunications: null
      }
    })
  ),
  null
)

console.log('Audio endpoint protocol verification passed')
