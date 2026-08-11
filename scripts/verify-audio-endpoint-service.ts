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

const stopChild = new FakeChild()
const stopService = new AudioEndpointService({
  helperPath: 'C:\\test\\notetaker-audio-endpoints.exe',
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

console.log('audio endpoint service verification passed')
