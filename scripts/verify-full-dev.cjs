// Full-dev safety/config tests. All credentials and process handles are fixtures.
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const ts = require('typescript')
const vm = require('node:vm')
const runtime = require('./full-dev-runtime.cjs')

async function main() {
  const scratch = process.env.TMPDIR || process.env.RUNNER_TEMP || os.tmpdir()
  const directory = fs.mkdtempSync(path.join(scratch, 'notetaker-dev-config-test-'))
  const base = { MN_OPENAI_API_KEY: 'fixture-summary', MN_PYANNOTE_API_KEY: 'fixture-speech' }
  const defaults = require('../src/shared/public-app-config.json')
  const checks = []
  assert.deepEqual(runtime.parseEnv('\uFEFFMN_OPENAI_API_KEY="fixture-summary"\r\n# ignored\r\nMN_PYANNOTE_API_KEY=\'fixture-speech\'\nBAD KEY=no\n'), base)
  checks.push('BOM/CRLF/quotes parsed without executing config')
  const source = path.join(directory, 'provider.env')
  fs.writeFileSync(source, 'MN_OPENAI_API_KEY=fixture-summary\nMN_PYANNOTE_API_KEY=fixture-speech\nMN_DELIVERY_RECIPIENTS=ask\nMN_DATA_DIR=C:/production\nMN_BACKEND_PORT=8787\n')
  const override = path.join(directory, 'override.env')
  fs.writeFileSync(override, 'MN_OPENAI_API_KEY=fixture-rotated\nMN_AUTO_START_TRIGGER=join\n')
  const config = runtime.loadConfig([source, override], { MN_OPENAI_API_KEY: 'fixture-inherited' }, defaults)
  assert.equal(config.MN_OPENAI_API_KEY, 'fixture-rotated')
  assert.equal(config.MN_DELIVERY_RECIPIENTS, 'ask')
  assert.equal(config.MN_STORAGE_API_URL, defaults.MN_STORAGE_API_URL)
  assert.equal(config.MN_DATA_DIR, undefined)
  assert.equal(config.MN_BACKEND_PORT, undefined)
  runtime.requireLiveConfig(config)
  assert.throws(() => runtime.requireLiveConfig({}), /provider/i)
  assert.throws(() => runtime.requireLiveConfig({ ...config, MN_STORAGE_API_ENABLED: 'false' }), /storage/i)
  checks.push('approved configuration precedence, private paths excluded, no silent provider/storage stubs')
  const installedRoot = path.join(directory, 'installed')
  const installedPrimary = path.join(installedRoot, 'Programs', 'meeting-notetaker', 'resources', 'backend', 'backend.env')
  const installedLegacy = path.join(installedRoot, 'Programs', 'meeting-notetaker-desktop', 'resources', 'backend', 'backend.env')
  for (const file of [installedPrimary, installedLegacy]) fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(installedPrimary, 'MN_OPENAI_API_KEY=fixture-current\n')
  fs.writeFileSync(installedLegacy, 'MN_OPENAI_API_KEY=fixture-stale\n')
  const sources = runtime.configPaths(directory, { LOCALAPPDATA: installedRoot, PROGRAMDATA: path.join(directory, 'program-data'), ProgramFiles: path.join(directory, 'program-files') })
  assert.ok(sources.includes(installedPrimary))
  assert.ok(!sources.includes(installedLegacy), 'an old install must not overwrite the active install configuration')
  checks.push('only the first installed configuration is selected; legacy remnants cannot overwrite it')
  const profile = path.join(directory, 'private-profile')
  const env = runtime.backendEnvironment({ ...process.env, MN_DATA_DIR: 'C:/production', MN_BACKEND_PORT: '8787', MN_UNKNOWN: 'ignored' }, config,
    { dataDir: path.join(profile, 'backend-data'), tempDir: path.join(profile, 'temp'), port: 49123, version: 'fixture-version', ffmpeg: 'fixture-ffmpeg.exe' })
  assert.equal(env.MN_DATA_DIR, path.join(profile, 'backend-data'))
  assert.equal(env.MN_BACKEND_PORT, '49123')
  assert.equal(env.MN_BACKEND_HOST, '127.0.0.1')
  assert.equal(env.MN_UNKNOWN, undefined)
  assert.equal(env.MN_OPENAI_API_KEY, 'fixture-rotated')
  assert.equal(env.MN_DELIVERY_RECIPIENTS, 'ask')
  assert.throws(() => runtime.backendEnvironment({}, config, { dataDir: profile, tempDir: profile, port: 8787, version: 'fixture', ffmpeg: 'fixture' }), /8787/)
  checks.push('full backend uses real provider config and normal sharing on an owned non-production port/data/temp')

  const sourceCode = fs.readFileSync('src/main/toast-xml.ts', 'utf8')
  const compiled = ts.transpileModule(sourceCode, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const exports = {}
  vm.runInNewContext(compiled, { exports, process: { env: { MN_DEV_INSTANCE: '1' } } })
  assert.equal(exports.TOAST_PROTOCOL_SCHEME, 'notetaker-dev')
  assert.ok(exports.toastUri('open').startsWith('notetaker-dev://'))
  checks.push('full-dev toasts never activate production')

  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok', app_version: 'fixture-owner' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = 'http://127.0.0.1:' + server.address().port + '/health'
    assert.equal((await runtime.probeHealth(url, 1000)).app_version, 'fixture-owner')
    assert.equal(await runtime.waitForHealthy(url, 'foreign-version', () => false, 40), false)
    assert.equal(await runtime.waitForHealthy(url, 'fixture-owner', () => false, 1000), true)
  } finally { await new Promise(resolve => server.close(resolve)) }
  checks.push('readiness requires the exact owned backend version')
  const hung = http.createServer(() => {})
  await new Promise(resolve => hung.listen(0, '127.0.0.1', resolve))
  try {
    const started = Date.now()
    assert.equal(await runtime.probeHealth('http://127.0.0.1:' + hung.address().port + '/health', 40), null)
    assert.ok(Date.now() - started < 1500)
  } finally { hung.closeAllConnections(); await new Promise(resolve => hung.close(resolve)) }
  checks.push('health probes have a real wall-clock deadline')

  const killed = [], spawned = [], callbacks = []
  const controller = runtime.createOwnedBackend({
    spawn: () => { const child = new EventEmitter(); child.pid = 12345 + spawned.length; child.exitCode = null; spawned.push(child); return child },
    kill: pid => killed.push(pid), waitReady: async () => true,
    schedule: callback => { callbacks.push(callback); return callback }, cancel: () => {},
    onFatal: () => { throw new Error('unexpected fatal') }, maxRestarts: 2
  })
  const unloaded = runtime.createOwnedBackend({
    spawn: () => { throw new Error('must not spawn') }, kill: pid => killed.push(pid),
    waitReady: async () => true, onFatal: () => { throw new Error('unexpected fatal') }
  })
  unloaded.stop()
  assert.deepEqual(killed, [])
  await controller.start()
  spawned[0].exitCode = 1; spawned[0].emit('exit', 1)
  assert.equal(callbacks.length, 1)
  await callbacks.shift()()
  assert.equal(spawned.length, 2)
  controller.stop()
  controller.stop()
  assert.deepEqual(killed, [12346], 'before-quit and process-exit cleanup must be idempotent')
  spawned[1].emit('exit', 0)
  assert.equal(callbacks.length, 0)
  checks.push('unexpected owned-backend exit recovers; quit kills only the current owned child')
  const limitedChildren = [], limitedCallbacks = [], fatals = []
  const limited = runtime.createOwnedBackend({
    spawn: () => { const child = new EventEmitter(); child.pid = 20000 + limitedChildren.length; child.exitCode = null; limitedChildren.push(child); return child },
    kill: () => {}, waitReady: async () => true,
    schedule: callback => { limitedCallbacks.push(callback); return callback }, cancel: () => {},
    onFatal: error => fatals.push(error), maxRestarts: 1
  })
  await limited.start()
  limitedChildren[0].exitCode = 1; limitedChildren[0].emit('exit', 1)
  await limitedCallbacks.shift()()
  limitedChildren[1].exitCode = 1; limitedChildren[1].emit('exit', 1)
  assert.equal(fatals.length, 1)
  assert.equal(limitedCallbacks.length, 0)
  await limited.retry()
  assert.equal(limitedChildren.length, 3, 'an explicit retry can reset the bounded restart budget')
  limited.stop()
  checks.push('restart exhaustion reports failure and explicit retry restores service')
  const launcher = fs.readFileSync('dev-notetaker.cjs', 'utf8')
  assert.match(launcher, /app\.setPath\('userData', profile\)/)
  assert.match(launcher, /requestSingleInstanceLock/)
  assert.match(launcher, /requireLiveConfig/)
  assert.match(launcher, /notetaker-dev/)
  assert.match(launcher, /run-full-dev-backend\.py/)
  assert.match(launcher, /showBackendFailure/)
  checks.push('full launcher wires kernel-owned crash cleanup and explicit backend retry')
  assert.doesNotMatch(launcher, /fd97-isolated-backend|fd97-live-backend|MN_FD97_ISOLATED_TEST\s*=\s*['"]1/)
  checks.push('full launcher isolates the profile but uses the normal backend, not a restricted test relay')
  const result = { mode: 'synthetic-full-dev-regressions', total: checks.length, checks }
  console.log(JSON.stringify(result, null, 2))
  fs.rmSync(directory, { recursive: true, force: true })
}
main().catch(error => { console.error(error); process.exitCode = 1 })
