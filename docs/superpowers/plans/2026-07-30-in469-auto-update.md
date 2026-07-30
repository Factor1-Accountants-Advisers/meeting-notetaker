# IN-469 Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship self-updating releases via a public Blob HTTPS feed with a tray-aware restart prompt and idle auto-install that never interrupts a recording or in-flight processing.

**Architecture:** Extend the existing `src/main/updater.ts` scaffolding: a pure, verify-script-tested idle-gate predicate decides when a downloaded update may auto-install; main-process wiring feeds it recording state, pending/imminent auto-starts, backend pipeline busy-state, and system idle time. CI publishes `dist/*.exe` + `latest.yml` to the `updates` container using the existing azure/login OIDC session, self-skipping while the feed is unprovisioned.

**Tech Stack:** electron-updater 6.8.9 (already installed), Electron `powerMonitor`/`Notification` (Windows toast XML pattern already in repo), az CLI in GitHub Actions, esbuild `verify:*` script pattern.

**Spec:** `docs/superpowers/specs/2026-07-30-in469-auto-update-design.md` (approved 30 Jul). Read it first.

**Constraints inherited from the spec:**
- Never call `quitAndInstall` on any path that bypasses the recording/processing guards.
- `quitAndInstall(true, true)` — silent install, force relaunch — on BOTH the idle path and the explicit "Restart now" path.
- All checks use `checkForUpdates` (never `checkForUpdatesAndNotify`).
- Dev/unpackaged builds: everything no-ops (existing guard style).
- Do not touch `electron-builder.azure.yml` (IN-81 signing config, already landed).

---

### Task 1: Pure idle-gate module

**Files:**
- Create: `src/main/update-gate.ts`
- Test: `scripts/verify-update-gate.ts` (Task 2 runs it)

The predicate is pure — no Electron imports — so the verify script can pin its truth table under plain Node.

- [ ] **Step 1: Write `src/main/update-gate.ts`**

