# v2.0.24 Audio Routing Observe Re-land Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the dead-mic upload safety net plus the Windows audio-endpoint observer with dry-run telemetry — everything that observes, nothing that acts.

**Architecture:** Restore the proven observer stack (Rust helper → stdout JSON → Electron supervisor → IPC) verbatim from tag `v2.0.17`, hand-port the four files that drifted since, and add a new dry-run matcher module that logs what active routing *would* do without touching capture. Packaging stages the helper exe into a clean directory and asserts signatures on outputs; a new CI workflow runs every fixture before any release job does.

**Tech Stack:** Electron 31 / electron-vite, TypeScript, Rust (`windows` crate, toolchain 1.88.0), FastAPI backend (Python 3.12, unittest), electron-builder 26.15.3 (to be pinned exact), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-11-audio-routing-staged-reland-design.md`

**Ground rules for every task:** current HEAD is `8dbaa69` on `main`. Files restored from `v2.0.17` are taken with `git checkout v2.0.17 -- <path>` (never copy-paste from this document). `src/preload/index.ts`, `SettingsScreen.tsx`, `App.tsx`, and `capture.ts` are byte-identical to v2.0.15, so v2.0.17 restores of preload apply cleanly; the others are hand-ports. Backend tests run from `backend/` with `./.venv/Scripts/python.exe`. Renderer fixtures run with `npm run verify:<name>`.

---

### Task 1: Commit the existing safety-net work

The dead-mic upload fallback and api-proxy error-body logging are already implemented and tested on the working tree (uncommitted).

**Files:**
- Commit: `backend/app/routers/meetings.py`, `backend/tests/test_system_segment_merge.py`, `src/main/api-proxy.ts`

- [ ] **Step 1: Verify the tree state and tests**

Run: `git status --short` — expect exactly the three files above modified.
Run (from `backend/`): `./.venv/Scripts/python.exe -m unittest tests.test_system_segment_merge tests.test_meeting_processing_auth tests.test_recorder_silence_flag -v 2>&1 | tail -3`
Expected: OK (25 tests).
Run: `npx tsc --noEmit -p tsconfig.node.json` — expected: no output.

- [ ] **Step 2: Commit**

```bash
git add backend/app/routers/meetings.py backend/tests/test_system_segment_merge.py src/main/api-proxy.ts
git commit -m "fix: upload recordings with a dead mic track using system audio only

A mic MediaRecorder that dies (device switch, exclusive-mode contention)
leaves a header-only webm; the upload then 422'd forever even with healthy
system audio saved locally (field incident 11 Aug). A sub-1KB mic with
system segments now uploads system-only, stamps recorder_audio_missing at
upload time, and unlinks any stale mic track so the pipeline probe cannot
overwrite the flag. api-proxy now logs non-ok response bodies so
report-problem emails carry the error detail.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Restore the observer foundation from v2.0.17

**Files:**
- Restore (verbatim): `native/audio-endpoint-monitor/` (whole directory), `src/shared/audio-endpoints.ts`, `src/main/audio-endpoint-protocol.ts`, `src/main/audio-endpoint-service.ts`, `scripts/verify-audio-endpoint-protocol.ts`, `scripts/verify-audio-endpoint-service.ts`, `src/preload/index.ts`
- Modify: `package.json` (verify script entries only)

- [ ] **Step 1: Restore files**

```bash
git checkout v2.0.17 -- native/audio-endpoint-monitor src/shared/audio-endpoints.ts src/main/audio-endpoint-protocol.ts src/main/audio-endpoint-service.ts scripts/verify-audio-endpoint-protocol.ts scripts/verify-audio-endpoint-service.ts src/preload/index.ts
```

- [ ] **Step 2: Add the two verify scripts to package.json**

