# Windows communications audio routing design

## Context

Notetaker records two independent streams:

- the user's microphone through Chromium `getUserMedia`; and
- remote-participant audio through Electron's Windows WASAPI loopback grant.

The current implementation listens for browser `devicechange` events and can
replace either stream during a recording. That is insufficient for Bluetooth
and Teams use:

- Teams can pin its own microphone and speaker without changing Windows;
- an open Chromium microphone stream does not follow a later default-device
  change;
- a saved Notetaker microphone deliberately prevents default-device following;
- if a saved microphone is absent at capture start and reappears later, the
  fallback stream is mistaken for the saved device because the code checks only
  that the current stream is live; and
- Chromium does not guarantee a `devicechange` event for every Windows default
  communications endpoint change.

Field evidence from packaged 2.0.15 shows a microphone stream becoming
effectively silent without any microphone re-acquisition event. The current
automated fixture covers only an unpinned synthetic default-device change.

Teams does not expose its selected device endpoint to this desktop app through
Microsoft Graph or a supported local integration. The supported product model
is therefore: **Teams and Notetaker both follow the Windows communications
devices.** Teams-only device overrides remain a detectable/documented mismatch,
not something Notetaker attempts to scrape or reverse engineer.

## Approaches considered

### 1. Renderer-only device following

Continue using `navigator.mediaDevices.devicechange`, fix the pinned-device
comparison, and retry on silence. This is the smallest change and remains the
cross-platform fallback. It cannot reliably observe a Windows default-role
change when the physical device list does not change.

### 2. Windows communications endpoint monitor plus renderer capture — selected

Bundle a small Windows helper that reads the official Core Audio
`eCommunications` capture and render defaults and emits an initial snapshot plus
change notifications. Electron owns the helper process and forwards sanitized
endpoint state through preload. The renderer continues to own MediaRecorder and
reacquires its streams when the relevant endpoint generation changes.

This keeps the existing, proven capture pipeline while adding an authoritative
Windows routing signal. It also degrades cleanly to approach 1 if the helper
cannot start.

### 3. Move all recording into a native audio engine

A native engine could bind directly to endpoint IDs and potentially implement
per-process Teams loopback. It would replace the working renderer recorder,
spill/recovery path, segment merge, level meters, and much of the packaging
surface. That is disproportionate to this defect and is excluded.

## Architecture

### Windows endpoint helper

Create a small Rust binary under `native/audio-endpoint-monitor/`. It uses the
Windows Core Audio API to obtain:

- `eCapture` + `eCommunications`; and
- `eRender` + `eCommunications`.

It emits newline-delimited JSON on stdout. Messages contain a schema version,
message kind, generation number, and each endpoint's stable Windows ID and
friendly label. It never changes Windows settings or accesses audio content.
Unexpected errors are emitted as structured status messages and to stderr.

The first version may poll the two official endpoints at a short bounded
interval instead of implementing an in-process COM callback. It emits only when
an endpoint ID changes, so renderer churn is independent of polling frequency.
Polling the documented API is preferred to depending on browser topology events
and keeps the helper small and deterministic.

The release workflow builds the helper for Windows x64 and electron-builder
packages it under `resources/audio/`. The executable is covered by the existing
installer signing flow. Development starts the locally built helper when
available and otherwise uses the browser fallback.

### Electron endpoint service

Add a focused main-process service responsible for:

- locating and spawning the helper hidden;
- validating and parsing its JSONL protocol;
- retaining the latest endpoint snapshot;
- broadcasting endpoint changes to the renderer;
- restarting the helper once after an unexpected exit, then degrading to the
  browser fallback; and
- terminating it during normal quit and installer/update shutdown.

Preload exposes a read-only snapshot method and a subscribed event. The renderer
never spawns processes and receives no capability beyond endpoint metadata.

### Routing preference

Replace the ambiguous `micDeviceId: ''` convention with an explicit preference:

- `follow_communications` — default and recommended; or
- `pinned` with a Chromium microphone device ID.

Legacy preferences migrate to `follow_communications`. A previous non-empty ID
is retained as the last manual choice but is not silently kept active because
the old UI promised system fallback and the product's required behaviour is now
automatic communications-device following.

Settings explains that Teams should use Computer audio/system defaults. Manual
pinning remains available for users who intentionally need a different input.

### Microphone flow

