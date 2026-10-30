import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import {
  AudioEndpointService,
  resolveAudioEndpointHelperPath,
  type AudioEndpointChild
} from '../src/main/audio-endpoint-service'

class FakeChild extends EventEmitter implements AudioEndpointChild {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false

  kill(): boolean {
    this.killed = true
    return true
  }
}

const firstSnapshot = JSON.stringify({
  schemaVersion: 1,
  kind: 'snapshot',
  generation: 1,
  endpoints: {
    captureConsole: { id: 'capture-console', label: 'Laptop microphone' },
    captureCommunications: { id: 'capture-comms', label: 'Bluetooth headset' },
    renderConsole: { id: 'render-console', label: 'Laptop speakers' },
    renderCommunications: { id: 'render-comms', label: 'Bluetooth headset' }
  }
})

const secondSnapshot = JSON.stringify({
  schemaVersion: 1,
  kind: 'snapshot',
  generation: 2,
  endpoints: {
    captureConsole: { id: 'capture-comms', label: 'Bluetooth headset' },
    captureCommunications: { id: 'capture-comms', label: 'Bluetooth headset' },
    renderConsole: { id: 'render-comms', label: 'Bluetooth headset' },
    renderCommunications: { id: 'render-comms', label: 'Bluetooth headset' }
  }
})

const children: FakeChild[] = []
const restartCallbacks: Array<() => void> = []
const snapshots: number[] = []
const warnings: string[] = []

const service = new AudioEndpointService({
  helperPath: 'C:\\test\\notetaker-audio-endpoints.exe',
  existsFn: () => true,
  spawnHelper: () => {
    const child = new FakeChild()
    children.push(child)
    return child
  },
  scheduleRestart: (callback) => {
    restartCallbacks.push(callback)
    return callback
  },
  cancelRestart: () => undefined,
  onSnapshot: (snapshot) => snapshots.push(snapshot.generation),
  log: {
    info: () => undefined,
    warn: (message) => warnings.push(message),
    error: () => undefined
  }
})

service.start()
assert.equal(children.length, 1, 'start should spawn the observer')
assert.equal(service.getSnapshot(), null, 'no snapshot should exist before stdout data')

children[0].stdout.write(`${firstSnapshot.slice(0, 40)}`)
children[0].stdout.write(`${firstSnapshot.slice(40)}\n{malformed-json}\n`)
assert.equal(service.getSnapshot()?.generation, 1, 'chunked JSONL should be reassembled')
assert.deepEqual(snapshots, [1], 'the first valid snapshot should be broadcast')
assert.equal(warnings.length, 1, 'malformed helper output should be ignored and logged')

children[0].stdout.write(`${firstSnapshot}\n${secondSnapshot}\n`)
assert.equal(service.getSnapshot()?.generation, 2, 'newer generations should replace the cache')
assert.deepEqual(snapshots, [1, 2], 'duplicate generations should not be rebroadcast')

children[0].emit('exit', 1, null)
assert.equal(restartCallbacks.length, 1, 'an unexpected exit should schedule one restart')
restartCallbacks.shift()?.()
assert.equal(children.length, 2, 'the scheduled restart should spawn a replacement observer')
children[1].stdout.write(`${firstSnapshot}\n`)
assert.equal(
  service.getSnapshot()?.generation,
  3,
  'a replacement observer generation should be rebased onto the service stream'
)
assert.deepEqual(snapshots, [1, 2, 3], 'changed endpoints after restart should be broadcast')

children[1].emit('exit', 1, null)
assert.equal(restartCallbacks.length, 0, 'a second unexpected exit should degrade without a loop')

service.stop()

const teamsChildren: FakeChild[] = []
const teamsArgs: Array<readonly string[] | undefined> = []
const teamsObservations: Array<{ generation: number; active: boolean | null; titles: string[] }> = []
let teamsUnavailable = 0
const teamsRestartCallbacks: Array<() => void> = []
const teamsService = new AudioEndpointService({
  helperPath: 'C:\\test\\notetaker-audio-endpoints.exe',
  existsFn: () => true,
  observeTeams: () => true,
  spawnHelper: (_path, args) => {
    teamsArgs.push(args)
    const child = new FakeChild()
    teamsChildren.push(child)
    return child
  },
  scheduleRestart: (callback) => {
    teamsRestartCallbacks.push(callback)
    return callback
  },
  cancelRestart: () => undefined,
  onSnapshot: () => {
    throw new Error('Teams heartbeat must not enter the endpoint snapshot stream')
  },
  onTeamsCall: (observation) =>
    teamsObservations.push({
      generation: observation.generation,
      active: observation.active,
      titles: observation.windowTitles
    }),
  onTeamsUnavailable: () => {
    teamsUnavailable += 1
  },
  log: {
    info: () => undefined,
    warn: (message) => warnings.push(message),
    error: () => undefined
  }
})