Add to `"scripts"` (copy the exact lines from `git show v2.0.17:package.json`):
`"verify:audio-endpoint-protocol"` and `"verify:audio-endpoint-service"`. Do NOT add `verify:audio-routing` / `verify:audio-routing-ui` / `build:audio-helper` yet (Tasks 4 and 6).

- [ ] **Step 3: Run the restored fixtures and Rust tests**

Run: `npm run verify:audio-endpoint-protocol` — expected: PASS output, exit 0.
Run: `npm run verify:audio-endpoint-service` — expected: PASS output, exit 0.
Run: `cargo test --manifest-path native/audio-endpoint-monitor/Cargo.toml` — expected: `3 passed`.
Run: `npm run typecheck:node` — expected: clean.

- [ ] **Step 4: Commit**

```bash
git add -A native/audio-endpoint-monitor src/shared/audio-endpoints.ts src/main/audio-endpoint-protocol.ts src/main/audio-endpoint-service.ts scripts/verify-audio-endpoint-protocol.ts scripts/verify-audio-endpoint-service.ts src/preload/index.ts package.json
git commit -m "feat: restore Windows audio endpoint observer from v2.0.17

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Adapt the observer service (win32 gate, missing-binary tolerance)

**Files:**
- Modify: `src/main/audio-endpoint-service.ts`
- Test: extend `scripts/verify-audio-endpoint-service.ts`

- [ ] **Step 1: Extend the fixture with two failing assertions**

Append to `scripts/verify-audio-endpoint-service.ts` (follow its existing assert style):

The restored service's options object is `{ helperPath, spawnHelper?, scheduleRestart?, cancelRestart?, onSnapshot?, log }` — `spawnHelper` is the existing spawn seam. Only `existsFn` is new (added in Step 3). Append, following the fixture's existing FakeChild/injection style:

```ts
// Missing helper binary: warn once, never spawn, never restart.
{
  const logs: string[] = []
  const service = new AudioEndpointService({
    helperPath: 'Z:/nonexistent/notetaker-audio-endpoints.exe',
    onSnapshot: () => {},
    log: { info: () => {}, warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) } as never,
    spawnHelper: () => {
      throw new Error('spawnHelper must not be called for a missing helper')
    },
    existsFn: () => false
  })
  service.start()
  assert.equal(logs.length, 1, 'exactly one warning for a missing helper')
  assert.match(logs[0], /helper binary not found/)
  service.stop()
}
```

**Also update every pre-existing service construction in this fixture** to pass `existsFn: () => true` — they use fake paths like `C:\test\notetaker-audio-endpoints.exe`, which would fail the new default `fs.existsSync` guard and break all restored assertions.

- [ ] **Step 2: Run fixture to verify it fails**

Run: `npm run verify:audio-endpoint-service`
Expected: FAIL (missing seam or missing guard).

- [ ] **Step 3: Implement in `audio-endpoint-service.ts`**

- Constructor options gain optional `existsFn` (default `fs.existsSync`); the existing `spawnHelper` seam is untouched.
- `start()` begins with:

```ts
if (!(this.options.existsFn ?? existsSync)(this.options.helperPath)) {
  this.options.log.warn(`[audio-endpoints] helper binary not found at ${this.options.helperPath}; endpoint observation disabled`)
  return
}
```

- [ ] **Step 4: Run fixture to verify it passes**

Run: `npm run verify:audio-endpoint-service` — expected: PASS.
Run: `npm run typecheck:node` — expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/audio-endpoint-service.ts scripts/verify-audio-endpoint-service.ts
git commit -m "fix: audio endpoint service tolerates a missing helper binary

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Wire the service into the main process (win32-only)

**Files:**
- Modify: `src/main/index.ts` (hand-port — do NOT `git checkout` this file; it gained the quit-teardown failsafe on 10 Aug which must be preserved)

- [ ] **Step 1: Apply the v2.0.17 wiring onto current index.ts**

Reference: `git diff 5a914d6 c0c7fbc -- src/main/index.ts`. Port exactly that delta, with one change — everything is gated on win32:

```ts
import { AudioEndpointService, resolveAudioEndpointHelperPath } from './audio-endpoint-service'

