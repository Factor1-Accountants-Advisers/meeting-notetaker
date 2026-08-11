# Staged re-land of Windows audio routing — v2.0.21 "observe + safety net"

**Date:** 2026-08-11
**Status:** Approved (design), pending implementation
**Prior art:** `docs/superpowers/specs/2026-08-04-windows-communications-audio-routing-design.md` (at tag `v2.0.17`), reverted by `4f266df`.

## Context

Mid-recording Windows audio-device switches (Bluetooth headset connects, Teams
claiming a headset) still break the microphone capture. IN-468 fixed the
system-audio half (segmented loopback re-acquisition, shipped `afd105d`); the
mic device-follow bridge (`d0f4fe3`, v2.0.15) helps but falls back silently to
the vulnerable direct-recording mode when the AudioContext bridge cannot be
built. A full fix — native observation of Windows communications endpoints and
active mic routing — was attempted 4 Aug (v2.0.16–2.0.17, range
`49cf6d8..c0c7fbc`), shipped within two hours of first commit, and was rolled
forward to v2.0.18 the same afternoon.

Post-mortem of the reverted work (11 Aug) found the field failures were not in
the native observer but in the code that *acted* on its data:

1. Silence watchdogs were converted from warnings into forced stream teardown:
   8 s of quiet mic (a user muted in Teams) tore down and rebuilt the mic
   source; 60 s of remote silence forced a loopback restart and audio segment
   split. The per-generation recovery gate defeats itself during Bluetooth
   devicechange bursts.
2. The Windows↔Chromium bridge matches by normalized friendly-name label, but
   Chromium returns blank labels before a `getUserMedia` grant, so the matcher
   silently fell back to `audio: true` — Chromium's console default — which is
   the exact wrong-device bug the feature targeted.
3. `migratePrefs()` silently deactivated every user's explicitly pinned mic on
   auto-update.
4. Helper signing relied on an undocumented electron-builder 26 behaviour
   (filtered-directory `extraResources` copies pass the signing transformer;
   single-file mappings bypass it), asserted only by a regex over the YAML.
   The `from:` mapping walked the entire Cargo `target/release` tree.
5. The Rust toolchain and all verification fixtures ran only inside the
   tag-triggered release job; none of the renderer fixtures ran in CI. The
   v2.0.16 release run was the first execution and died at the signature
   assertion.
6. The one acceptance gate that mattered — live Bluetooth/Teams testing of the
   eight design scenarios on a signed installer — was never run (the single
   unchecked box in the plan).

The observer foundation itself was rated clean and re-landable: the Rust
endpoint monitor (correct COM lifetime, `CoTaskMemFree`, non-fatal per-endpoint
errors, 3 passing tests), the versioned stdout JSON protocol with a total
non-throwing validator, and the Electron supervisor (64 KiB bounded buffer,
monotonic re-stamped generations, one-shot restart policy).

## Decision

Re-land in two releases (approach approved 11 Aug):

- **v2.0.21 (this spec):** everything that observes; nothing that acts.
  Ships the dead-mic upload safety net, the observer foundation, dry-run
  telemetry, a read-only endpoint display, CI, and a redesigned signing step.
- **v2.0.22 (own spec later):** active mic routing, redesigned using v2.0.21
  fleet telemetry plus a live eight-scenario hardware acceptance pass.

## v2.0.21 scope

### 1. Dead-mic upload safety net (already implemented, uncommitted)

- `backend/app/routers/meetings.py`: a mic track under `MIN_AUDIO_BYTES`
  (1,000) with healthy system segments no longer 422s the upload. The backend
  drops the mic, stores/merges system audio alone (single segment at offset 0
  is stored directly without ffmpeg; multiple segments merge via
  `_build_segment_merge_filter(..., include_mic=False)`), stamps
  `recorder_audio_missing=True` at upload, and unlinks any stale
  `{id}.mic.webm` so the pipeline's silence probe cannot overwrite the flag.
  A tiny mic with no system segments still 422s ("Audio is too short").
- `src/main/api-proxy.ts`: non-OK backend responses log a 500-char excerpt of
  the response body, so report-problem emails carry error details.
- Covered by five new tests in `tests/test_system_segment_merge.py`, including
  a real-ffmpeg mic-less two-segment merge.

### 2. Observer foundation (restored from tag v2.0.17)

Restored as-is: `native/audio-endpoint-monitor/` (Cargo project, 750 ms
polling of the `{eCapture,eRender} × {eConsole,eCommunications}` matrix,
`SnapshotEmitter` dedupe + monotonic generation), `src/shared/audio-endpoints.ts`,
`src/main/audio-endpoint-protocol.ts`, `src/main/audio-endpoint-service.ts`,
and the `index.ts`/preload wiring (`audio-endpoints:get` handle,
`audio-endpoints:changed` broadcast, snapshot getter + subscribe in preload).

Two adaptations:

- The service starts only when `process.platform === 'win32'`.
- A missing helper binary (common in dev before `cargo build`) logs one
  warning and stops; no restart loop.

