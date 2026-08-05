# IN-485 Update Certificate-Failure Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When electron-updater rejects an update because the device is missing the Factor1 Private Trust signing root, the Settings UI shows a distinct, actionable "blocked — certificate" state (and detects the missing root proactively), instead of hanging on "Downloading" forever.

**Architecture:** The main-process updater gains (1) a push channel (`updates:status` via `webContents.send`) so download-progress / downloaded / error events reach the renderer — today `updates:check` returns `available` once and nothing else ever arrives, which is the stuck-"Downloading" bug; (2) a pure error classifier that maps electron-updater signature/trust failures to a new `blocked-cert` state; (3) a preflight `certutil` probe for the Private Trust root thumbprint so the blocked state appears *before* a doomed 162 MB download. The renderer's `UpdateCheck` component subscribes to the push channel and renders live states.

**Tech Stack:** Electron main/preload IPC (existing patterns in `src/main/updater.ts`, `src/preload/index.ts`), `certutil` spawned via fixed-argument `execFile` (the repo's established no-shell pattern — see the injection-safety note in `src/main/backend-supervisor.ts:92`; there is no shared exec utility in this repo), verify-script harness per `scripts/verify-update-gate.ts` convention.

**Security note for the implementer:** all process spawning in this plan is `execFile` with a **constant binary name and constant argument array** (no shell, no interpolation, no user input anywhere near the command). Do not switch to `exec()` or template a command string.

**Context you must know (read before starting):**
- Jira IN-485: David's machine (manual 2.0.13) rejected 2.0.18 with electron-updater error *"New version 2.0.18 is not signed by the application owner … A certificate chain processed, but terminated in a root certificate which is not trusted"*. UI showed "Downloading" indefinitely.
- The rejection itself is CORRECT behaviour (Private Trust design, IN-81): the device lacks the root **"Microsoft Enterprise Identity Verification Root Certificate Authority 2020"**, thumbprint `AB3FD6E553CCFF3E34C164623B70F30CE1937A74`. IT deploys it via an Intune Trusted-certificate profile. Do NOT weaken signature verification in any way.
- `src/main/updater.ts` currently: `updates:check` invoke handler returns one-shot status; `autoUpdater.on('error')` only logs (IN-484); `update-downloaded` drives tray/toast via `deps.onUpdateReady`, never the Settings UI.
- `src/renderer/src/screens/SettingsScreen.tsx` `UpdateCheck` (line ~577) sets "Downloading" on `available` and never updates again.
- Repo conventions: sentence-case UI copy; verify scripts are plain-node assertion harnesses under `scripts/` wired as `npm run verify:<name>`; `npm run typecheck` must pass; evidence goes to `docs/jira-progress.md` at the end.
- This fix ships in **v2.0.20**. Machines already unable to update won't receive it via auto-update (they can't update — that's the bug); it protects the next cert-less device and every manual-check user.

**File structure:**
- Create `src/main/update-error-classify.ts` — pure classification + certutil-output parsing (importable by the verify harness without Electron).
- Create `src/main/root-cert-check.ts` — spawns `certutil`, uses the parser; injectable exec for testing.
- Modify `src/main/updater.ts` — status broadcasting + wiring.
- Modify `src/preload/index.ts` — `onUpdateStatus` subscription.
- Modify `src/renderer/src/screens/SettingsScreen.tsx` — live `UpdateCheck` states.
- Create `scripts/verify-update-status.ts` — harness; add `verify:update-status` to `package.json`.

---

### Task 1: Pure error classifier + certutil output parser

**Files:**
- Create: `src/main/update-error-classify.ts`
- Create: `scripts/verify-update-status.ts`
- Modify: `package.json` (scripts block)

- [ ] **Step 1: Write the failing verify harness**

Create `scripts/verify-update-status.ts`, mirroring the structure of `scripts/verify-update-gate.ts` (read it first). CRITICAL structure constraint: the repo's runner bundles with esbuild `--format=cjs`, which REJECTS top-level `await` — so, exactly like `verify-update-gate.ts`, put every assertion inside `async function main(): Promise<void>` and end the file with `void main().catch((err) => { console.error(err); process.exitCode = 1 })`. Cover:

```ts
import assert from 'node:assert/strict'
import {
  classifyUpdaterError,
  certutilOutputShowsThumbprint,
  SIGNING_ROOT_THUMBPRINT
} from '../src/main/update-error-classify'

async function main(): Promise<void> {
  // The exact IN-485 field error must classify as cert-trust.
  assert.equal(
    classifyUpdaterError(
      'New version 2.0.18 is not signed by the application owner: publisherNames: CN=factor1.com.au ... ' +
        'A certificate chain processed, but terminated in a root certificate which is not trusted by the trust provider'
    ),
    'cert-trust'
  )
  // Root-trust wording alone (raw WinVerifyTrust text) also classifies.
  assert.equal(
    classifyUpdaterError('A certificate chain processed, but terminated in a root certificate which is not trusted'),
    'cert-trust'
  )
  // Publisher mismatch WITHOUT the root-trust phrase = possible tampering —
  // must stay generic, never advertised as an IT cert-deployment issue.
  assert.equal(
    classifyUpdaterError('New version 2.0.18 is not signed by the application owner: publisherNames: CN=factor1.com.au'),
    'generic'
  )
  // TLS/proxy chain wording during feed download must stay generic too.
  assert.equal(
    classifyUpdaterError('unable to verify the first certificate in the certificate chain'),
    'generic'
  )
  assert.equal(classifyUpdaterError('net::ERR_NAME_NOT_RESOLVED'), 'generic')
  assert.equal(classifyUpdaterError('sha512 checksum mismatch'), 'generic')

  // certutil output parsing: found vs not found, case-insensitive, spaced thumbprints.
  assert.equal(SIGNING_ROOT_THUMBPRINT, 'AB3FD6E553CCFF3E34C164623B70F30CE1937A74')
  assert.equal(
    certutilOutputShowsThumbprint(
      'Cert Hash(sha1): ab 3f d6 e5 53 cc ff 3e 34 c1 64 62 3b 70 f3 0c e1 93 7a 74\nCertUtil: -store command completed successfully.',
      SIGNING_ROOT_THUMBPRINT
    ),
    true
  )
  assert.equal(
    certutilOutputShowsThumbprint('CertUtil: -store command FAILED: 0x80070490', SIGNING_ROOT_THUMBPRINT),
    false
  )
  console.log('verify-update-status: all assertions passed')
}

void main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
```

Add to `package.json` scripts, using the repo's esbuild-bundle-then-node runner form (there is NO `tsx` in this repo — copy `verify:update-gate`'s exact shape):