const audioEndpointService =
  process.platform === 'win32'
    ? new AudioEndpointService({
        helperPath: resolveAudioEndpointHelperPath({
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          appPath: app.getAppPath()
        }),
        onSnapshot: (snapshot) => {
          for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send('audio-endpoints:changed', snapshot)
          }
        },
        log: logger()
      })
    : null

// with the other ipcMain.handle registrations:
ipcMain.handle('audio-endpoints:get', () => audioEndpointService?.getSnapshot() ?? null)
// inside app.whenReady(), same position as v2.0.17 (after single-instance guard):
audioEndpointService?.start()
// inside before-quit, before the teardown failsafe arms:
audioEndpointService?.stop()
```

- [ ] **Step 2: Typecheck and dev smoke**

Run: `npm run typecheck:node` — expected: clean.
Dev has no helper binary yet — start `npm run dev`, confirm main.log shows exactly one `helper binary not found` warning and the app runs normally. Kill dev.

- [ ] **Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: start audio endpoint observer on Windows and expose snapshots over IPC

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Dry-run matcher module (TDD)

**Files:**
- Create: `src/renderer/src/lib/audioRoutingDryRun.ts`
- Create: `scripts/verify-audio-routing-dryrun.ts`
- Modify: `package.json` (add `verify:audio-routing-dryrun` script, same esbuild shape as the others with `--tsconfig=tsconfig.web.json`)

- [ ] **Step 1: Write the failing fixture**

`scripts/verify-audio-routing-dryrun.ts`:

```ts
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

// 3. Two devices sharing the label with DISTINCT groupIds → genuinely different hardware → ambiguous.
//    (Same groupId would mean duplicate enumerations of one device → matched; not exercised here.)
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
  const line = formatDryRunLog('recording-start', snapshot('Headset Microphone (Jabra)'), {
    outcome: 'matched',
    deviceId: 'real-1',
    deviceLabel: 'Headset Microphone (Jabra)'
  }, 'Microphone Array (Realtek)')
  const parsed = JSON.parse(line)
  assert.equal(parsed.event, 'recording-start')
  assert.equal(parsed.generation, 3)
  assert.equal(parsed.outcome, 'matched')
  assert.equal(parsed.wouldUse, 'Headset Microphone (Jabra)')
  assert.equal(parsed.activeMic, 'Microphone Array (Realtek)')
  assert.ok(!line.includes('\n'))
}

console.log('verify-audio-routing-dryrun: all assertions passed')
```

- [ ] **Step 2: Add the npm script, run fixture, verify it fails**

Run: `npm run verify:audio-routing-dryrun`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement `audioRoutingDryRun.ts`**

```ts
/**
 * Dry-run half of the future active mic routing (v2.0.25). Computes what the
 * communications-device matcher WOULD pick and logs it; never touches capture.
 * Fleet telemetry from these lines validates the matcher (blank-label rate,
 * ambiguity rate) before any of it controls a stream — the v2.0.17 rollback
 * post-mortem is the reason this exists.
 */
import type { AudioEndpointSnapshot } from '../../../shared/audio-endpoints'

export type DryRunOutcome = 'matched' | 'labels_blank' | 'no_match' | 'ambiguous' | 'no_snapshot'

export interface DryRunMatch {
  outcome: DryRunOutcome
  deviceId: string | null
  deviceLabel: string | null
}

const PSEUDO_DEVICE_IDS = new Set(['default', 'communications'])

const normalizeLabel = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase()

