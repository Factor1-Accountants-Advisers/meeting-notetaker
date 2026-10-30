// Full-function local Windows build. No installer, production port or updater changes.
const { app, BrowserWindow, dialog } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')
const { spawn, execFileSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const runtime = require('./scripts/full-dev-runtime.cjs')
const defaults = require('./src/shared/public-app-config.json')
const root = __dirname
const smoke = process.argv.includes('--dev-smoke')
if (process.platform !== 'win32') throw new Error('Live Teams recording requires native Windows')
if (smoke && !process.env.MN_DEV_SMOKE_DIR) throw new Error('Provide a marked private smoke directory')
const profile = smoke ? path.resolve(process.env.MN_DEV_SMOKE_DIR) : path.join(process.env.LOCALAPPDATA, 'MeetingNotetaker-Dev')
if (smoke && !fs.existsSync(path.join(profile, 'MN_DEV_SMOKE.json'))) throw new Error('Smoke directory marker is missing')
for (const folder of ['session', 'backend-data', 'logs', 'crashes', 'temp']) fs.mkdirSync(path.join(profile, folder), { recursive: true })
app.setName('Meeting Notetaker Dev')
app.setPath('userData', profile)
app.setPath('sessionData', path.join(profile, 'session'))
app.setPath('crashDumps', path.join(profile, 'crashes'))
app.setAppLogsPath(path.join(profile, 'logs'))
const scheme = 'notetaker-dev'
let backend, smokeTimer
const stop = () => { clearTimeout(smokeTimer); backend?.stop() }
app.on('before-quit', stop)
process.once('exit', stop)
app.on('browser-window-created', (_event, window) => {
  window.on('page-title-updated', event => event.preventDefault())
  window.setTitle('Meeting Notetaker Dev')
  if (smoke) window.webContents.once('did-finish-load', async () => {
    try {
      let text = ''
      for (let i = 0; i < 50; i++) {
        text = await window.webContents.executeJavaScript('document.body.innerText')
        if (/sign in/i.test(text)) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (!/sign in/i.test(text)) throw new Error('Fresh full-dev profile did not render sign-in')
      // Synthetic input through the normal backend proves this is not the
      // capture-only relay. No Graph token or real provider credential is used.
      const request = async (method, route, body) => {
        const response = await fetch(process.env.MN_API_BASE + route, {
          method, headers: { 'Content-Type': 'application/json', 'X-MN-User': 'SYNTHETIC full-dev fixture' },
          body: body === undefined ? undefined : JSON.stringify(body)
        })
        if (!response.ok) throw new Error('Full-dev smoke endpoint failed: ' + route + ' HTTP ' + response.status)
        return response.json()
      }
      const fixture = await request('POST', '/api/v1/meetings', { title: 'SYNTHETIC full-dev processing smoke', source: 'in_person' })
      const audio = fs.readFileSync(path.join(root, 'scripts/fixtures/smoke-silent.webm')).toString('base64')
      await request('POST', '/api/v1/meetings/' + fixture.id + '/audio', { audio_b64: audio, mime_type: 'audio/webm', system_audio_b64: audio, system_mime_type: 'audio/webm', duration_seconds: 1 })
      let processed
      for (let i = 0; i < 50; i++) {
        processed = await request('GET', '/api/v1/meetings/' + fixture.id)
        if (processed.pipeline_status === 'ready' || processed.pipeline_status === 'failed') break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (processed.pipeline_status !== 'ready' || processed.delivery_status !== 'not_started') throw new Error('Synthetic full-dev processing did not finish safely')
      const result = { mode: 'full-dev-startup-smoke', freshSignInRendered: true, profile,
        privateApiBase: process.env.MN_API_BASE, fullBackend: true, syntheticPipelineReady: true,
        syntheticDualTrackUpload: true, liveProvidersInvoked: false, deliveryInvoked: false,
        protocolRegistered: false, packaged: app.isPackaged, windows: BrowserWindow.getAllWindows().length }
      fs.writeFileSync(path.join(profile, 'smoke-result.json'), JSON.stringify(result, null, 2))
      app.quit()
    } catch (error) { console.error(error.message); stop(); app.exit(1) }
  })
})
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)) })
  })
}
function killOwned(pid) {
  // A current ChildProcess handle supplies this PID; never sweep an image or 8787.
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }) } catch { /* owned process may have exited */ }
}
function installedAppRunning() {
  const command = '@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "Meeting Notetaker.exe" -or $_.Name -eq "Meeting Notetaker Desktop.exe" }).Count'
  return Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim()) > 0
}
async function start() {
  if (!app.requestSingleInstanceLock()) { app.quit(); return }
  if (!smoke && installedAppRunning()) throw new Error('Quit the installed Notetaker using its tray menu before starting this dev version. Do not uninstall it.')
  const python = process.env.MN_DEV_PYTHON || path.join(root, 'backend', '.venv', 'Scripts', 'python.exe')
  const ffmpeg = path.join(root, 'backend', 'third_party', 'ffmpeg', 'ffmpeg.exe')
  const main = path.join(root, 'out', 'main', 'index.js')
  for (const file of [python, ffmpeg, main, path.join(root, 'native/audio-endpoint-monitor/target/release/notetaker-audio-endpoints.exe')]) {
    if (!fs.existsSync(file)) throw new Error('Dev build prerequisite is missing. Run scripts/setup-full-dev.ps1 first: ' + file)
  }
  const config = smoke ? {} : runtime.loadConfig(runtime.configPaths(root, process.env), process.env, defaults)
  if (!smoke) runtime.requireLiveConfig(config)
  const port = await freePort()
  const version = 'dev-' + require('./package.json').version + '-' + crypto.randomUUID()
  const env = runtime.backendEnvironment(process.env, config, {
    dataDir: path.join(profile, 'backend-data'), tempDir: path.join(profile, 'temp'), port, version, ffmpeg
  })
  if (smoke) Object.assign(env, { MN_OPENAI_API_KEY: '', MN_OPENAI_ENDPOINT: '', MN_OPENAI_DEPLOYMENT: '', MN_PYANNOTE_API_KEY: '', MN_STORAGE_API_URL: '', MN_STORAGE_API_SCOPE: '', MN_STORAGE_API_ENABLED: 'false', MN_SHAREPOINT_DRIVE_ID: '', MN_CONTEXT_DRIVE_ID: '', MN_CONTEXT_FILE_PATH: '' })
  Object.assign(process.env, env, defaults, config, {
    MN_DEV_INSTANCE: '1', MN_API_BASE: 'http://127.0.0.1:' + port, MN_TEAMS_CALL_PROMPT_ENABLED: 'true'
  })
  delete process.env.MN_FD97_ISOLATED_TEST
  delete process.env.MN_FD97_LIVE_PROCESSING
  const logPath = path.join(profile, 'logs', 'dev-backend.log')
  const log = fs.openSync(logPath, 'a')
  function showBackendFailure(error) {
    if (smoke) { console.error(error.message); stop(); app.exit(1); return }
    const response = dialog.showMessageBoxSync({ type: 'error', title: 'Meeting Notetaker Dev',
      message: 'The local backend is unavailable.', detail: error.message + '\nPrivate log: ' + logPath,
      buttons: ['Retry backend', 'Quit'], defaultId: 0, cancelId: 1 })
    if (response === 0) backend.retry().catch(showBackendFailure)
    else app.quit()
  }
  backend = runtime.createOwnedBackend({
    spawn: () => {
      const child = spawn(python, [path.join(root, 'scripts', 'run-full-dev-backend.py'),
        '--parent-pid', String(process.pid), '--parent-exe', process.execPath,
        '--backend', path.join(root, 'backend', 'run_backend.py')], {
        cwd: profile, env: { ...env, PYTHONPATH: path.join(root, 'backend') }, windowsHide: true,
        stdio: ['ignore', log, log]
      })
      child.once('spawn', () => fs.writeFileSync(path.join(profile, 'dev-runtime.json'), JSON.stringify({
        pid: child.pid, apiBase: process.env.MN_API_BASE, root, profile, fullFunction: !smoke,
        providerConfigurationPresent: !smoke, configuredNotCredentialValidity: true
      }, null, 2)))
      return child
    },
    kill: killOwned,
    waitReady: (_child, dead) => runtime.waitForHealthy(process.env.MN_API_BASE + '/health', version, dead),
    onFatal: showBackendFailure
  })
  await backend.start()
  if (!smoke) {
    if (!app.setAsDefaultProtocolClient(scheme, process.execPath, [path.resolve(__filename)]) ||
        !app.isDefaultProtocolClient(scheme, process.execPath, [path.resolve(__filename)])) throw new Error('Private dev toast handler registration failed; production handler was not changed')
  }
  if (smoke) smokeTimer = setTimeout(() => { console.error('Full-dev startup smoke timed out'); stop(); app.exit(1) }, 30000)
  await import(pathToFileURL(main).href)
}
start().catch(error => { stop(); if (!smoke) dialog.showErrorBox('Meeting Notetaker Dev', error.message); console.error(error.message); app.exit(1) })
