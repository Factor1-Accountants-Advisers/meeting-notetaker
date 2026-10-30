// Pure full-dev configuration and owned-process helpers. Never log config values.
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const allowed = new Set([
  'MN_ENTRA_CLIENT_ID', 'MN_ENTRA_TENANT_ID', 'MN_STORAGE_API_URL', 'MN_STORAGE_API_SCOPE', 'MN_STORAGE_API_ENABLED',
  'MN_OPENAI_API_KEY', 'MN_OPENAI_ENDPOINT', 'MN_OPENAI_DEPLOYMENT',
  'MN_PYANNOTE_API_KEY', 'MN_PYANNOTE_API_ENDPOINT', 'MN_PYANNOTE_MODEL_VERSION',
  'MN_PYANNOTE_TRANSCRIPTION_MODEL', 'MN_PYANNOTE_TRANSCRIPTION_LANGUAGE', 'MN_PYANNOTE_NUM_SPEAKERS',
  'MN_PYANNOTE_POLL_INTERVAL_SECONDS', 'MN_PYANNOTE_POLL_TIMEOUT_SECONDS',
  'MN_SHAREPOINT_DRIVE_ID', 'MN_SHAREPOINT_FOLDER_PATH', 'MN_CONTEXT_DRIVE_ID', 'MN_CONTEXT_FILE_PATH',
  'MN_VOICEPRINT_EXPANSION_EMPLOYEE_IDS', 'MN_VOICEPRINT_EXPANSION_CAP', 'MN_VOICEPRINT_EXPANSION_MIN_CONFIDENCE',
  'MN_DELIVERY_RECIPIENTS', 'MN_DELIVERY_DOMAIN_ALLOWLIST', 'MN_AUTO_START_TRIGGER',
  'MN_AUDIO_RETENTION_DAYS', 'MN_SIMILARITY_THRESHOLD', 'MN_BLOB_ACCOUNT_URL', 'MN_KEY_VAULT_URL'
])
function parseEnv(text) {
  const result = {}
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index < 1) continue
    const key = line.slice(0, index).trim()
    if (!/^MN_[A-Z0-9_]+$/.test(key)) continue
    let value = line.slice(index + 1).trim()
    if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) value = value.slice(1, -1)
    result[key] = value
  }
  return result
}
function pick(config) {
  return Object.fromEntries(Object.entries(config).filter(([key]) => allowed.has(key)))
}
function loadConfig(files, inherited, defaults) {
  const config = { ...defaults, MN_STORAGE_API_ENABLED: 'true', ...pick(inherited) }
  for (const file of files) if (fs.existsSync(file)) Object.assign(config, pick(parseEnv(fs.readFileSync(file, 'utf8'))))
  return config
}
function requireLiveConfig(config) {
  if (!config.MN_PYANNOTE_API_KEY || !config.MN_OPENAI_API_KEY) throw new Error('Real speech and summary provider configuration is required. Reuse the installed app configuration or an ignored private dev.env; never paste keys into chat.')
  if (!config.MN_STORAGE_API_URL || !config.MN_STORAGE_API_SCOPE || String(config.MN_STORAGE_API_ENABLED).toLowerCase() !== 'true') throw new Error('Central Storage API must be configured and enabled for the full-function trial.')
}
function configPaths(root, env) {
  const programs = path.join(env.LOCALAPPDATA, 'Programs')
  const installed = [
    path.join(programs, 'meeting-notetaker', 'resources', 'backend', 'backend.env'),
    path.join(programs, 'meeting-notetaker-desktop', 'resources', 'backend', 'backend.env'),
    path.join(env.ProgramFiles || env.PROGRAMFILES || 'C:/Program Files', 'meeting-notetaker', 'resources', 'backend', 'backend.env')
  ].find(file => fs.existsSync(file))
  return [
    ...(installed ? [installed] : []),
    path.join(root, 'backend.env'), path.join(root, 'backend', '.env'), path.join(root, 'backend', 'dev.env'),
    path.join(env.PROGRAMDATA || 'C:/ProgramData', 'Factor1', 'MeetingNotetaker', 'backend.env')
  ]
}
function backendEnvironment(inherited, config, options) {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535 || options.port === 8787) throw new Error('Full-dev backend must not use production port 8787')
  const result = Object.fromEntries(Object.entries(inherited).filter(([key]) => !key.startsWith('MN_')))
  Object.assign(result, pick(config), {
    MN_DATA_DIR: options.dataDir, MN_BACKEND_PORT: String(options.port), MN_BACKEND_HOST: '127.0.0.1',
    MN_APP_VERSION: options.version, MN_FFMPEG_PATH: options.ffmpeg,
    TEMP: options.tempDir, TMP: options.tempDir, TMPDIR: options.tempDir
  })
  return result
}
function probeHealth(url, timeoutMs = 1000) {
  return new Promise(resolve => {
    let done = false, request, timer
    const finish = value => { if (done) return; done = true; clearTimeout(timer); resolve(value) }
    timer = setTimeout(() => { finish(null); request?.destroy() }, timeoutMs)
    try {
      request = http.get(url, response => {
        if (response.statusCode !== 200) { finish(null); response.resume(); return }
        let body = ''
        response.on('data', chunk => { body += chunk; if (body.length > 65536) { finish(null); request.destroy() } })
        response.on('end', () => { try { finish(JSON.parse(body)) } catch { finish(null) } })
        response.on('error', () => finish(null))
      })
      request.on('error', () => finish(null))
    } catch { finish(null) }
  })
}
async function waitForHealthy(url, expectedVersion, dead, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !dead()) {
    const health = await probeHealth(url, Math.min(1000, deadline - Date.now()))
    if (health?.status === 'ok' && health.app_version === expectedVersion) return true
    if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.min(200, deadline - Date.now())))
  }
  return false
}
function createOwnedBackend(options) {
  let child = null, stopping = false, ready = false, restartTimer = null
  const failures = new WeakSet()
  let restartTimes = []
  const schedule = options.schedule || setTimeout
  const cancel = options.cancel || clearTimeout
  const fatal = error => { if (!stopping) options.onFatal(error) }
  const restart = () => {
    if (stopping || restartTimer) return
    const now = Date.now()
    restartTimes = restartTimes.filter(t => now - t < 5 * 60_000)
    if (restartTimes.length >= (options.maxRestarts ?? 3)) { fatal(new Error('Dev backend restart limit reached; inspect the private backend log.')); return }
    restartTimes.push(now)
    restartTimer = schedule(async () => {
      restartTimer = null
      if (stopping) return
      try { await start() } catch (error) { if (!stopping) { ready = false; restart() } }
    }, [1000, 5000, 25000][Math.min(restartTimes.length - 1, 2)])
  }
  const start = async () => {
    if (stopping) throw new Error('Dev backend is shutting down')
    ready = false
    const owned = options.spawn()
    child = owned
    owned.on('error', () => { failures.add(owned); if (ready && child === owned) restart() })
    owned.on('exit', () => { if (child === owned && ready && !stopping) { ready = false; restart() } })
    const success = await options.waitReady(owned, () => stopping || failures.has(owned) || owned.exitCode !== null)
    if (!success || stopping || failures.has(owned) || owned.exitCode !== null) {
      if (owned.pid && owned.exitCode === null) options.kill(owned.pid)
      throw new Error('Owned dev backend did not become healthy')
    }
    ready = true
  }
  const stop = () => {
    stopping = true; ready = false
    if (restartTimer) cancel(restartTimer)
    restartTimer = null
    const owned = child
    child = null
    if (owned?.pid && owned.exitCode === null) options.kill(owned.pid)
  }
  const retry = async () => {
    if (stopping) throw new Error('Dev backend is shutting down')
    if (restartTimer) cancel(restartTimer)
    restartTimer = null
    restartTimes = []
    await start()
  }
  return { start, stop, retry, getChild: () => child }
}
module.exports = { parseEnv, loadConfig, requireLiveConfig, configPaths, backendEnvironment, probeHealth, waitForHealthy, createOwnedBackend }