export function resolveDryRunMatch(
  snapshot: AudioEndpointSnapshot | null,
  devices: MediaDeviceInfo[]
): DryRunMatch {
  const target = snapshot?.endpoints.captureCommunications
  if (!target) return { outcome: 'no_snapshot', deviceId: null, deviceLabel: null }

  const inputs = devices.filter(
    (d) => d.kind === 'audioinput' && !PSEUDO_DEVICE_IDS.has(d.deviceId)
  )
  if (inputs.length > 0 && inputs.every((d) => !d.label)) {
    return { outcome: 'labels_blank', deviceId: null, deviceLabel: null }
  }

  const wanted = normalizeLabel(target.label)
  const matches = inputs.filter((d) => normalizeLabel(d.label) === wanted)
  if (matches.length === 1) {
    return { outcome: 'matched', deviceId: matches[0].deviceId, deviceLabel: matches[0].label }
  }
  if (matches.length > 1) {
    // groupId corroboration: distinct groupIds mean genuinely different
    // hardware sharing a name — ambiguous either way, but a single shared
    // groupId would mean duplicate enumerations of one device.
    const groups = new Set(matches.map((d) => d.groupId))
    if (groups.size === 1) {
      return { outcome: 'matched', deviceId: matches[0].deviceId, deviceLabel: matches[0].label }
    }
    return { outcome: 'ambiguous', deviceId: null, deviceLabel: null }
  }
  return { outcome: 'no_match', deviceId: null, deviceLabel: null }
}

export function formatDryRunLog(
  event: 'recording-start' | 'endpoint-change',
  snapshot: AudioEndpointSnapshot | null,
  match: Pick<DryRunMatch, 'outcome' | 'deviceId' | 'deviceLabel'>,
  activeMicLabel: string | null
): string {
  return JSON.stringify({
    event,
    generation: snapshot?.generation ?? null,
    commsCapture: snapshot?.endpoints.captureCommunications?.label ?? null,
    commsRender: snapshot?.endpoints.renderCommunications?.label ?? null,
    consoleCapture: snapshot?.endpoints.captureConsole?.label ?? null,
    outcome: match.outcome,
    wouldUse: match.deviceLabel,
    wouldUseId: match.deviceId,
    activeMic: activeMicLabel
  })
}
```

Note the import path: from `src/renderer/src/lib/` the shared types live at `../../../shared/audio-endpoints`.

- [ ] **Step 4: Run fixture and typecheck**

Run: `npm run verify:audio-routing-dryrun` — expected: PASS.
Run: `npm run typecheck:web` — expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/audioRoutingDryRun.ts scripts/verify-audio-routing-dryrun.ts package.json
git commit -m "feat: dry-run communications-mic matcher with telemetry log line

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Wire dry-run telemetry into App.tsx

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/preload/index.d.ts` if the restored preload's new methods (`getAudioEndpointSnapshot`, `onAudioEndpointChanged`) are missing from the type declarations (compare against `git show v2.0.17:src/preload/index.d.ts`; restore that file too if it only adds these declarations)

- [ ] **Step 1: Implement the wiring**

In App.tsx (near the existing capture status subscription):

- A `logDryRun(event)` helper: guards on `window.api?.getAudioEndpointSnapshot`, then `Promise.all([getAudioEndpointSnapshot(), navigator.mediaDevices.enumerateDevices()])`, computes `resolveDryRunMatch`, and calls `window.api.debugLog('audio-routing dry-run', { line: formatDryRunLog(event, snapshot, match, captureStatus.micLabel ?? null) })`. Wrap the whole body in try/catch — telemetry must never break recording. (If `CaptureStatus` has no `micLabel` field on current HEAD, pass `null`; do not modify capture.ts.)
- Call `logDryRun('recording-start')` at the two capture-start sites (auto-start and manual start, right after capture starts successfully).
- Subscribe once on mount: `window.api?.onAudioEndpointChanged?.(() => { if (captureStatusRef.current.recording) logDryRun('endpoint-change') })`. App.tsx keeps `captureStatus` in useState but has NO ref — add a `captureStatusRef` (`useRef` updated wherever the state is set, or via a small effect) so the mount-once subscription doesn't close over stale state. Unsubscribe on unmount with the returned dispose function. Note: `CaptureStatus` has `recording` but no `micLabel` on current HEAD, so `activeMic` telemetry is `null` in v2.0.24 — expected, do not modify capture.ts.

