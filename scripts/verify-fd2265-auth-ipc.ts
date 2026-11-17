// FD-2265 integration checks, run inside Electron (needs `npm run build` first).
//
// Part 1 — main process: the REAL auth-session / auth-msal / token-cache code
// with REAL safeStorage, in a throwaway profile. Proves the audit display name
// never counts as a sign-in, an empty actor no longer deletes the token cache,
// Sign out still does, and an undecryptable cache still fails closed.
//
// Part 2 — renderer: the REAL built renderer + preload with fixture IPC (same
// pattern as verify-fd97-renderer-handoff). Proves startup/auth IPC ordering,
// stale mn.user → login, lost sign-in → "Sign in again" → recovery without
// re-enrolment, signed-in central outage wording, and genuine absence.
//
// No real Microsoft sign-in, backend, provider, voiceprint or installed data:
// userData/sessionData point at a fresh temp directory.
import { app, BrowserWindow, ipcMain, safeStorage, session } from 'electron'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  getStorageApiAccessToken,
  registerAuthSessionIpc,
  runInteractiveSignIn,
  verifyStorageAccess
} from '../src/main/auth-session'

// The app logger rebinds console.* to its log file; report on stdout directly.
const out = (line: string): void => void process.stdout.write(line + '\n')

const root = resolve(__dirname, '..')
if (!existsSync(join(root, 'out/renderer/index.html'))) {
  throw new Error('Built renderer missing: run `npm run build` first')
}
const profile = mkdtempSync(join(tmpdir(), 'fd2265-auth-ipc-'))
app.setPath('userData', profile)
app.setPath('sessionData', join(profile, 'session'))
app.setName('FD2265 synthetic auth check')
app.on('window-all-closed', () => {})

type Handler = (...args: unknown[]) => unknown
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await check()) return
    await wait(100)
  }
  throw new Error('Timed out: ' + label)
}