```json
"verify:update-status": "esbuild scripts/verify-update-status.ts --bundle --platform=node --format=cjs --outfile=out/verify-update-status.cjs --log-level=error && node out/verify-update-status.cjs",
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run verify:update-status`
Expected: FAIL — esbuild error `Could not resolve "../src/main/update-error-classify"`.

- [ ] **Step 3: Implement the module**

Create `src/main/update-error-classify.ts`:

```ts
// IN-485: classify electron-updater failures so the renderer can show a
// distinct, actionable state when the Private Trust signing root is missing
// (Intune cert-profile gap) instead of a generic error.

/** "Microsoft Enterprise Identity Verification Root Certificate Authority 2020" —
 * the Private Trust anchor IT pushes via Intune (IN-81). */
export const SIGNING_ROOT_THUMBPRINT = 'AB3FD6E553CCFF3E34C164623B70F30CE1937A74'

export type UpdaterErrorKind = 'cert-trust' | 'generic'

// ONLY the WinVerifyTrust root-trust phrase counts. Deliberately narrow:
// "not signed by the application owner" alone can mean a genuinely tampered
// artifact (publisher mismatch, valid chain) and bare "certificate chain"
// matches TLS/proxy errors — neither may be dressed up as an IT
// cert-deployment issue.
const CERT_TRUST_PATTERN = /terminated in a root certificate/i

export function classifyUpdaterError(message: string): UpdaterErrorKind {
  return CERT_TRUST_PATTERN.test(message) ? 'cert-trust' : 'generic'
}

/** certutil prints "Cert Hash(sha1): ab 3f d6 ..." when the store holds the cert. */
export function certutilOutputShowsThumbprint(output: string, thumbprint: string): boolean {
  const normalized = output.toLowerCase().replace(/[\s:]/g, '')
  return normalized.includes(thumbprint.toLowerCase())
}
```