```ts
// IN-469: decides when a downloaded update may auto-install. Pure logic —
// no Electron imports — so verify-update-gate.ts can pin the truth table.

export const AUTO_RECORD_LEAD_MS = 15 * 60_000
/** Small look-back so the instant around a meeting's start (before the
 * auto-start dispatch flips pendingAutoStart) still blocks. Starts older
 * than this are NOT imminent — a recording in progress is caught by
 * recordingState/pendingAutoStart, and without a lower bound a stale past
 * start would block installs forever (plan-review finding #1). */
export const AUTO_RECORD_GRACE_MS = 2 * 60_000
export const SYSTEM_IDLE_MIN_SECONDS = 300
export const SNOOZE_MS = 4 * 60 * 60_000
export const COUNTDOWN_SECONDS = 60

export interface UpdateGateInput {
  updateDownloaded: boolean
  /** recording-state machine state; anything but 'idle' blocks. */
  recordingState: string
  /** recording-ipc has an auto-start handed to the renderer, unacked or active. */
  pendingAutoStart: boolean
  /** Next auto-record-eligible meeting start (UTC ms), null when none known. */
  nextAutoRecordStartUtcMs: number | null
  /** Any backend meeting still in pending_audio (young), queued, or processing. */
  backendBusy: boolean
  systemIdleSeconds: number
  /** Deferral expiry (UTC ms), 0 when never deferred. */
  snoozedUntilUtcMs: number
  nowUtcMs: number
}

export type UpdateGateVerdict =
  | { allow: true }
  | { allow: false; reason: string }

export function evaluateUpdateGate(input: UpdateGateInput): UpdateGateVerdict {
  if (!input.updateDownloaded) return { allow: false, reason: 'no_update_downloaded' }
  if (input.recordingState !== 'idle') return { allow: false, reason: 'recording_active' }
  if (input.pendingAutoStart) return { allow: false, reason: 'auto_start_pending' }
  if (input.nextAutoRecordStartUtcMs !== null) {
    const untilStart = input.nextAutoRecordStartUtcMs - input.nowUtcMs
    // Bounded window: a stale PAST start must not block forever.
    if (untilStart <= AUTO_RECORD_LEAD_MS && untilStart >= -AUTO_RECORD_GRACE_MS) {
      return { allow: false, reason: 'auto_record_imminent' }
    }
  }
  if (input.backendBusy) return { allow: false, reason: 'backend_processing' }
  if (input.systemIdleSeconds < SYSTEM_IDLE_MIN_SECONDS) {
    return { allow: false, reason: 'user_active' }
  }
  if (input.nowUtcMs < input.snoozedUntilUtcMs) return { allow: false, reason: 'snoozed' }
  return { allow: true }
}

/** Meetings in these pipeline states mean work is in flight. pending_audio
 * only counts while young — an ancient stuck pending_audio meeting must not
 * block updates forever. */
export const BUSY_PIPELINE_STATUSES = new Set(['queued', 'processing'])
export const PENDING_AUDIO_BUSY_WINDOW_MS = 30 * 60_000

export function isBackendBusy(
  meetings: Array<{ pipeline_status: string; created_at: string }>,
  nowUtcMs: number
): boolean {
  return meetings.some((m) => {
    if (BUSY_PIPELINE_STATUSES.has(m.pipeline_status)) return true
    if (m.pipeline_status !== 'pending_audio') return false
    const created = Date.parse(m.created_at)
    return Number.isFinite(created) && nowUtcMs - created <= PENDING_AUDIO_BUSY_WINDOW_MS
  })
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (module has no consumers yet).

- [ ] **Step 3: Commit**

```bash
git add src/main/update-gate.ts
git commit -m "feat: pure idle-gate predicate for auto-update (IN-469)"
```

### Task 2: verify:update-gate truth-table script

**Files:**
- Create: `scripts/verify-update-gate.ts`
- Modify: `package.json` (scripts block)

Mirror the harness style of `scripts/verify-backend-supervisor.ts` (assert
helper + process.exit(1) on failure + final pass message).

- [ ] **Step 1: Write `scripts/verify-update-gate.ts`**

Cases (one assertion each, use a helper `base()` returning an all-clear
input and spread overrides):

1. all-clear → `{ allow: true }`
2. `updateDownloaded: false` → reason `no_update_downloaded`
3. `recordingState: 'recording'` → `recording_active`; also `'processing'`
   blocks (the real `RecordingState` union is `'idle' | 'recording' |
   'processing'` — pause is a separate flag, and a paused recording is state
   `'recording'`, so non-idle covers it)
4. `pendingAutoStart: true` → `auto_start_pending`
5. next auto-record in 14 min → `auto_record_imminent`; in 16 min → allowed;
   started 1 min ago (within grace) → `auto_record_imminent`; started 30 min
   ago → **allowed** (regression case for the stale-past-start bug: without
   the lower bound this blocked forever)
6. `backendBusy: true` → `backend_processing`
7. `systemIdleSeconds: 299` → `user_active`; `300` → allowed
8. snoozed until now+1ms → `snoozed`; snooze expired → allowed
9. priority: recording beats snooze (recording + snoozed → `recording_active`)
10. `isBackendBusy`: `queued` busy; `processing` busy; `ready`/`failed` not;
    `pending_audio` aged 29 min busy; aged 31 min not; malformed
    `created_at` not busy
11. countdown/snooze arithmetic: `SNOOZE_MS === 4h`, `COUNTDOWN_SECONDS === 60`
    (pins the spec numbers so a silent constant edit fails loudly)

Scope note: the spec's testing section also lists "placeholder-URL publish
gating" — that logic is inline pwsh in the workflow (Task 7) and is
deliberately NOT covered by this Node script; it is exercised by the YAML
check plus the first real tag run. This narrowing is intentional.

- [ ] **Step 2: Add the npm script**

In `package.json` scripts, following the existing verify pattern exactly:

```json
"verify:update-gate": "esbuild scripts/verify-update-gate.ts --bundle --platform=node --format=cjs --outfile=out/verify-update-gate.cjs --log-level=error && node out/verify-update-gate.cjs"
```

- [ ] **Step 3: Run it — expect PASS**

Run: `npm run verify:update-gate`
Expected: all cases pass, final "Update gate verification passed".
(If any fail, fix `update-gate.ts` — the truth table is the spec.)

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-update-gate.ts package.json
git commit -m "test: pin IN-469 idle-gate truth table"
```