teamsService.start()
assert.deepEqual(teamsArgs[0], ['--observe-teams'], 'the opt-in flag should be passed to the helper')
teamsChildren[0].stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    kind: 'teams-call',
    generation: 1,
    active: true,
    preJoin: false,
    windowTitles: ['Sensitive caller title']
  })}\n`
)
teamsChildren[0].stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    kind: 'teams-call',
    generation: 2,
    active: true,
    preJoin: false,
    windowTitles: ['Sensitive caller title']
  })}\n`
)
assert.deepEqual(
  teamsObservations.map(({ generation }) => generation),
  [1, 2],
  'every newer heartbeat should be forwarded even when state is unchanged'
)
teamsChildren[0].stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    kind: 'teams-call',
    generation: 3,
    active: false,
    preJoin: false,
    windowTitles: ['PII must not be logged']
  })}\n`
)
assert.equal(teamsObservations.at(-1)?.active, false)
teamsChildren[0].stdout.write('{"schemaVersion":1,"kind":"teams-call","generation":4,"active":"false"}\n')
assert.equal(teamsUnavailable, 1, 'malformed heartbeat immediately invalidates call evidence')
assert.equal(
  warnings.some((message) => message.includes('PII must not be logged')),
  false,
  'malformed Teams output must not log titles'
)
teamsChildren[0].emit('exit', 1, null)
assert.equal(teamsUnavailable, 1, 'unexpected exit should invalidate Teams observation')
teamsRestartCallbacks.shift()?.()
assert.deepEqual(teamsArgs[1], ['--observe-teams'])
teamsChildren[1].stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    kind: 'teams-call',
    generation: 1,
    active: null,
    preJoin: false,
    windowTitles: []
  })}\n`
)
assert.equal(teamsObservations.at(-1)?.generation, 1, 'Teams generation must reset after restart')
teamsChildren[1].stdout.write('X'.repeat(65 * 1024))
assert.equal(teamsUnavailable, 2, 'oversized output immediately invalidates call evidence')
teamsService.stop()
assert.equal(teamsUnavailable, 2, 'stop should invalidate the current Teams observation')

const disabledArgs: Array<readonly string[] | undefined> = []
const disabledService = new AudioEndpointService({
  helperPath: 'C:\\test\\notetaker-audio-endpoints.exe',
  existsFn: () => true,
  observeTeams: () => false,
  spawnHelper: (_path, args) => {
    disabledArgs.push(args)
    return new FakeChild()
  },
  log: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  }
})
disabledService.start()
assert.deepEqual(disabledArgs[0], [], 'the helper must retain its old invocation when disabled')
disabledService.stop()

const stopChild = new FakeChild()
const stopService = new AudioEndpointService({
  helperPath: 'C:\\test\\notetaker-audio-endpoints.exe',
  existsFn: () => true,
  spawnHelper: () => stopChild,
  log: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  }
})
stopService.start()
stopService.stop()
assert.equal(stopChild.killed, true, 'stop should terminate an active observer')

assert.equal(
  resolveAudioEndpointHelperPath({
    isPackaged: true,
    resourcesPath: 'C:\\Program Files\\Meeting Notetaker\\resources',
    appPath: 'C:\\unused'
  }),
  'C:\\Program Files\\Meeting Notetaker\\resources\\audio\\notetaker-audio-endpoints.exe'
)

// Missing helper binary (dev before cargo build, or a broken install):
// warn once, never spawn, never schedule a restart.
{
  const missingWarnings: string[] = []
  const missingService = new AudioEndpointService({
    helperPath: 'Z:\\nonexistent\\notetaker-audio-endpoints.exe',
    existsFn: () => false,
    spawnHelper: () => {
      throw new Error('spawnHelper must not be called for a missing helper')
    },
    onSnapshot: () => undefined,
    log: {
      info: () => undefined,
      warn: (message) => missingWarnings.push(message),
      error: (message) => missingWarnings.push(message)
    }
  })
  missingService.start()
  assert.equal(missingWarnings.length, 1, 'exactly one warning for a missing helper')
  assert.match(missingWarnings[0], /helper binary not found/)
  missingService.stop()
}

console.log('audio endpoint service verification passed')
