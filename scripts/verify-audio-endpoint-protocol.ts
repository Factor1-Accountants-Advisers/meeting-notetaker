import assert from 'node:assert/strict'
import { parseAudioEndpointLine, parseTeamsCallLine } from '../src/main/audio-endpoint-protocol'

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

const teamsLine = JSON.stringify({
  schemaVersion: 1,
  kind: 'teams-call',
  generation: 7,
  active: null,
  preJoin: true,
  windowTitles: ['Meeting join']
})
const teams = parseTeamsCallLine(teamsLine)
assert.deepEqual(teams, {
  schemaVersion: 1,
  kind: 'teams-call',
  generation: 7,
  active: null,
  preJoin: true,
  windowTitles: ['Meeting join']
})
assert.equal(parseAudioEndpointLine(teamsLine), null, 'old parser must reject the new kind')
assert.equal(
  parseTeamsCallLine(
    JSON.stringify({
      schemaVersion: 1,
      kind: 'teams-call',
      generation: 1,
      active: 'false',
      preJoin: false,
      windowTitles: []
    })
  ),
  null,
  'active must not be coerced'
)
assert.equal(
  parseTeamsCallLine(
    JSON.stringify({
      schemaVersion: 1,
      kind: 'teams-call',
      generation: 1.5,
      active: false,
      preJoin: false,
      windowTitles: []
    })
  ),
  null,
  'generation must be an integer'
)
assert.equal(
  parseTeamsCallLine(
    JSON.stringify({
      schemaVersion: 1,
      kind: 'teams-call',
      generation: 1,
      active: false,
      preJoin: 1,
      windowTitles: []
    })
  ),
  null,
  'preJoin must not be coerced'
)
assert.equal(
  parseTeamsCallLine(
    JSON.stringify({
      schemaVersion: 1,
      kind: 'teams-call',
      generation: 1,
      active: false,
      preJoin: false,
      windowTitles: Array.from({ length: 17 }, () => 'title')
    })
  ),
  null,
  'window title count must be bounded'
)
assert.equal(
  parseTeamsCallLine(
    JSON.stringify({
      schemaVersion: 1,
      kind: 'teams-call',
      generation: 1,
      active: false,
      preJoin: false,
      windowTitles: ['x'.repeat(257)]
    })
  ),
  null,
  'window title length must be bounded'
)
assert.equal(
  parseTeamsCallLine(
    JSON.stringify({
      schemaVersion: 1,
      kind: 'teams-call',
      generation: 1,
      active: false,
      preJoin: false,
      windowTitles: [],
      unexpected: true
    })
  ),
  null,
  'new protocol shape must be strict'
)

console.log('Audio endpoint protocol verification passed')