- [ ] **Step 2: Typecheck + fixture sweep**

Run: `npm run typecheck:web` — expected: clean.
Run: `npm run verify:audio-routing-dryrun` — expected: still PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/App.tsx src/preload/index.d.ts
git commit -m "feat: log dry-run routing telemetry at recording start and endpoint changes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Read-only endpoint display in Settings

**Files:**
- Modify: `src/renderer/src/screens/SettingsScreen.tsx` (hand-port the display subset from `git show v2.0.17:src/renderer/src/screens/SettingsScreen.tsx` — NOT a full checkout; the v2.0.17 file also contains the routing-mode radio and pinned-mic picker which are out of scope)

- [ ] **Step 1: Port the display block**

From the v2.0.17 file take only: the `EndpointValue` presentational component, the snapshot state + `getAudioEndpointSnapshot()` load + `onAudioEndpointChanged` subscription, the "Windows audio endpoints" section markup (communications mic/output rows, console default rows, the console-vs-communications mismatch note, and the Teams "Computer audio" guidance text). Leave prefs untouched. When `window.api?.getAudioEndpointSnapshot` is absent (non-Windows/dev) or returns null, render the section with a "not available on this machine" line — follow the screen's existing fallback styling.

- [ ] **Step 2: Typecheck and static preview check**

Run: `npm run typecheck:web` — expected: clean.
Optional visual check per CLAUDE.md: serve `renderer-static` and confirm the section renders with the sample-data fallback.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/screens/SettingsScreen.tsx
git commit -m "feat: read-only Windows audio endpoint display in settings

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Packaging — staged helper dir, pinned electron-builder, signature-asserted output

**Files:**
- Modify: `package.json` (scripts + electron-builder pin)
- Modify: `electron-builder.yml`
- Create: `scripts/stage-audio-helper.cjs`
- Modify: `.gitignore` (ignore `native/audio-endpoint-monitor/dist/`)

- [ ] **Step 1: Staging script**

`scripts/stage-audio-helper.cjs`:

```js
// Stage the audio endpoint helper into a clean dir for electron-builder.
// A directory extraResources mapping keeps electron-builder 26's Windows
// signing transformer engaged (single-file mappings bypass it), and staging
// keeps electron-builder out of the cargo target/ tree (the 4 Aug 213MB
// installer came from walking it).
const { copyFileSync, mkdirSync, rmSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..', 'native', 'audio-endpoint-monitor')
const built = join(root, 'target', 'release', 'notetaker-audio-endpoints.exe')
const dist = join(root, 'dist')

if (!existsSync(built)) {
  console.error(`stage-audio-helper: missing ${built} — run the cargo build first`)
  process.exit(1)
}
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
copyFileSync(built, join(dist, 'notetaker-audio-endpoints.exe'))
console.log('stage-audio-helper: staged notetaker-audio-endpoints.exe')
```

- [ ] **Step 2: package.json scripts + pin**

- `"build:audio-helper": "cargo build --release --manifest-path native/audio-endpoint-monitor/Cargo.toml && node scripts/stage-audio-helper.cjs"`
- Prepend `npm run build:audio-helper && ` to `package`, `package:dir`, and `package:win` exactly as v2.0.17 did.
- In `devDependencies`, verify `"electron-builder"` is the exact `"26.15.3"` (no `^`) — it already is on current HEAD; this step is a check, not an edit.

- [ ] **Step 3: electron-builder.yml**