// ---------------------------------------------------------------------------
// Part 1: real main-process auth IPC
// ---------------------------------------------------------------------------
async function mainProcessChecks(checks: string[]): Promise<void> {
  const captured = new Map<string, Handler>()
  const realHandle = ipcMain.handle.bind(ipcMain)
  const realOn = ipcMain.on.bind(ipcMain)
  // Capture instead of registering, so Part 2's fixture handlers can own the channels.
  ;(ipcMain as unknown as { handle: unknown }).handle = (ch: string, fn: Handler) => void captured.set(ch, fn)
  ;(ipcMain as unknown as { on: unknown }).on = (ch: string, fn: Handler) => {
    captured.set(ch, fn)
    return ipcMain
  }
  try {
    registerAuthSessionIpc()
  } finally {
    ;(ipcMain as unknown as { handle: unknown }).handle = realHandle
    ;(ipcMain as unknown as { on: unknown }).on = realOn
  }
  const setUser = (name: string): unknown => captured.get('auth:set-user')!({}, name)
  const status = async (): Promise<{ signedIn: boolean }> =>
    (await captured.get('auth:status')!({})) as { signedIn: boolean }
  const signOut = async (): Promise<unknown> => captured.get('auth:sign-out')!({})

  assert.equal(safeStorage.isEncryptionAvailable(), true, 'DPAPI/safeStorage must be available for this check')
  const cacheDir = join(profile, 'auth')
  const cacheFile = join(cacheDir, 'msal-cache.bin')
  mkdirSync(cacheDir, { recursive: true })
  const writeHealthyCache = (): void =>
    writeFileSync(cacheFile, safeStorage.encryptString(JSON.stringify({ synthetic: 'fd2265' })))

  setUser('Ellen Example')
  assert.equal((await status()).signedIn, false, 'stale audit actor + no cache must read as signed out')
  checks.push('main: a renderer-pushed display name alone is not a sign-in')

  writeHealthyCache()
  assert.equal((await status()).signedIn, true, 'decryptable cache on cold start is signed in')
  checks.push('main: decryptable cache on cold start is signed in')

  setUser('')
  assert.equal(existsSync(cacheFile), true, 'an empty audit actor must not delete the token cache')
  assert.equal((await status()).signedIn, true, 'cache survives the empty actor')
  checks.push('main: auth:set-user("") leaves the encrypted token cache in place')

  await signOut()
  assert.equal(existsSync(cacheFile), false, 'explicit sign-out still clears the cache')
  assert.equal((await status()).signedIn, false, 'signed out after sign-out')
  checks.push('main: auth:sign-out still clears the cache')

  writeFileSync(cacheFile, Buffer.from('not encrypted'))
  assert.equal((await status()).signedIn, false, 'undecryptable cache is signed out (Ellen, 2 Nov)')
  assert.equal(existsSync(cacheFile), false, 'undecryptable cache is still discarded (fail closed)')
  checks.push('main: undecryptable cache still fails closed and reads as signed out')

  // Real chain (review finding): Storage silent token → no_cached_account →
  // auth:status false, even though a decryptable cache file is present. Fake
  // client/tenant IDs + an MSAL cache with no accounts reach no_cached_account
  // before any network call (auth-msal returns before acquireTokenSilent).
  const savedEnv = {
    id: process.env.MN_ENTRA_CLIENT_ID,
    tenant: process.env.MN_ENTRA_TENANT_ID,
    scope: process.env.MN_STORAGE_API_SCOPE,
    enabled: process.env.MN_STORAGE_API_ENABLED
  }
  process.env.MN_ENTRA_CLIENT_ID = '00000000-0000-4000-8000-000000000001'
  process.env.MN_ENTRA_TENANT_ID = '00000000-0000-4000-8000-000000000002'
  try {
    const emptyMsalCache = JSON.stringify({ Account: {}, IdToken: {}, AccessToken: {}, RefreshToken: {}, AppMetadata: {} })
    writeFileSync(cacheFile, safeStorage.encryptString(emptyMsalCache))
    assert.equal((await status()).signedIn, true, 'decryptable cache reads as signed in before any token attempt')
    const token = await getStorageApiAccessToken('api://00000000-0000-4000-8000-000000000003/access_as_user')
    assert.equal(token, null, 'no account in the cache → no Storage token')
    assert.equal(existsSync(cacheFile), true, 'precondition: the cache file is still present')
    assert.equal((await status()).signedIn, false, 'real Storage no_cached_account outcome makes auth:status signed out')
    checks.push('main: real Storage token attempt (no_cached_account) → auth:status signed out despite a cache file')

    await signOut()
    writeFileSync(cacheFile, safeStorage.encryptString(emptyMsalCache))
    assert.equal((await status()).signedIn, true, 'sign-out resets the recorded token failure')
    checks.push('main: auth:sign-out resets the recorded Storage token failure')

    // Review R-1 (b): the post-sign-in voiceprint-store check is real and honest.
    delete process.env.MN_STORAGE_API_SCOPE
    assert.equal(await verifyStorageAccess(), 'not-configured', 'no Storage scope → not configured (stub mode)')
    process.env.MN_STORAGE_API_SCOPE = 'api://00000000-0000-4000-8000-000000000003/access_as_user'
    process.env.MN_STORAGE_API_ENABLED = 'false'
    assert.equal(await verifyStorageAccess(), 'not-configured', 'Storage API disabled → not configured')
    delete process.env.MN_STORAGE_API_ENABLED
    assert.equal(await verifyStorageAccess(), 'failed', 'no usable account → the voiceprint store is still unreachable')
    checks.push('main: verifyStorageAccess reports not-configured / failed from the real token path')
    await signOut()

    // Review R-3 (c): sign-out always wins over an in-flight interactive sign-in.
    // The fake sign-ins stand in for the browser round trip and, like the real
    // one, persist the token cache when they complete.
    type Fake = { ok: boolean; name?: string; email?: string; oid?: string; error?: string }
    const okResult: Fake = { ok: true, name: 'Fixture Recorder', email: 'recorder@factor1.com.au', oid: 'oid-fixture' }
    const deferred = <T,>(): { promise: Promise<T>; resolve: (v: T) => void } => {
      let resolve!: (v: T) => void
      const promise = new Promise<T>((r) => (resolve = r))
      return { promise, resolve }
    }
    const timeout = <T,>(p: Promise<T>, ms: number): Promise<T | 'timeout'> =>
      Promise.race([p, wait(ms).then(() => 'timeout' as const)])

    // Normal path still succeeds.
    const normal = await runInteractiveSignIn({
      signIn: async () => {
        writeHealthyCache()
        return okResult
      },
      verify: async () => 'ok'
    })
    assert.equal(normal.ok, true, 'uninterrupted sign-in succeeds')
    assert.equal((await status()).signedIn, true, 'uninterrupted sign-in is signed in')
    await signOut()
    checks.push('main: uninterrupted interactive sign-in still succeeds')

    // Sign-out while the browser step is pending → returns at once, not after 2 min.
    const browser = deferred<Fake>()
    const pending = runInteractiveSignIn({ signIn: () => browser.promise, verify: async () => 'ok' })
    await wait(50)
    await signOut()
    const early = await timeout(pending, 2_000)
    assert.notEqual(early, 'timeout', 'sign-out releases a pending sign-in immediately')
    assert.equal((early as { ok: boolean }).ok, false, 'a sign-in interrupted by sign-out reports failure')
    // …and if the browser step completes afterwards, its saved session is undone.
    writeHealthyCache()
    browser.resolve(okResult)
    await wait(100)
    assert.equal(existsSync(cacheFile), false, 'late completion after sign-out: token cache removed again')
    assert.equal((await status()).signedIn, false, 'late completion after sign-out: still signed out')
    checks.push('main: sign-out cancels a pending sign-in at once and undoes a late completion')

    // Sign-out during the post-sign-in voiceprint-store check also wins.
    const verifyGate = deferred<'ok'>()
    const midVerify = runInteractiveSignIn({
      signIn: async () => {
        writeHealthyCache()
        return okResult
      },
      verify: () => verifyGate.promise
    })
    await wait(50)
    await signOut()
    writeHealthyCache() // the real Storage token call would re-persist the cache here
    verifyGate.resolve('ok')
    const mid = await timeout(midVerify, 2_000)
    assert.notEqual(mid, 'timeout', 'mid-verify sign-in resolves')
    assert.equal((mid as { ok: boolean }).ok, false, 'sign-out during the storage check wins')
    assert.equal(existsSync(cacheFile), false, 'sign-out during the storage check: cache removed')
    assert.equal((await status()).signedIn, false, 'sign-out during the storage check: signed out')
    checks.push('main: sign-out during the post-sign-in storage check wins')
  } finally {
    if (savedEnv.id === undefined) delete process.env.MN_ENTRA_CLIENT_ID
    else process.env.MN_ENTRA_CLIENT_ID = savedEnv.id
    if (savedEnv.tenant === undefined) delete process.env.MN_ENTRA_TENANT_ID
    else process.env.MN_ENTRA_TENANT_ID = savedEnv.tenant
    if (savedEnv.scope === undefined) delete process.env.MN_STORAGE_API_SCOPE
    else process.env.MN_STORAGE_API_SCOPE = savedEnv.scope
    if (savedEnv.enabled === undefined) delete process.env.MN_STORAGE_API_ENABLED
    else process.env.MN_STORAGE_API_ENABLED = savedEnv.enabled
  }
}

