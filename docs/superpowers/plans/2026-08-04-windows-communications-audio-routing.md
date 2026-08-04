# Windows Communications Audio Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Notetaker follow Windows communications audio devices across Bluetooth changes, recover silent streams, and clearly report active or mismatched routing.

**Architecture:** A small Rust helper polls the documented Windows Core Audio default endpoints and emits versioned JSONL snapshots. Electron supervises the helper and forwards sanitized state through preload; the renderer resolves the communications microphone to a Chromium input, preserves the existing MediaRecorder bridge/loopback segmentation, and falls back to browser device events when native monitoring is unavailable.

**Tech Stack:** Electron 33, TypeScript, React, Chromium MediaDevices/Web Audio/MediaRecorder, Rust 2021 with `windows` 0.62 and `serde`, electron-builder, GitHub Actions.

---

### Task 1: Shared endpoint protocol and main-process parser

**Files:**
- Create: `src/shared/audio-endpoints.ts`
- Create: `src/main/audio-endpoint-protocol.ts`
- Create: `scripts/verify-audio-endpoint-protocol.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing protocol fixture**

Create a fixture that imports the wished-for `parseAudioEndpointLine`, feeds one valid v1 snapshot and malformed/unknown-schema lines, and asserts:

```ts
const parsed = parseAudioEndpointLine(JSON.stringify({
  schemaVersion: 1,
  kind: 'snapshot',
  generation: 3,
  endpoints: {
    captureConsole: { id: 'cap-console', label: 'Microphone Array' },
    captureCommunications: { id: 'cap-comms', label: 'Headset Microphone' },
    renderConsole: { id: 'render-console', label: 'Speakers' },
    renderCommunications: { id: 'render-comms', label: 'Headphones' }
  }
}))
assert.equal(parsed?.generation, 3)
assert.equal(parsed?.endpoints.captureCommunications?.label, 'Headset Microphone')
assert.equal(parseAudioEndpointLine('{bad json'), null)
assert.equal(parseAudioEndpointLine('{"schemaVersion":2}'), null)
```

- [ ] **Step 2: Run the fixture and verify RED**

Run: `npx esbuild scripts/verify-audio-endpoint-protocol.ts --bundle --platform=node --format=cjs --outfile=out/verify-audio-endpoint-protocol.cjs --log-level=error && node out/verify-audio-endpoint-protocol.cjs`

Expected: build failure because `src/main/audio-endpoint-protocol.ts` does not exist.

- [ ] **Step 3: Implement strict shared types and parser**

Define `AudioEndpoint`, `AudioEndpointSet`, and `AudioEndpointSnapshot` in the shared file. Implement a parser that returns `null` unless schema version, kind, finite non-negative generation, endpoint object, nullable endpoint IDs, and labels have valid types. Do not throw on helper output.

- [ ] **Step 4: Add and run `verify:audio-endpoint-protocol`**

Run: `npm run verify:audio-endpoint-protocol`

Expected: `Audio endpoint protocol verification passed`.

- [ ] **Step 5: Commit**

```powershell
git add package.json src/shared/audio-endpoints.ts src/main/audio-endpoint-protocol.ts scripts/verify-audio-endpoint-protocol.ts
git commit -m "test: define Windows audio endpoint protocol"
```

### Task 2: Windows Core Audio endpoint helper

**Files:**
- Create: `native/audio-endpoint-monitor/Cargo.toml`
- Create: `native/audio-endpoint-monitor/src/lib.rs`
- Create: `native/audio-endpoint-monitor/src/main.rs`
- Create: `native/audio-endpoint-monitor/tests/protocol.rs`
- Generate: `native/audio-endpoint-monitor/Cargo.lock`

- [ ] **Step 1: Write failing Rust change-detection tests**

Define tests against a wished-for `SnapshotEmitter` that require an initial
snapshot, suppress identical endpoint sets, and increment generation exactly
once when any role changes:

```rust
#[test]
fn emits_only_when_endpoint_ids_change() {
    let mut emitter = SnapshotEmitter::default();
    let first = endpoint_set("capture-a", "render-a");
    assert_eq!(emitter.observe(first.clone()).unwrap().generation, 1);
    assert!(emitter.observe(first).is_none());
    assert_eq!(emitter.observe(endpoint_set("capture-b", "render-a")).unwrap().generation, 2);
}
```

- [ ] **Step 2: Run the Rust test and verify RED**

Run: `cargo test --manifest-path native/audio-endpoint-monitor/Cargo.toml`

Expected: compilation failure because `SnapshotEmitter` is absent.

- [ ] **Step 3: Implement the pure protocol core**

Use serializable structs matching Task 1 exactly. `SnapshotEmitter::observe`
compares endpoint IDs, starts generation at 1, and returns owned snapshots.

- [ ] **Step 4: Implement the Windows provider and polling binary**

Initialize COM once, create `MMDeviceEnumerator`, call
`GetDefaultAudioEndpoint` for `eCapture/eRender` ×
`eConsole/eCommunications`, obtain `IMMDevice::GetId`, and read
`PKEY_Device_FriendlyName` from `IPropertyStore`. Treat an absent endpoint as
`null`. Poll every 750 ms and flush one JSON line only when `SnapshotEmitter`
returns a change. Emit structured errors to stderr without terminating the loop.

- [ ] **Step 5: Verify helper tests and a live snapshot**

Run:

```powershell
cargo test --manifest-path native/audio-endpoint-monitor/Cargo.toml
cargo build --release --manifest-path native/audio-endpoint-monitor/Cargo.toml
$p = Start-Process -FilePath native\audio-endpoint-monitor\target\release\notetaker-audio-endpoints.exe -NoNewWindow -PassThru -RedirectStandardOutput out\audio-endpoints.jsonl
Start-Sleep -Seconds 2
Stop-Process -Id $p.Id
Get-Content out\audio-endpoints.jsonl | Select-Object -First 1
```

Expected: Rust tests pass and the first line parses as the v1 snapshot.

- [ ] **Step 6: Commit**

```powershell
git add native/audio-endpoint-monitor
git commit -m "feat: observe Windows communications audio endpoints"
```

### Task 3: Electron helper supervision and IPC

**Files:**
- Create: `src/main/audio-endpoint-service.ts`
- Create: `scripts/verify-audio-endpoint-service.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing service fixture**