- [ ] **Step 4: Run the harness and typecheck**

Run: `npm run verify:update-status && npm run typecheck`
Expected: assertions pass; typecheck green.

- [ ] **Step 5: Commit**

```bash
git add src/main/update-error-classify.ts scripts/verify-update-status.ts package.json
git commit -m "feat: classify updater cert-trust failures (IN-485)"
```

### Task 2: Root-cert preflight probe

**Files:**
- Create: `src/main/root-cert-check.ts`
- Modify: `scripts/verify-update-status.ts` (extend)

- [ ] **Step 1: Extend the harness with failing assertions**

Extend `scripts/verify-update-status.ts` (fake exec injected — never spawn real certutil in the harness). Placement: the `import { isSigningRootTrusted } …` line joins the other imports at module top (import declarations cannot live inside a function); the `FakeExec` type and the `found`/`notFound` fakes may sit at module scope; the `assert…await` statements MUST go inside `main()` (the top-level-await/CJS constraint applies to the `await` expressions). The fakes must mirror the REAL rejection shapes of promisified `execFile` (verified empirically on Windows): a non-zero exit rejects with `message: "Command failed: certutil …"`, a **numeric** `code` (the exit code), and certutil's `"CertUtil: -store command FAILED: 0x…"` text on **`err.stdout`** (NOT the message; stderr is empty). A spawn failure has a string `code` (`'ENOENT'`); a timeout kill has `killed: true` and `code: null` — but its message still starts with `"Command failed:"`, which is why the definitive-miss test must use the numeric `code`, never a `/FAILED/` message match.

```ts
import { isSigningRootTrusted } from '../src/main/root-cert-check'

type FakeExec = (cmd: string, args: string[]) => Promise<{ stdout: string }>
const found: FakeExec = async () => ({
  stdout: 'Cert Hash(sha1): ab 3f d6 e5 53 cc ff 3e 34 c1 64 62 3b 70 f3 0c e1 93 7a 74'
})
// Real shape of "certutil ran, cert absent": numeric exit code, FAILED text on stdout.
const notFound: FakeExec = async () => {
  throw Object.assign(new Error('Command failed: certutil -store root AB3F…'), {
    code: 2147943568,
    stdout: 'CertUtil: -store command FAILED: 0x80070490',
    stderr: ''
  })
}

// Machine store hit → trusted.
assert.equal(await isSigningRootTrusted(found), true)
// Machine miss but user store hit (Joseph's certutil -user import path) → trusted.
let calls = 0
assert.equal(
  await isSigningRootTrusted(async (cmd, args) => {
    calls += 1
    if (args.includes('-user')) return found(cmd, args)
    return notFound(cmd, args)
  }),
  true
)
assert.equal(calls, 2)
// Both stores definitively miss → not trusted.
assert.equal(await isSigningRootTrusted(notFound), false)
// certutil unavailable must FAIL OPEN (true): the updater's own verification
// is the security backstop; a probe quirk must not block updates or spam
// false "contact IT" states. Spawn error: string code, no numeric exit.
assert.equal(
  await isSigningRootTrusted(async () => {
    throw Object.assign(new Error('spawn certutil ENOENT'), { code: 'ENOENT' })
  }),
  true
)
// Timeout kill must ALSO fail open — its message still says "Command failed:"
// but there is no numeric exit code. This is the case a naive /FAILED/
// message test gets wrong (classifies a hang as "cert missing").
assert.equal(
  await isSigningRootTrusted(async () => {
    throw Object.assign(new Error('Command failed: certutil -store root AB3F…'), {
      killed: true,
      code: null
    })
  }),
  true
)
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm run verify:update-status`
Expected: FAIL — esbuild error `Could not resolve "../src/main/root-cert-check"`.