// ---------------------------------------------------------------------------
// Part 2: real built renderer + preload, fixture IPC
// ---------------------------------------------------------------------------
interface Ev {
  ch: string
  arg?: unknown
}
const events: Ev[] = []
const STORED = { name: 'Fixture Recorder', email: 'recorder@factor1.com.au' }
let authSignedIn = true
let signInResult: { ok: boolean; name?: string; email?: string; error?: string } = { ok: false }
let personEnrolled = true
let status = { enrolled_locally: true, centrally_enrolled: true, central_required: true, centrally_unknown: false }
let onStatusCall: (() => void) | null = null
// R8: the real proxy answers a timed-out backend call with 408 and no body.
let statusTimesOut = false

const UNKNOWN = { enrolled_locally: false, centrally_enrolled: false, central_required: true, centrally_unknown: true }
const ENROLLED = { enrolled_locally: true, centrally_enrolled: true, central_required: true, centrally_unknown: false }
const ABSENT = { enrolled_locally: false, centrally_enrolled: false, central_required: true, centrally_unknown: false }

function registerFixtureIpc(): void {
  const envelope = (body: unknown): unknown => ({ ok: true, status: 200, body })
  for (const ch of ['app:version', 'auth:storage-admin-status', 'recording:spill-list', 'recording:list-saved', 'audio-endpoints:get', 'startup:get-auto-launch', 'updates:check']) {
    ipcMain.handle(ch, () => {
      if (ch === 'auth:storage-admin-status') return { isAdmin: false }
      if (ch === 'app:version') return 'FD2265-SYNTHETIC'
      if (ch.includes('list')) return []
      return null
    })
  }
  ipcMain.handle('auth:status', () => {
    events.push({ ch: 'auth:status' })
    return authSignedIn ? { signedIn: true, email: STORED.email, name: STORED.name } : { signedIn: false }
  })
  ipcMain.on('auth:set-user', (_e, name: string) => void events.push({ ch: 'auth:set-user', arg: name }))
  ipcMain.handle('auth:sign-in', () => {
    events.push({ ch: 'auth:sign-in' })
    return signInResult
  })
  ipcMain.handle('auth:sign-out', () => {
    events.push({ ch: 'auth:sign-out' })
    return { ok: true }
  })
  ipcMain.handle('api:request', (_e, req: { method: string; path: string }) => {
    events.push({ ch: 'api', arg: `${req.method} ${req.path}` })
    if (req.path === '/api/v1/people/me/enrolment-status') {
      if (statusTimesOut) return { ok: false, status: 408, body: null }
      const snapshot = { ...status }
      onStatusCall?.()
      return envelope(snapshot)
    }
    if (req.path === '/api/v1/people/me') {
      return envelope({
        employee_id: STORED.email,
        display_name: STORED.name,
        role: 'Factor1 staff',
        enrolled: personEnrolled,
        model_version: null,
        reenrollment_required: false
      })
    }
    if (req.method !== 'GET') return { ok: false, status: 500, body: { detail: 'fixture: unexpected mutation' } }
    return envelope([])
  })
}