Use injected `spawnHelper`, timers, and broadcaster functions. Assert that the
service retains the newest snapshot, ignores malformed lines, broadcasts only
new generations, restarts once after an unexpected exit, and kills the child on
`stop()`.

- [ ] **Step 2: Run fixture and verify RED**

Run: `npx esbuild scripts/verify-audio-endpoint-service.ts --bundle --platform=node --format=cjs --outfile=out/verify-audio-endpoint-service.cjs --log-level=error && node out/verify-audio-endpoint-service.cjs`

Expected: build failure because `AudioEndpointService` is absent.

- [ ] **Step 3: Implement service and helper path resolution**

Resolve packaged helper from
`process.resourcesPath/audio/notetaker-audio-endpoints.exe`; in development,
resolve the Rust release binary under the repository. Spawn hidden with piped
stdout/stderr, parse complete JSONL lines, cap an unterminated buffer at 64 KiB,
restart once after 1 second, and degrade without crashing if unavailable.

- [ ] **Step 4: Register IPC and lifecycle**

Add `audio-endpoints:get` and broadcast `audio-endpoints:changed`. Start after
`app.whenReady`, stop in `before-quit`, and ensure a losing second instance does
not start the helper.

- [ ] **Step 5: Expose preload APIs**

Add:

```ts
getAudioEndpointSnapshot: (): Promise<AudioEndpointSnapshot | null> =>
  ipcRenderer.invoke('audio-endpoints:get'),
onAudioEndpointChanged: (callback) => {
  const handler = (_event, snapshot) => callback(snapshot)
  ipcRenderer.on('audio-endpoints:changed', handler)
  return () => ipcRenderer.removeListener('audio-endpoints:changed', handler)
}
```

- [ ] **Step 6: Verify service, preload typing, and typecheck**

Run:

```powershell
npm run verify:audio-endpoint-service
npm run typecheck:node
```

Expected: fixture passes and TypeScript reports no errors.

- [ ] **Step 7: Commit**

```powershell
git add package.json src/main/audio-endpoint-service.ts src/main/index.ts src/preload/index.ts src/preload/index.d.ts scripts/verify-audio-endpoint-service.ts
git commit -m "feat: supervise Windows audio endpoint monitor"
```

### Task 4: Explicit routing preferences and Chromium device resolution