- [ ] **Step 3: Implement**

Create `src/main/root-cert-check.ts`. Spawning follows the repo's fixed-argument no-shell pattern (same as `auth-msal.ts:431` / `backend-supervisor.ts:92`): promisified `execFile` from `node:child_process`, `{ timeout: 5_000, windowsHide: true }`, binary `certutil`, constant args.

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { certutilOutputShowsThumbprint, SIGNING_ROOT_THUMBPRINT } from './update-error-classify'

const execFileAsync = promisify(execFile)

type Exec = (cmd: string, args: string[]) => Promise<{ stdout: string }>

// Fixed binary + fixed args only — never shell, never interpolated input.
const defaultExec: Exec = async (cmd, args) =>
  execFileAsync(cmd, args, { timeout: 5_000, windowsHide: true })

/**
 * Is the Private Trust signing root present in the machine OR current-user
 * Root store? When certutil runs and the store lacks the cert, promisified
 * execFile rejects with a NUMERIC `code` (the non-zero exit code; certutil's
 * "FAILED" text lands on err.stdout, and the message is Node's generic
 * "Command failed:" prefix). Only that numeric exit code is a definitive
 * "not trusted". Spawn failures (string code like 'ENOENT') and timeout
 * kills (`killed: true`, code null — message STILL says "Command failed:")
 * are NOT definitive and fail open: the updater's own signature verification
 * remains the security backstop (IN-485). Never test the message for FAILED.
 */
export async function isSigningRootTrusted(exec: Exec = defaultExec): Promise<boolean> {
  let sawDefinitiveMiss = false
  for (const args of [
    ['-store', 'root', SIGNING_ROOT_THUMBPRINT],
    ['-user', '-store', 'root', SIGNING_ROOT_THUMBPRINT]
  ]) {
    try {
      const { stdout } = await exec('certutil', args)
      if (certutilOutputShowsThumbprint(stdout, SIGNING_ROOT_THUMBPRINT)) return true
      sawDefinitiveMiss = true
    } catch (err) {
      const code = (err as { code?: unknown }).code
      if (typeof code === 'number') {
        sawDefinitiveMiss = true // certutil ran and exited non-zero: cert absent from this store
      }
      // string code (spawn error) or killed timeout — not definitive
    }
  }
  return sawDefinitiveMiss ? false : true
}
```

- [ ] **Step 4: Run harness + typecheck**

Run: `npm run verify:update-status && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/root-cert-check.ts scripts/verify-update-status.ts
git commit -m "feat: preflight probe for Private Trust signing root (IN-485)"
```

### Task 3: Updater status push channel + wiring

**Files:**
- Modify: `src/main/updater.ts`
- Modify: `src/preload/index.ts`

No harness coverage here (Electron runtime); correctness is typecheck + the Task 5 manual smoke. Keep changes mechanical.

- [ ] **Step 1: Extend `UpdateStatus` and add the broadcaster** (`src/main/updater.ts`)

```ts
import { BrowserWindow } from 'electron' // add to existing electron import
import { classifyUpdaterError } from './update-error-classify'
import { isSigningRootTrusted } from './root-cert-check'

export interface UpdateStatus {
  state:
    | 'dev' | 'checking' | 'up-to-date' | 'available'
    | 'downloading' | 'downloaded' | 'blocked-cert' | 'error'
  version?: string
  message?: string
  percent?: number
}

// Sentence-case, names the cause and the owner of the fix (IT/Intune).
const BLOCKED_CERT_MESSAGE =
  'Updates can’t be verified on this device — the Factor1 signing certificate root is missing. Contact IT to push it via Intune.'