let partitionSeq = 0
async function openWithStoredUser(stored: typeof STORED | null): Promise<BrowserWindow> {
  const partition = `persist:fd2265-${++partitionSeq}`
  const ses = session.fromPartition(partition)
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith('file:') && !d.url.startsWith('data:') }))
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: join(root, 'out/preload/index.mjs'), contextIsolation: true, sandbox: false, partition }
  })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) out('Renderer: ' + message)
  })
  // First load only seeds localStorage for this partition's file:// origin.
  const seedAuth = authSignedIn
  authSignedIn = false
  await win.loadFile(join(root, 'out/renderer/index.html'))
  // Let the seed page finish its own (signed-out) startup so its late IPC
  // cannot leak into the measured run's event log.
  await until(() => events.some((e) => e.ch === 'auth:set-user'), 'seed page settled')
  await wait(200)
  await win.webContents.executeJavaScript(
    stored ? `localStorage.setItem('mn.user', ${JSON.stringify(JSON.stringify(stored))})` : `localStorage.removeItem('mn.user')`
  )
  authSignedIn = seedAuth
  events.length = 0
  win.reload()
  return win
}
const text = (win: BrowserWindow): Promise<string> => win.webContents.executeJavaScript('document.body.innerText')
const storedUser = (win: BrowserWindow): Promise<string | null> =>
  win.webContents.executeJavaScript("localStorage.getItem('mn.user')")
const apiCalls = (needle: string): Ev[] => events.filter((e) => e.ch === 'api' && String(e.arg).includes(needle))
const firstIndex = (pred: (e: Ev) => boolean): number => events.findIndex(pred)