**Files:**
- Create: `src/renderer/src/lib/audioRouting.ts`
- Create: `scripts/verify-audio-routing.ts`
- Modify: `src/renderer/src/lib/prefs.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing preference/resolution fixture**

Cover legacy empty and non-empty `micDeviceId` migration, exact unique friendly
label matching, case/whitespace normalization, ambiguous-match fallback, and
manual pinned-device lookup.

- [ ] **Step 2: Run fixture and verify RED**

Run: `npx esbuild scripts/verify-audio-routing.ts --bundle --platform=node --format=cjs --outfile=out/verify-audio-routing.cjs --log-level=error && node out/verify-audio-routing.cjs`

Expected: build failure because routing types/functions are absent.

- [ ] **Step 3: Implement versioned preferences**

Use:

```ts
export type MicRoutingMode = 'follow_communications' | 'pinned'
export interface Prefs {
  version: 2
  micRoutingMode: MicRoutingMode
  pinnedMicDeviceId: string
  language: string
}
```

Legacy values migrate to `follow_communications`; a non-empty legacy ID is
retained in `pinnedMicDeviceId` as the last manual choice.

- [ ] **Step 4: Implement route resolution**

`resolveMicRoute(prefs, nativeSnapshot, devices)` returns constraints, routing
mode, active target label, and degraded reason. A unique normalized label match
uses `{ deviceId: { exact: id } }`; missing/ambiguous native matches use
`audio: true` with a reason.

- [ ] **Step 5: Verify fixture and web typecheck**

Run:

```powershell
npm run verify:audio-routing
npm run typecheck:web
```

- [ ] **Step 6: Commit**

```powershell
git add package.json src/renderer/src/lib/audioRouting.ts src/renderer/src/lib/prefs.ts scripts/verify-audio-routing.ts
git commit -m "feat: add communications-device routing preferences"
```

### Task 5: Capture switching and one-shot silence recovery

**Files:**
- Modify: `src/renderer/src/lib/capture.ts`
- Modify: `src/renderer/src/App.tsx`
- Modify: `scripts/verify-recording-controls.tsx`
- Modify: `scripts/verify-capture-segments.tsx`

- [ ] **Step 1: Add failing pinned-reappearance fixture**

Start pinned capture while the pinned device is absent, verify fallback is
acquired, make the pinned device appear, dispatch a change, and require the
exact pinned stream to replace the fallback without restarting MediaRecorder.

- [ ] **Step 2: Add failing native endpoint and silence-recovery fixtures**

Require capture-native changes to reacquire the microphone, render-native
changes to segment loopback, duplicate native/browser signals to coalesce, and
each silence watchdog to trigger at most one reacquisition per generation and
cooldown.

- [ ] **Step 3: Run fixtures and verify RED**

Run:

```powershell
npm run verify:recording-controls
npm run verify:capture
```

Expected: new assertions fail because endpoint subscriptions and recovery are
not implemented.

- [ ] **Step 4: Change `CaptureController.start` to accept a route object**

Pass `MicRoute` plus optional native snapshot instead of a bare device ID.
Retain the actual track settings/label in `CaptureStatus`; expose switching,
fallback, recovery, and render-mismatch fields without changing MediaRecorder
ownership.

- [ ] **Step 5: Implement correct pinned comparison and native subscriptions**

Only keep a live pinned stream when its actual device ID/group corresponds to
the requested pinned device. Subscribe on start, unsubscribe on stop/release,
and feed native capture/render generations into the existing cancellation and
debounce guards.

- [ ] **Step 6: Implement bounded silence recovery**

Mic silence after 8 seconds requests one microphone reacquisition; loopback
silence after 60 seconds requests one segmented reacquisition. Store last
attempt generation/time, apply a 30-second cooldown, and never await recovery
from pause/stop controls.

- [ ] **Step 7: Update App capture calls**

Load preferences, fetch the current native snapshot, enumerate audio inputs,
resolve the route, and call the new capture API for automatic and manual starts.

- [ ] **Step 8: Verify GREEN and typechecks**

Run:

```powershell
npm run verify:recording-controls
npm run verify:capture
npm run typecheck
```

- [ ] **Step 9: Commit**

```powershell
git add src/renderer/src/lib/capture.ts src/renderer/src/App.tsx scripts/verify-recording-controls.tsx scripts/verify-capture-segments.tsx
git commit -m "fix: follow audio endpoints through Bluetooth changes"
```

### Task 6: Settings and recording-route UI

**Files:**
- Modify: `src/renderer/src/screens/SettingsScreen.tsx`
- Modify: `src/renderer/src/screens/RecordingScreen.tsx`
- Create: `scripts/verify-audio-routing-ui.tsx`
- Modify: `package.json`

- [ ] **Step 1: Write failing static UI fixture**

Require Settings to render the recommended follow mode, manual pinned mode,
current native labels, Teams/system-default guidance, and mismatch warning.
Require RecordingScreen to name actual active endpoints and show switching,
fallback, and post-recovery-silence messages.

- [ ] **Step 2: Run fixture and verify RED**

Run: `npx esbuild scripts/verify-audio-routing-ui.tsx --bundle --platform=node --format=cjs --tsconfig=tsconfig.web.json --outfile=out/verify-audio-routing-ui.cjs --log-level=error && node out/verify-audio-routing-ui.cjs`

Expected: assertions fail because the labels and controls are absent.

- [ ] **Step 3: Implement live Settings routing UI**

Subscribe to native endpoint changes and browser `devicechange`, refresh inputs,
persist explicit mode changes, show the current communications mic/default
speaker, and warn when console/communications render IDs differ.

- [ ] **Step 4: Implement compact recording labels and warnings**

Extend existing level-meter rows with active labels and sentence-case status.
Keep the compact flat design, light/dark tokens, 400/500 weights, and audio-only
affordances.

- [ ] **Step 5: Verify fixture and build**

Run:

```powershell
npm run verify:audio-routing-ui
npm run typecheck
npm run build
```

- [ ] **Step 6: Commit**

```powershell
git add package.json src/renderer/src/screens/SettingsScreen.tsx src/renderer/src/screens/RecordingScreen.tsx scripts/verify-audio-routing-ui.tsx
git commit -m "feat: show active Windows audio routing"
```

### Task 7: Package, build, and sign the endpoint helper

**Files:**
- Modify: `package.json`
- Modify: `electron-builder.yml`
- Modify: `electron-builder.azure.yml`
- Modify: `.github/workflows/release.yml`
- Create: `scripts/verify-audio-helper-package.ps1`

- [ ] **Step 1: Write failing packaging verification**

The script must fail unless the release helper exists, builder resources map it
to `resources/audio/notetaker-audio-endpoints.exe`, and a packaged directory
contains that executable.

- [ ] **Step 2: Run script and verify RED**

Run: `powershell -ExecutionPolicy Bypass -File scripts/verify-audio-helper-package.ps1 -SkipPackagedCheck`

Expected: failure because builder resource mapping is absent.

- [ ] **Step 3: Add build and packaging configuration**

Add `build:audio-helper` and make `package:dir` build the release helper first.
Add `extraResources` in both builder configs. Keep the helper out of ASAR and
under the service's exact packaged path.

- [ ] **Step 4: Add CI helper build and signature checks**

Install/pin the stable Rust toolchain in the Windows release job, run Cargo
tests/build, and verify the unpacked helper exists before installer creation.
After Azure Artifact Signing, use `Get-AuthenticodeSignature` on both the app
and helper executable and require `Status -eq 'Valid'`.

- [ ] **Step 5: Verify local packaged directory**

Run:

```powershell
npm run build:audio-helper
npm run package:dir
powershell -ExecutionPolicy Bypass -File scripts/verify-audio-helper-package.ps1
```

Expected: unpacked helper exists. Local signature is allowed to be unsigned;
the CI path requires a valid Azure signature.

- [ ] **Step 6: Commit**

```powershell
git add package.json electron-builder.yml electron-builder.azure.yml .github/workflows/release.yml scripts/verify-audio-helper-package.ps1
git commit -m "build: package Windows audio endpoint monitor"
```

### Task 8: Documentation, complete verification, and handoff

**Files:**
- Modify: `docs/jira-progress.md`
- Modify: `docs/azure-setup.md`
- Modify: `docs/superpowers/plans/2026-08-04-windows-communications-audio-routing.md`

- [ ] **Step 1: Document operational behaviour**

Record the Windows/Teams same-endpoint requirement, routing modes, degraded
fallback, helper packaging path, log messages, and the packaged hardware test
matrix. Do not mark live Bluetooth acceptance passed without running it.

- [ ] **Step 2: Mark completed plan checkboxes and run all repository gates**

Run:

```powershell
cargo test --manifest-path native/audio-endpoint-monitor/Cargo.toml
npm run verify:graph
npm run verify:recording-controls
npm run verify:capture
npm run verify:audio-endpoint-protocol
npm run verify:audio-endpoint-service
npm run verify:audio-routing
npm run verify:audio-routing-ui
npm run typecheck
npm run build
$env:PYTHONPATH='backend'; & 'C:\Projects\meeting-notetaker-2\backend\.venv\Scripts\python.exe' -m unittest discover -s backend/tests -t backend -v
git diff --check
git status --short
```

Expected: all new Rust/TypeScript checks, typechecks, and build pass. Report the
pre-existing backend stub-history collision separately if it remains the only
backend failure; do not represent the backend suite as green.

- [ ] **Step 3: Commit evidence**

```powershell
git add docs/jira-progress.md docs/azure-setup.md docs/superpowers/plans/2026-08-04-windows-communications-audio-routing.md
git commit -m "docs: record Windows audio routing evidence"
```

- [ ] **Step 4: Perform packaged hardware acceptance before Jira closure**

Run the eight scenarios from the design on the signed installer and attach
sanitized endpoint-transition logs. Any silent stream, missed transition,
unresponsive control, or Teams/default mismatch without a visible warning
keeps the acceptance item open.