function broadcastUpdateStatus(status: UpdateStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('updates:status', status)
  }
}
```

- [ ] **Step 2: Wire the updater events** (inside `startUpdaterLifecycle`, replacing the log-only `error` handler)

```ts
  autoUpdater.on('error', (err) => {
    const message = err instanceof Error ? err.message : String(err)
    const kind = classifyUpdaterError(message)
    logger().warn('[updater] updater error', { kind, message })
    // Generic errors ARE broadcast, but the renderer applies them only as a
    // reset of a stale "Downloading" label (see Task 4): a download that dies
    // mid-flight after the invoke already resolved 'available' must not
    // strand the UI on "Downloading" (the IN-485 symptom, recreated for
    // network failures) — while a background-check hiccup still can't flip
    // an idle "Current" label.
    broadcastUpdateStatus(
      kind === 'cert-trust'
        ? { state: 'blocked-cert', message: BLOCKED_CERT_MESSAGE }
        : { state: 'error', message }
    )
  })

  autoUpdater.on('download-progress', (progress) => {
    broadcastUpdateStatus({ state: 'downloading', percent: Math.round(progress.percent) })
  })
```

and in the existing `update-downloaded` handler add:

```ts
    broadcastUpdateStatus({ state: 'downloaded', version: info.version })
```

Also add a one-time startup log for fleet triage, right after the `if (!app.isPackaged)` guard:

```ts
  void isSigningRootTrusted().then((trusted) => {
    logger().info('[updater] signing root trust preflight', { trusted })
  })
```

- [ ] **Step 3: Preflight in the manual check** (`updates:check` handler, before `checkForUpdates`)

```ts
    if (!(await isSigningRootTrusted())) {
      logger().warn('[updater] manual check blocked — signing root not trusted on this device')
      return { state: 'blocked-cert', message: BLOCKED_CERT_MESSAGE }
    }
```

- [ ] **Step 4: Preload subscription** (`src/preload/index.ts`, next to `checkUpdates`; follow the existing "Returns unsubscribe" listener pattern used at line ~211)

Follow the repo's exact listener pattern (`preload/index.ts:150-156`, `213-217`): `IpcRendererEvent` is already imported there — type the event parameter with it, not `unknown`/`never`.

```ts
  /** Live update pipeline status pushed from main (IN-485). Returns unsubscribe. */
  onUpdateStatus: (
    cb: (status: { state: string; version?: string; message?: string; percent?: number }) => void
  ): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      status: { state: string; version?: string; message?: string; percent?: number }
    ): void => cb(status)
    ipcRenderer.on('updates:status', listener)
    return () => ipcRenderer.removeListener('updates:status', listener)
  },
```

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: green (both node and web projects).

```bash
git add src/main/updater.ts src/preload/index.ts
git commit -m "feat: push live update status to renderer, blocked-cert state (IN-485)"
```

### Task 4: Live UpdateCheck UI

**Files:**
- Modify: `src/renderer/src/screens/SettingsScreen.tsx:577-623` (`UpdateCheck`)

- [ ] **Step 1: Subscribe and render pushed states**

Replace the `UpdateCheck` body so pushed statuses drive the label after a manual check (keep `previewMode` branch untouched; keep sentence case; UI font/colour conventions as-is). Key changes:

```tsx
function UpdateCheck({ previewMode }: { previewMode: boolean }): JSX.Element {
  const [status, setStatus] = useState('Current')
  const [blocked, setBlocked] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (typeof window.api?.onUpdateStatus !== 'function') return
    return window.api.onUpdateStatus((s) => {
      switch (s.state) {
        case 'downloading':
          setStatus(typeof s.percent === 'number' ? `Downloading ${s.percent}%` : 'Downloading')
          setBlocked(false)
          break
        case 'downloaded':
          setStatus('Restart to update')
          setBlocked(false)
          break
        case 'blocked-cert':
          setStatus('Update blocked — contact IT')
          setBlocked(true)
          break
        case 'error':
          // Pushed generic errors only RESET a stale downloading label — a
          // dead mid-flight download must not strand "Downloading" (the
          // IN-485 symptom). An idle "Current"/"Restart to update" label is
          // never flipped by a background-check hiccup.
          setStatus((prev) => (prev.startsWith('Downloading') ? 'Update check unavailable' : prev))
          break
      }
    })
  }, [])

  const check = async (): Promise<void> => {
    // previewMode branch unchanged …
    if (typeof window.api?.checkUpdates !== 'function') return
    setBusy(true)
    const result = await window.api.checkUpdates()
    setBusy(false)
    setBlocked(result.state === 'blocked-cert')
    switch (result.state) {
      case 'dev': setStatus('Development build'); break
      case 'up-to-date': setStatus('Current'); break
      case 'available': setStatus('Downloading'); break
      case 'blocked-cert': setStatus('Update blocked — contact IT'); break
      case 'error': setStatus('Update check unavailable'); break
      default: setStatus('Current')
    }
  }
  // …button: swap the CircleCheck icon colour/tooltip when blocked:
  //   icon: blocked ? CircleAlert (lucide) with the repo's warning/error status token : CircleCheck as today
  //   title: blocked
  //     ? 'Updates can’t be verified on this device — the Factor1 signing certificate root is missing. Contact IT to push it via Intune.'
  //     : 'Check for updates'