async function rendererChecks(checks: string[]): Promise<void> {
  registerFixtureIpc()

  // R1 — Ellen's case: stale mn.user, main reports no usable sign-in.
  authSignedIn = false
  let win = await openWithStoredUser(STORED)
  await until(async () => (await text(win)).includes('Sign in with Microsoft'), 'R1 login screen')
  await wait(500)
  assert.ok(firstIndex((e) => e.ch === 'auth:status') >= 0, 'R1 auth status consulted')
  assert.deepEqual(
    events.filter((e) => e.ch === 'auth:set-user' && e.arg !== ''),
    [],
    'R1 stale display name is never pushed to main as the actor'
  )
  assert.deepEqual(apiCalls('/people/me'), [], 'R1 no gate request with a stale identity')
  assert.equal(await storedUser(win), null, 'R1 stale mn.user cleared')
  assert.doesNotMatch(await text(win), /Voiceprint required/, 'R1 no voiceprint wording')
  win.destroy()
  checks.push('renderer: stale mn.user + signed-out main → login screen; no actor push or gate request first')

  // R2 — healthy restart: auth check strictly precedes the actor push and gate.
  authSignedIn = true
  status = ENROLLED
  personEnrolled = true
  win = await openWithStoredUser(STORED)
  await until(async () => (await text(win)).includes('Start recording'), 'R2 home screen')
  const statusAt = firstIndex((e) => e.ch === 'auth:status')
  const setUserAt = firstIndex((e) => e.ch === 'auth:set-user')
  const gateAt = firstIndex((e) => e.ch === 'api' && String(e.arg).includes('/people/me'))
  assert.ok(statusAt >= 0 && setUserAt > statusAt, 'R2 auth:status precedes the first auth:set-user')
  assert.ok(gateAt > statusAt, 'R2 auth:status precedes the first gate request')
  assert.equal(events[setUserAt].arg, STORED.name, 'R2 first actor push is the real user, never ""')
  assert.equal(await storedUser(win) !== null, true, 'R2 healthy session keeps mn.user')
  win.destroy()
  checks.push('renderer: healthy restart → auth:status before any auth:set-user or gate request; session kept')

  // R3 — sign-in lost mid-session (token attempt records no_cached_account),
  // then real recovery through "Sign in again" with no re-enrolment.
  authSignedIn = true
  status = UNKNOWN
  onStatusCall = () => {
    authSignedIn = false
  }
  win = await openWithStoredUser(STORED)
  const started = Date.now()
  await until(async () => (await text(win)).includes('Sign in again'), 'R3 sign-in-required screen', 8_000)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 5_000, `R3 sign-in prompt without the ~50 s retry backoff (took ${elapsed} ms)`)
  const r3 = await text(win)
  assert.doesNotMatch(r3, /Voiceprint required/, 'R3 not labelled as a voiceprint problem')
  assert.doesNotMatch(r3, /Try again/, 'R3 offers no futile retry')
  onStatusCall = null
  signInResult = { ok: true, name: STORED.name, email: STORED.email }
  ipcMain.removeHandler('auth:sign-in')
  ipcMain.handle('auth:sign-in', () => {
    events.push({ ch: 'auth:sign-in' })
    authSignedIn = true
    status = ENROLLED
    return signInResult
  })
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('button')].find((b) => b.textContent === 'Sign in again').click()`
  )
  await until(async () => (await text(win)).includes('Start recording'), 'R3 recovered to home')
  assert.equal(events.filter((e) => e.ch === 'auth:sign-in').length, 1, 'R3 one interactive sign-in')
  assert.equal(events.filter((e) => e.ch === 'auth:sign-out').length, 0, 'R3 recovery needs no sign-out')
  assert.deepEqual(apiCalls('/enroll'), [], 'R3 recovery never re-enrols')
  win.destroy()
  checks.push('renderer: lost sign-in → "Sign in again" within 5 s → interactive sign-in → home, no re-enrolment')

  // R6 — review R-1 (b): sign-in succeeds but the voiceprint store still
  // refuses a token (e.g. a policy on that resource). Must explain, not loop.
  authSignedIn = true
  status = UNKNOWN
  onStatusCall = () => {
    authSignedIn = false
  }
  win = await openWithStoredUser(STORED)
  await until(async () => (await text(win)).includes('Sign in again'), 'R6 sign-in-required screen', 8_000)
  ipcMain.removeHandler('auth:sign-in')
  ipcMain.handle('auth:sign-in', () => {
    events.push({ ch: 'auth:sign-in' })
    return { ok: true, name: STORED.name, email: STORED.email, storageAccess: 'failed' }
  })
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('button')].find((b) => b.textContent === 'Sign in again').click()`
  )
  await until(async () => /voiceprint service/i.test(await text(win)), 'R6 specific error after sign-in', 8_000)
  await wait(1_500)
  const r6 = await text(win)
  assert.match(r6, /signed in/i, 'R6 error acknowledges the sign-in worked')
  assert.doesNotMatch(r6, /Voiceprint required/, 'R6 still not labelled as a voiceprint problem')
  assert.equal(events.filter((e) => e.ch === 'auth:sign-in').length, 1, 'R6 no automatic sign-in loop')
  assert.deepEqual(apiCalls('/enroll'), [], 'R6 never re-enrols')
  onStatusCall = null
  win.destroy()
  checks.push('renderer: sign-in OK but voiceprint store still refuses → specific error shown, no loop, no re-enrolment')

  // R7 — review R-3 (c), renderer half: Sign out while "Sign in again" is in
  // flight; a late sign-in result must not sign the user back in.
  authSignedIn = true
  status = UNKNOWN
  onStatusCall = () => {
    authSignedIn = false
  }
  win = await openWithStoredUser(STORED)
  await until(async () => (await text(win)).includes('Sign in again'), 'R7 sign-in-required screen', 8_000)
  let releaseSignIn!: (v: unknown) => void
  ipcMain.removeHandler('auth:sign-in')
  ipcMain.handle('auth:sign-in', () => {
    events.push({ ch: 'auth:sign-in' })
    return new Promise((r) => (releaseSignIn = r))
  })
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('button')].find((b) => b.textContent === 'Sign in again').click()`
  )
  await until(async () => (await text(win)).includes('Signing in…'), 'R7 sign-in in flight')
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('button')].find((b) => b.textContent === 'Sign out').click()`
  )
  await until(async () => (await text(win)).includes('Sign in with Microsoft'), 'R7 signed out to login')
  const signOutAt = events.length
  releaseSignIn({ ok: true, name: STORED.name, email: STORED.email, storageAccess: 'ok' })
  await wait(1_000)
  assert.match(await text(win), /Sign in with Microsoft/, 'R7 late sign-in result does not leave the login screen')
  assert.equal(await storedUser(win), null, 'R7 late sign-in result does not restore mn.user')
  assert.deepEqual(
    events.slice(signOutAt).filter((e) => e.ch === 'auth:set-user' && e.arg !== ''),
    [],
    'R7 late sign-in result does not push an actor'
  )
  onStatusCall = null
  win.destroy()
  checks.push('renderer: Sign out during "Sign in again" wins over the late sign-in result')

  // R4 — genuinely unenrolled (central store answered "no record").
  authSignedIn = true
  status = ABSENT
  personEnrolled = false
  win = await openWithStoredUser(STORED)
  await until(async () => (await text(win)).includes('Voiceprint required'), 'R4 voiceprint required')
  const r4 = await text(win)
  assert.doesNotMatch(r4, /Sign in again|Try again|Couldn’t check/, 'R4 genuine absence has its own wording')
  assert.deepEqual(apiCalls('/enroll'), [], 'R4 nothing enrolled without the user')
  win.destroy()
  checks.push('renderer: confirmed absence alone shows "Voiceprint required"')

  // R5 — signed in, central store unreachable: retry wording after backoff.
  authSignedIn = true
  status = UNKNOWN
  personEnrolled = true
  win = await openWithStoredUser(STORED)
  await until(async () => (await text(win)).includes('Couldn’t check your voiceprint'), 'R5 outage screen', 70_000)
  const r5 = await text(win)
  assert.match(r5, /Try again/, 'R5 outage keeps Try again')
  assert.doesNotMatch(r5, /Sign in again|Voiceprint required/, 'R5 outage never claims signed out or unenrolled')
  const statusCalls = apiCalls('/enrolment-status').length
  assert.ok(statusCalls >= 2, 'R5 outage retried before failing')
  win.destroy()
  checks.push(`renderer: signed-in central outage → retries (${statusCalls} attempts) → "Couldn’t check your voiceprint" + Try again`)

  // R8 — dev-build field repro (16 Nov): every status call times out at the
  // proxy while /people/me answers, for a person not enrolled on this PC.
  // Review R-4: the Slice 1 fallback opened the wizard; it must not.
  authSignedIn = true
  status = ENROLLED
  statusTimesOut = true
  personEnrolled = false
  win = await openWithStoredUser(STORED)
  await until(async () => (await text(win)).includes('Couldn’t check your voiceprint'), 'R8 timeout screen', 70_000)
  const r8 = await text(win)
  assert.doesNotMatch(r8, /Voiceprint required|Sign in again/, 'R8 an unanswered status never opens the wizard')
  assert.deepEqual(apiCalls('/enroll'), [], 'R8 nothing enrolled')
  statusTimesOut = false
  win.destroy()
  checks.push('renderer: status call times out every attempt, not enrolled locally → "Couldn’t check your voiceprint", never the wizard')
}

app
  .whenReady()
  .then(async () => {
    const checks: string[] = []
    await mainProcessChecks(checks)
    await rendererChecks(checks)
    out(JSON.stringify({ verifiedAt: new Date().toISOString(), mode: 'synthetic', realBuiltRendererAndPreload: true, realMainAuthIpc: true, providerRequests: 0, checks }, null, 2))
    app.exit(0)
  })
  .catch((err: unknown) => {
    out(err instanceof Error ? (err.stack ?? err.message) : String(err))
    app.exit(1)
  })
setTimeout(() => {
  out('FD-2265 auth harness exceeded 240 s')
  app.exit(1)
}, 240_000)