### Task 3: Expose the pending/imminent auto-start seams

**Files:**
- Modify: `src/main/recording-ipc.ts` (add exported accessor)
- Modify: `src/main/index.ts` (track next eligible auto-record start)

- [ ] **Step 1: In `recording-ipc.ts`, export a read-only accessor**

Next to the module-level `pendingAutoStart` slot (~line 84):

```ts
export function hasPendingAutoStart(): boolean {
  return pendingAutoStart !== null
}
```

- [ ] **Step 2: In `index.ts`, track the next auto-record start**

`handleAutoRecordEligible(decisions)` (~line 113) already receives
auto-record-eligible decisions with `startUtc` — an ISO **string**: store
`Date.parse(startUtc)` (ms), never the string. Add a module-level
`let nextAutoRecordStartUtcMs: number | null = null`, updated inside that
handler to the earliest parsed start among eligible candidate decisions.
IMPORTANT (plan-review finding #1): the runtime only invokes this callback
when there ARE eligible decisions (`graph/runtime.ts` guards on
`autoRecordEligible.length > 0`), so this tracker can go stale and is NEVER
reset to null here — staleness is neutralised by the predicate's bounded
window (`-AUTO_RECORD_GRACE_MS..AUTO_RECORD_LEAD_MS`), which is why that
lower bound is not optional. Pass a closure into the updater in Task 5
(no new export surface).

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck` → PASS

```bash
git add src/main/recording-ipc.ts src/main/index.ts
git commit -m "feat: expose pending/imminent auto-start seams for the update gate (IN-469)"
```

### Task 4: Backend busy probe

**Files:**
- Modify: `src/main/updater.ts` (probe lives with its consumer)

- [ ] **Step 1: Add the probe**

```ts
async function fetchBackendBusy(getActor: () => string): Promise<boolean> {
  const actor = getActor()
  // Fail-open guard (plan review): list_meetings filters by can_see(actor).
  // An unauthenticated/default actor gets an EMPTY list — which would read
  // as "not busy" while work may be in flight. Can't prove quiet → busy.
  if (!actor || actor === 'Unknown user') return true
  try {
    const res = await fetch('http://127.0.0.1:8787/api/v1/meetings', {
      headers: { 'X-MN-User': actor },
      signal: AbortSignal.timeout(5_000)
    })
    if (!res.ok) return true // can't prove quiet — fail safe, block install
    const meetings = (await res.json()) as Array<{ pipeline_status: string; created_at: string }>
    return isBackendBusy(meetings, Date.now())
  } catch {
    return true // backend unreachable mid-restart etc. — block install this cycle
  }
}
```

Response shape verified during plan review: `GET /api/v1/meetings` returns a
top-level array of `Meeting` objects including `pipeline_status` and
`created_at`; `X-MN-User` is the only header needed. Confirm the exact
default-actor sentinel used by `getCurrentUser()` in `auth-session.ts`
("Unknown user" per the api-proxy convention) when wiring the guard.

- [ ] **Step 2: Typecheck + commit** (compiles as dead code until Task 5)

```bash
git add src/main/updater.ts
git commit -m "feat: backend pipeline busy probe for the update gate (IN-469)"
```

### Task 5: Updater lifecycle rework

**Files:**
- Modify: `src/main/updater.ts` (main rework)
- Modify: `src/main/index.ts` (pass dependencies; argv handling)
- Modify: `src/main/tray.ts` (restart menu item)
- Modify: `src/main/toast-xml.ts` (update toast builders)

- [ ] **Step 1: Rework `updater.ts` initialisation**

Replace `checkForUpdatesOnLaunch()` with
`startUpdaterLifecycle(deps: UpdaterDeps)` where

```ts
export interface UpdaterDeps {
  getRecordingState: () => string
  hasPendingAutoStart: () => boolean
  getNextAutoRecordStartUtcMs: () => number | null
  getActor: () => string
  onUpdateReady: (version: string) => void // tray + toast surfacing
}
```

Behaviour:
- packaged-only guard (existing style); dev logs and returns.
- launch check + 4h `setInterval`, both `autoUpdater.checkForUpdates()`
  with the existing catch-and-log (feed unreachable is a warning, never an
  error surface).
- `autoUpdater.on('update-downloaded', info)` → store
  `downloadedVersion`, call `deps.onUpdateReady(info.version)`, start the
  5-minute idle poll (`setInterval`).
- Idle poll: assemble `UpdateGateInput` (recording state, pending
  auto-start, next auto-record, `await fetchBackendBusy(deps.getActor)`,
  `powerMonitor.getSystemIdleTime()`, snooze state, `Date.now()`), call
  `evaluateUpdateGate`. Log the verdict reason on every block at debug
  level, and on transition to allow.
- On allow → show countdown toast (Step 3) and arm a 60s timer; timer
  expiry → re-evaluate the gate ONCE more (a recording may have started
  during the countdown) → if still allowed, log
  `[updater] installing update` and `autoUpdater.quitAndInstall(true, true)`.
- `deferUpdate()` (from toast button or tray) → `snoozedUntilUtcMs =
  Date.now() + SNOOZE_MS`, cancel countdown.
- `restartNowRequested()` (tray/toast) → evaluate gate but IGNORE
  `user_active`/`snoozed` reasons (explicit intent) — recording/auto-start/
  backend reasons still block, with a toast explaining why
  ("Recording in progress — the update will install later."). NOTE: blocking
  on `backend_processing` here is a deliberate, agreed deviation from the
  spec's "conditions (2)–(3) only" wording — no restart path may interrupt
  in-flight processing. Do not "fix" this toward the spec.
- Keep `registerUpdaterIpc` (manual check) as is, but after a manual check
  reports `downloaded`, the same lifecycle applies.

- [ ] **Step 2: Tray surface (`tray.ts`)**

Add module state `updateReadyVersion: string | null` +
`export function setUpdateReady(version: string | null): void` following the
`setTrayAlert` pattern; when set, `updateTrayMenu()` includes
`{ label: `Restart to update to ${version}`, click: () => restartNowRequested() }`.
Import from `updater.ts` (check for require cycles — tray.ts must not be
imported by updater.ts; pass `restartNowRequested` in via a setter if it is).

- [ ] **Step 3: Toasts (`toast-xml.ts` + updater)**

Follow the `buildEndingSoonToastXml` pattern + the existing toast-button
argv convention (grep `mn-extend` for the handler and registration):

- `buildUpdateReadyToastXml(version)` — body "Update x.y.z is ready." with
  buttons "Restart now" (`arguments="mn-update-restart"`) and "Later"
  (`arguments="mn-update-defer"`).
- `buildUpdateCountdownToastXml(version, seconds)` — "Restarting to update
  in 60 seconds…" with button "Not now" (`mn-update-defer`).
- Wire `mn-update-restart` / `mn-update-defer` argv handling exactly where
  `mn-extend` is handled (second-instance/argv parse in `index.ts`).

- [ ] **Step 4: Wire it in `index.ts`**

Replace the `checkForUpdatesOnLaunch()` call with
`startUpdaterLifecycle({...})` passing: the recording state machine's
`getState`, `hasPendingAutoStart` (Task 3), the next-auto-record closure
(Task 3), `getCurrentUser` from auth-session, and an `onUpdateReady` that
calls `setUpdateReady(version)` + shows the update-ready toast.

- [ ] **Step 5: Gates**

Run: `npm run typecheck` → PASS
Run: `npm run verify:update-gate` → PASS
Run: `npm run build` → PASS
Manual note for the handback: main-process change — needs full dev restart;
in dev everything no-ops but startup must be clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/updater.ts src/main/index.ts src/main/tray.ts src/main/toast-xml.ts
git commit -m "feat: tray-aware restart prompt and idle auto-install (IN-469)"
```

### Task 6: electron-builder config

**Files:**
- Modify: `electron-builder.yml`

- [ ] **Step 1: Add `publisherName` under `win:`**

```yaml
win:
  publisherName: factor1.com.au
```

(electron-updater refuses a downloaded installer whose Authenticode CN
mismatches; Private Trust root exists on the managed fleet. `publish.url`
stays `REPLACE_ME` until DV returns the real feed URL — that swap is a
follow-up one-liner, not this plan.)

- [ ] **Step 2: Local packaging smoke**

Run: `npx electron-vite build && npx electron-builder --dir` → completes,
signing skipped (unsigned base config unaffected by publisherName).

- [ ] **Step 3: Commit**

```bash
git add electron-builder.yml
git commit -m "feat: verify update signatures against the factor1 publisher (IN-469)"
```

### Task 7: CI publish step

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Replace the commented-out publish block**

After the "Assert credentials shipped in packaged output" step:

```yaml
      - name: Publish to Blob update feed (IN-469)
        # Self-skips until the updates feed is provisioned: the publish URL
        # in electron-builder.yml still being the REPLACE_ME placeholder
        # means DV's container/role grant has not landed yet.
        shell: pwsh
        run: |
          $config = Get-Content electron-builder.yml -Raw
          if ($config -match 'REPLACE_ME') {
            Write-Warning "Update feed not provisioned (publish.url placeholder) - skipping publish. Installer is only a workflow artifact."
            exit 0
          }
          $exe = (Get-ChildItem "dist\*setup.exe" | Select-Object -First 1).FullName
          az storage blob upload --auth-mode login --overwrite `
            --account-name $env:UPDATES_STORAGE_ACCOUNT --container-name updates `
            --file $exe --name (Split-Path $exe -Leaf)
          az storage blob upload --auth-mode login --overwrite `
            --account-name $env:UPDATES_STORAGE_ACCOUNT --container-name updates `
            --file dist\latest.yml --name latest.yml
        env:
          UPDATES_STORAGE_ACCOUNT: ${{ vars.UPDATES_STORAGE_ACCOUNT }}
```

Two `az storage blob upload` calls, NOT `upload-batch` (single-pattern
trap per spec). `UPDATES_STORAGE_ACCOUNT` is a repo VARIABLE (non-secret),
set when DV names the account. Also delete the stale commented-out
`AZURE_STORAGE_CONNECTION_STRING` block and the "Still pending" header
lines it referenced; note the new mechanism in the header comment.

- [ ] **Step 2: YAML syntax check**

Run: `node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/release.yml','utf8')); console.log('OK')"` → OK

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: publish signed releases to the Blob update feed (IN-469)"
```

### Task 8: Ledger + final gates

**Files:**
- Modify: `docs/jira-progress.md`

- [ ] **Step 1: Add an IN-469 ledger entry** under the open-items section:
implementation summary (gate conditions, silent install, self-skipping
publish), evidence (verify:update-gate case count, gates), and the two
outstanding externals (DV container + role grant + feed URL swap +
`UPDATES_STORAGE_ACCOUNT` variable; live 2.0.x→2.0.y E2E after that).

- [ ] **Step 2: Full gate sweep**

Run: `npm run typecheck && npm run verify:update-gate && npm run verify:recording-controls && npm run build`
Expected: all PASS. Backend suite untouched by this plan — run
`python -m unittest discover` from `backend/` (with `.env` parked) once to
prove no accidental coupling: 296 tests OK (1 known env-sensitive flake
possible).

- [ ] **Step 3: Commit**

```bash
git add docs/jira-progress.md
git commit -m "docs: record IN-469 implementation evidence"
```

---

## Out of plan (tracked, not forgotten)

- Feed URL swap (`publish.url`) + `UPDATES_STORAGE_ACCOUNT` repo variable —
  one commit when DV returns the URL.
- Live E2E: signed 2.0.x manual install → tag 2.0.y → observe detect /
  download / verify / prompt / idle-install / relaunch. Work machine, after
  provisioning.
- Jira transition of IN-469 — Joseph.