```

Also extend the `checkUpdates` return type in `src/preload/index.ts` (line ~105) and any renderer typing to include `'downloading' | 'downloaded' | 'blocked-cert'` states, `message?`, `percent?`.

Check the design system for the warn colour token before using it: `src/renderer/src/assets` tokens (if no warn token exists, use the status token the failure chips use — see `failureDisplay.ts` / `verify-failure-chips.tsx` for the established tone).

- [ ] **Step 2: Typecheck + build + static preview sanity**

Run: `npm run typecheck && npm run build`
Expected: green. Optionally serve `out/renderer` (`.claude/launch.json` `renderer-static`, port 4173) and DOM-check the Settings screen renders "Current" (previewMode fallback) — `preview_eval`, not screenshots, per CLAUDE.md.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/screens/SettingsScreen.tsx src/preload/index.ts
git commit -m "feat: live update states in Settings, blocked-cert surfaced (IN-485)"
```

### Task 5: Full verification + evidence

- [ ] **Step 1: Full local gates**

Run: `npm run verify:update-status && npm run verify:update-gate && npm run typecheck && npm run build && git diff --check`
Expected: all green (verify:update-gate proves the gate/lifecycle behaviour is untouched).

Run backend suite untouched-check (should be unaffected, cheap insurance):
`PYTHONPATH=backend backend/.venv/Scripts/python -m unittest discover -s backend/tests -t backend`
Expected: OK (the storage-api concurrency test is a known pre-existing flake — rerun once if it alone fails).

- [ ] **Step 2: Manual smoke (packaged behaviour — requires Joseph or a test VM)**

1. On a machine WITH the root cert: Settings → Check for updates → label should progress `Checking… → Downloading N% → Restart to update` (or `Current`). No regression to tray/toast flow.
2. Simulate the IN-485 machine: temporarily move the root out of trust (`certutil -delstore root AB3FD6E553CCFF3E34C164623B70F30CE1937A74` on a TEST machine only — do NOT do this on a fleet machine; re-add after with `certutil -addstore root <exported .cer>`), then Check for updates → expect immediate `Update blocked — contact IT` with no download.
3. Confirm the app log contains `signing root trust preflight` and, on the blocked path, `manual check blocked`.

- [ ] **Step 3: Evidence + wrap-up**

Append the IN-485 entry to `docs/jira-progress.md` (what shipped, test evidence, the ops caveat that cert-less machines need the Intune root push or a manual install — the code fix cannot reach them via auto-update). Commit:

```bash
git add docs/jira-progress.md
git commit -m "docs: IN-485 evidence"
```

Release: ships as v2.0.20 via the standard ritual (bump + FIC subject PATCH to `refs/tags/v2.0.20` + tag push — Joseph runs the blocked commands). Ops half of IN-485 stays with DV: verify the Intune Trusted-certificate profile actually applied on David's / Gabby's / Mel's devices; that is what cures currently-stuck machines.