```yaml
extraResources:
  # Native Core Audio observer. Kept outside ASAR so Electron can spawn it.
  # Staged directory copy: electron-builder 26 bypasses its Windows signing
  # transformer for single-file extraResources mappings, and a directory
  # mapping must not point into the cargo target/ tree (installer bloat).
  - from: native/audio-endpoint-monitor/dist
    to: audio
    filter:
      - notetaker-audio-endpoints.exe
```

(Merge with the existing `extraResources` entries — append this mapping; do not replace the block.)

- [ ] **Step 4: .gitignore**

Add `native/audio-endpoint-monitor/dist/` (the restored `native/audio-endpoint-monitor/.gitignore` already ignores `/target/`).

- [ ] **Step 5: Local package smoke**

Run: `npm run build:audio-helper` — expected: cargo build + "staged notetaker-audio-endpoints.exe".
Run: `npm run package:dir` (per CLAUDE.md, local builds have `signAndEditExecutable: false` — signing is CI-only).
Expected: `dist/win-unpacked/resources/audio/notetaker-audio-endpoints.exe` exists. Run it directly for 2 seconds; expect one JSON snapshot line on stdout.

- [ ] **Step 6: Commit**

```bash
git add package.json electron-builder.yml scripts/stage-audio-helper.cjs .gitignore
git commit -m "build: stage signed audio helper via clean extraResources dir, pin electron-builder

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Release workflow — Rust build + third signature target

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Add the Rust toolchain + helper build to the packaging job**

In the job that runs `Pre-package checks` (line ~161): after `Install dependencies`, add:

```yaml
      - name: Install Rust toolchain (audio endpoint helper)
        uses: dtolnay/rust-toolchain@stable
        with:
          toolchain: 1.88.0
      - name: Cache cargo
        uses: actions/cache@v4
        with:
          path: |
            ~/.cargo/registry
            ~/.cargo/git
            native/audio-endpoint-monitor/target
          key: cargo-${{ runner.os }}-${{ hashFiles('native/audio-endpoint-monitor/Cargo.lock') }}
      - name: Build audio endpoint helper
        run: |
          cargo test --manifest-path native/audio-endpoint-monitor/Cargo.toml
          npm run build:audio-helper
```

(No behavior change needed in the `Build signed installer` step — `package:win` now runs the staging via package.json.) Note: `npm run package:win` invoked by the existing step will rebuild the helper; that is fine and idempotent.

- [ ] **Step 2: Widen the signature assertion**

In `Assert installer and app binary are signed and timestamped` (line ~179), the step iterates a `$targets` array. Append two entries: `dist\win-unpacked\resources\audio\notetaker-audio-endpoints.exe` (the helper), and the backend bundle exe (spec §5 promises app + backend + helper; find the exact path with `Get-ChildItem dist\win-unpacked\resources\backend -Recurse -Filter '*.exe'` after a local `package:dir` and use that path). This asserts the *outputs* are signed — the v2.0.16 failure mode (electron-builder silently skipping the helper) now fails the release loudly.

- [ ] **Step 3: Installer-size guard**

In the same assertion step (or a new step directly after), add:

```powershell
$installer = Get-ChildItem dist -Filter '*.exe' | Where-Object Name -like '*setup*' | Select-Object -First 1
$mb = [math]::Round($installer.Length / 1MB)
if ($mb -gt 175) { throw "Installer is ${mb}MB — expected ~162MB (v2.0.23) + helper; cargo target tree may have leaked into extraResources" }
Write-Host "OK: installer size ${mb}MB"
```

- [ ] **Step 4: Validate YAML + commit**

Run: `node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/release.yml','utf8')); console.log('yaml ok')"` (js-yaml is in node_modules via electron-builder).

```bash
git add .github/workflows/release.yml
git commit -m "ci: build, sign-assert, and size-guard the audio helper in releases

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: CI workflow (new)

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the workflow**

```yaml
# CI for pushes and PRs. Exists because the 4 Aug audio-routing release died
# in the tag-triggered release job — the first place its tests had ever run.
name: ci
on:
  push:
    branches: [main]
  pull_request:

jobs:
  renderer:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - name: Renderer fixtures
        run: |
          npm run verify:audio-endpoint-protocol
          npm run verify:audio-endpoint-service
          npm run verify:audio-routing-dryrun
          npm run verify:recording-controls
          npm run verify:capture

  rust-helper:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          toolchain: 1.88.0
      - uses: actions/cache@v4
        with:
          path: |
            ~/.cargo/registry
            ~/.cargo/git
            native/audio-endpoint-monitor/target
          key: cargo-ci-${{ runner.os }}-${{ hashFiles('native/audio-endpoint-monitor/Cargo.lock') }}
      - run: cargo test --manifest-path native/audio-endpoint-monitor/Cargo.toml

  backend:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: pip install -r backend/requirements.txt pytest
      - name: Backend tests
        working-directory: backend
        # One known-flaky concurrency test is deselected (pre-existing, tracked
        # in docs/jira-progress.md); everything else must pass. The ~25 local
        # failures on dev machines come from the real backend.env leaking into
        # settings — CI has no backend.env, so the full suite is expected green.
        run: python -m pytest tests --deselect tests/test_storage_api_meetings.py::StubMeetingDeliveryTests::test_stub_serializes_concurrent_exports_for_one_meeting -q
```

Check first: `npm run verify:capture` / `verify:recording-controls` exist in current package.json (they do — `verify:recording-controls`, and `verify:capture` may be named `verify:capture-segments`; use the exact current names).

- [ ] **Step 2: Validate YAML, commit, and observe the first run**

Validate YAML as in Task 9.

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run typechecks, fixtures, cargo tests, and backend suite on push/PR

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

After the branch is pushed (Task 12), watch the first `ci` run with `gh run watch`; fix any environment surprises (e.g. backend suite failures in clean CI) before the release.

---

### Task 11: Docs + version bump

**Files:**
- Modify: `docs/jira-progress.md` (new dated entry: safety net + observer re-land, spec link, what is deferred to v2.0.25)
- Modify: `package.json` (`"version": "2.0.24"`)

- [ ] **Step 1: Write the jira-progress entry, bump version**

- [ ] **Step 2: Commit**

```bash
git add docs/jira-progress.md package.json
git commit -m "release: bump to 2.0.24

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Full verification + release handoff

- [ ] **Step 1: Full local sweep**

- `npm run typecheck` — clean.
- All verify fixtures listed in ci.yml — PASS.
- `cargo test` — 3 passed.
- Backend (from `backend/`): `./.venv/Scripts/python.exe -m unittest tests.test_system_segment_merge tests.test_meeting_processing_auth tests.test_recorder_silence_flag tests.test_long_audio_preparation tests.test_pipeline_stage_state` — OK. (Full discover locally still shows the ~25 pre-existing env failures; that is the documented local condition, not a regression — CI is the authority.)
- `npm run package:dir` → helper present in `resources/audio/`, runs, emits snapshot.

- [ ] **Step 2: Push and watch CI**

Push `main` (or a branch + PR per preference — the 4 Aug lesson says branch). `gh run watch` until `ci` is green.

- [ ] **Step 3: Live smoke (user, per spec acceptance §4–6)**

User installs the signed CI build (or dev build for a pre-check): record a short Teams call, connect Bluetooth headset mid-recording; recording completes + uploads; main.log contains `audio-routing dry-run` lines for `recording-start` and `endpoint-change`; Settings shows the endpoint rows.

- [ ] **Step 4: Release ritual (user-driven)**

Tag `v2.0.24`, FIC subject PATCH, tag push (classifier-blocked commands run by the user via `!`), CI release run green including the new helper signature + size assertions, feed verification (latest.yml = 2.0.24, sha512, signature). Then coordinate with DV on Gabby's machine (cert-less; may need manual install) so her stuck recording can finally be retried.