At capture start:

- `follow_communications` requests Chromium's current default input;
- `pinned` requests the selected device exactly, falling back to the default
  only when the selected device is absent; and
- the actual acquired track ID, group ID, and label are retained and exposed in
  capture status.

During capture, either a Windows capture-endpoint change or browser
`devicechange` triggers a debounced comparison/reacquisition. In pinned mode,
the controller compares the current track with the requested device rather than
assuming that any live track is the pinned device. A pinned device that
reappears therefore replaces its fallback stream.

The microphone recorder continues consuming the stable Web Audio destination.
Only its upstream source changes, so recording and spill continuity are
preserved.

If the microphone stays below the existing silence floor for eight seconds,
Notetaker performs one controlled reacquisition for the current routing
generation. A cooldown prevents retry loops. If the replacement remains
silent, the warning stays visible and names the active endpoint.

### System-audio flow

Electron loopback continues capturing the Windows default render endpoint. A
Windows render communications endpoint change triggers the existing segmented
loopback replacement. Browser `devicechange` remains a fallback.

If loopback remains silent for the existing 60-second threshold, Notetaker
performs one controlled reacquisition for the current routing generation before
leaving the warning visible. Previous segments retain their pause-aware offsets
and are merged by the existing backend path.

This design cannot capture a Teams-only speaker override while Windows points
elsewhere. Settings and the recording UI state this limitation and direct the
user to Teams' Computer audio/system-default option.

### UI and diagnostics

Settings:

- defaults to “Follow Windows communications devices”;
- refreshes microphone choices on `devicechange`;
- keeps “Always use this microphone” as an explicit manual mode; and
- displays the current Windows communications microphone and speaker when the
  helper is available.

Recording status displays the actual active microphone and meeting-audio labels
without adding video affordances. A transition may briefly show “Switching…”;
capture remains active. Warnings distinguish:

- endpoint changed and recovery is running;
- selected microphone is unavailable and the default is being used;
- microphone is still silent after recovery; and
- system audio is still silent after recovery.

Logs record routing mode, old/new endpoint labels, generations, acquisition
outcomes, and timeouts. They do not record audio, transcripts, tokens, or device
IDs beyond the local main log.

## Error handling

- Helper missing, malformed, or unavailable: log once, report native routing as
  unavailable, and retain browser `devicechange` plus silence recovery.
- Default endpoint temporarily absent during Bluetooth profile changes: keep
  the existing live stream, debounce, and retry on the next helper generation.
- Reacquisition timeout/failure: keep the old stream, keep controls responsive,
  and surface the existing warning.
- Duplicate helper/browser signals: coalesce them through the existing
  single-flight/generation guards.
- Stop during reacquisition: cancellation generation wins; late streams are
  immediately stopped and never attached.

## Testing

Automated tests must first fail for and then cover:

- legacy preference migration to `follow_communications`;
- pinned device absent at start and reappearing later;
- pinned device still active without unnecessary churn;
- default communications microphone change during recording;
- duplicate native and browser notifications being coalesced;
- one-shot microphone silence recovery and cooldown;
- render endpoint change creating correctly offset loopback segments;
- one-shot loopback silence recovery;
- settings device-list refresh;
- endpoint protocol parsing, malformed input, helper exit/restart, and shutdown;
- preload snapshot/event subscription cleanup; and
- UI labels and degraded-fallback messaging.

Hardware acceptance on a packaged Windows build must exercise:

1. Bluetooth connected before recording.
2. Bluetooth connected during recording.
3. Bluetooth disconnected and reconnected.
4. Bluetooth A2DP/HFP profile transition while Teams owns the device.
5. Teams using Computer audio/system defaults.
6. Teams explicitly pinned elsewhere, confirming the documented mismatch.
7. Wired/USB microphone switching and fallback.
8. Pause, resume, extend, stop, spill recovery, and merged audio after switches.

Repository verification remains the project-standard Graph fixtures,
recording/capture fixtures, TypeScript typechecks, production build, backend
tests, and `git diff --check`, plus helper unit/build checks.

## Scope exclusions

- Reading or modifying Teams preference files.
- Injecting into or automating the Teams process.
- Per-process Teams audio capture.
- Changing Windows default devices on the user's behalf.
- macOS or Linux native endpoint monitoring; those platforms retain the browser
  fallback until separately scoped.