### 3. Dry-run telemetry (new)

Purpose: validate v2.0.22's matcher logic against the fleet before any of it
controls capture.

- A new renderer module `src/renderer/src/lib/audioRoutingDryRun.ts` contains
  the **redesigned** matcher: filters `enumerateDevices()` to
  `kind === 'audioinput'` excluding the `'default'` and `'communications'`
  pseudo-devices, normalizes labels, corroborates matches with `groupId`
  where possible, and classifies the outcome
  (`matched` / `labels_blank` / `no_match` / `ambiguous` / `no_snapshot`).
- On recording start and on each `audio-endpoints:changed` event while a
  recording is active, it logs one structured line via the existing
  `window.api.debugLog` (lands in main.log): endpoint snapshot labels/ids,
  whether Chromium labels were populated, the would-be match and outcome
  classification, and the active capture's current mic label for comparison.
- Capture behavior is untouched: `capture.start()` keeps its current
  signature; no prefs change; no stream is ever reacquired because of this
  module.

### 4. Read-only Settings display (restored subset)

From v2.0.17's SettingsScreen: the `EndpointValue` rows showing communications
mic/output and console defaults, the console-vs-communications mismatch note,
and the Teams "Computer audio" guidance. Explicitly not restored in this
release: the routing-mode radio, the pinned-mic picker, prefs `version: 2`
migration, and the RecordingScreen routing banners — all deferred to v2.0.22.

### 5. Packaging and signing (redesigned)

- `npm run build:audio-helper` builds the exe and stages it into a clean
  directory (`native/audio-endpoint-monitor/dist/`) containing only the exe;
  `electron-builder.yml` maps that directory via `extraResources`
  (directory mapping keeps electron-builder's signing transformer engaged,
  and electron-builder no longer walks the Cargo `target/` tree).
- `package.json` pins electron-builder to an exact version.
- The YAML-regex checker (`verify-audio-helper-package.ps1`) is not restored.
  In its place, the release workflow's post-package assertion runs
  `Get-AuthenticodeSignature` against all three exes (app, backend, helper)
  and fails the build on any that is unsigned — asserting the output, not the
  config shape.
- Release ritual unchanged: FIC subject PATCH per release, tag push, feed
  verification.

### 6. CI (new workflow)

`.github/workflows/ci.yml` on push and pull_request:

- `npm run typecheck:node` and `typecheck:web`
- the renderer verify fixtures restored with the observer
  (`verify:audio-endpoint-protocol`, `verify:audio-endpoint-service`) plus the
  new dry-run fixture
- `cargo test` for the helper (pinned toolchain, cargo cache)
- backend `python -m unittest discover` (the ~25 known environment-dependent
  failures are excluded or the job asserts no *new* failures relative to a
  recorded baseline; mechanism decided at implementation)

The release workflow keeps its build and signature gates but is no longer the
first executor of any test.

## Acceptance criteria (v2.0.21)

1. CI green: typechecks, fixtures, `cargo test`, backend suite per §6.
2. A local packaged build contains `resources/audio/notetaker-audio-endpoints.exe`;
   running it emits a real four-endpoint snapshot line.
3. The signed installer passes the three-exe `Get-AuthenticodeSignature`
   assertion in the release run.
4. Live smoke on the developer machine with the signed installer: record a
   short Teams call, connect a Bluetooth headset mid-recording; the recording
   completes and uploads unaffected, and main.log contains dry-run telemetry
   lines for the start snapshot and the mid-recording endpoint change.
5. A recording whose mic track is dead uploads successfully (system-only) and
   the meeting shows the recorder-audio-missing note.
6. Non-Windows/dev environments: app runs with no helper binary present, one
   log line, no restart spam.

## Out of scope (deferred to the v2.0.22 spec)

Active mic routing; prefs schema v2 and migration policy (existing pins stay
active); reacquisition triggered by endpoint-generation changes; the rule that
RMS silence warns but never tears down; the rule that `renderCommunications`
changes never touch loopback; RecordingScreen banners; the full eight-scenario
hardware acceptance matrix (it gates v2.0.22, not v2.0.21).

## Risks

- **Helper flakiness on fleet machines** (COM errors, AV quarantine of a new
  exe): mitigated by the one-shot restart policy, stderr logging, and the fact
  that nothing consumes the data for control — worst case is missing telemetry.
- **Installer size**: the helper added ~1 MB in v2.0.17's unpacked resources;
  the 162→213 MB bloat came from walking the Cargo target tree, which the
  staging directory eliminates. Assert installer size is within ~5 MB of
  v2.0.20's in the release checklist.
- **Cert-less machines** (e.g. Gabby's) silently ignore feed updates; her
  retry depends on this release reaching her. Coordinate with DV on the Intune
  root-cert profile or a manual over-the-top install.
- **electron-builder pin drift**: the signing-transformer behaviour is
  version-sensitive; the pin plus the output-level signature assertion convert
  a silent regression into a loud release failure.
