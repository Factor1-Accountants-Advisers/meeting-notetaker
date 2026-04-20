# WASAPI loopback swap — eliminate VB-Audio / Stereo Mix dependency

**Status:** scoped, not started
**Author:** Claude (for @josephguerrero)
**Date:** 2026-04-19

## Goal

Fresh-install users should be able to record a meeting with no third-party audio setup. Today they have to install VB-Audio Virtual Cable or enable Stereo Mix in `mmsys.cpl` before the recorder produces usable output. This plan replaces the current ffmpeg DirectShow capture path with Electron's built-in WASAPI loopback, removing the manual setup step entirely.

## Current state

[desktop/src/main/recorder.ts](../../../desktop/src/main/recorder.ts) spawns ffmpeg with two DirectShow inputs:

```ts
.input(`audio=${options.micName}`)
.inputOptions(['-f', 'dshow'])
.input(`audio=${options.loopbackName}`)
.inputOptions(['-f', 'dshow'])
.complexFilter('amix=inputs=2:duration=longest:dropout_transition=0')
```

The "loopback" input only works if a DirectShow-visible capture device is piping system audio — which Windows does not provide natively on most modern hardware. The auto-detect logic in [desktop/src/main/ipc.ts](../../../desktop/src/main/ipc.ts) matches known third-party device names (`LOOPBACK_KEYWORDS`: `vb-audio`, `virtual cable`, `voicemeeter`, `stereo mix`, etc.), which means users have to install one of those to get anything.

## Proposed approach

Move audio capture into the renderer using the Web platform APIs that Electron (Chromium) natively supports:

1. **System audio:** `navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })`, with a main-process `session.setDisplayMediaRequestHandler` that returns `{ audio: 'loopback' }`. Electron translates this to a WASAPI loopback session on Windows. The video track is required by the API — we stop it immediately.
2. **Microphone:** `navigator.mediaDevices.getUserMedia({ audio: true })` with Windows' default input device.
3. **Mix:** a Web Audio `AudioContext` wiring both sources through `GainNode`s into a `MediaStreamAudioDestinationNode`. Shared audio clock = no sync drift.
4. **Encode:** `MediaRecorder(combinedStream, { mimeType: 'audio/webm;codecs=opus' })` produces chunked webm blobs streamed over IPC to the main process, which assembles them on disk.
5. **Post-process:** ffmpeg transcodes the final webm to 16 kHz mono PCM WAV (the format AssemblyAI wants) — one shot at stop time, not streaming.

No virtual cable. No `mmsys.cpl` configuration. No third-party deps.

## What changes

### New files

- **`desktop/src/renderer/audio-capture.ts`** (~150 LOC) — `startCapture()` / `stopCapture()` exposed through preload. Manages the `AudioContext`, both source streams, the `MediaRecorder`, and chunk streaming.

### Modified files

- **[desktop/src/main/index.ts](../../../desktop/src/main/index.ts)** — add `session.defaultSession.setDisplayMediaRequestHandler` before creating the main window. Approves loopback capture without UI prompt (~15 LOC).
- **[desktop/src/main/ipc.ts](../../../desktop/src/main/ipc.ts)** — replace device enumeration + ffmpeg start/stop handlers with blob-ingest handlers (`audio:chunk`, `audio:stop`). Delete `LOOPBACK_KEYWORDS`, `queryWindowsDefaultDevices`, `selectDefaultAudioDevices`, `pickDefaultDevices`, `listAudioDevices` (~150 LOC removed, ~60 added).
- **[desktop/src/main/recorder.ts](../../../desktop/src/main/recorder.ts)** — collapse to a webm → wav post-processor. ffmpeg stays bundled (still needed for uploaded-video audio extraction) but isn't in the capture hot path (~80 LOC removed, ~40 added).
- **[desktop/src/main/tray.ts](../../../desktop/src/main/tray.ts)** — remove "Mic device" and "Loopback device" submenus. Recording starts with zero configuration.
- **[desktop/src/renderer/preload-web.ts](../../../desktop/src/renderer/preload-web.ts)** — tighten the `ElectronAPI` surface: drop `getAudioDevices`, `getDefaultAudioDevices`, the mic/loopback fields on `RecordingOptions`.
- **[web/src/lib/electron-bridge.ts](../../../web/src/lib/electron-bridge.ts)** — mirror the interface change.
- **Meeting-selector renderer** — drop any mic/loopback UI.

### Deleted

- All references to VB-Audio / Stereo Mix / Voicemeeter in user-facing docs.
- The `LOOPBACK_KEYWORDS` heuristic.
- The PowerShell `IMMDeviceEnumerator` Windows Core Audio query.

### Tests

- Rewrite `desktop/tests/ipc-devices.test.ts` — most of it becomes obsolete; keep the small slice that still enumerates devices if any survives.
- New `desktop/tests/audio-capture.test.ts` — jsdom mocks for `MediaStream`, `MediaRecorder`, `AudioContext`. Verify start/stop lifecycle, chunk flushing, error propagation.

## Locked-in decisions

- **Mic selection UI:** removed. Always use Windows' default input. Users change mic via Windows sound settings (same place they'd change it for Teams/Zoom).
- **Intermediate format:** webm/opus → ffmpeg post-convert to 16 kHz mono PCM WAV. Lossy, but imperceptible for speech and single-transcode for code simplicity.
- **Plan location:** this file.

## Risks

1. **Dead video track cost.** `getDisplayMedia` mandates a video track even when you only want audio. We stop it in the first tick after the stream returns. Cost: ~30 ms of initial capture, then idle. Verify no residual CPU on hour-long recordings.
2. **Codec fidelity vs. direct PCM.** Transcoding introduces minor loss. Run a side-by-side transcript diff on a 10-minute sample as a gate before flipping the default.
3. **Exclusive-mode audio drivers.** A handful of pro-audio drivers (Focusrite, some Realtek variants) put the output device in WASAPI exclusive mode, which silences the loopback stream. Detection: sample RMS of the first 2 s of system audio; if below a noise-floor threshold, surface "system audio not captured — check Sound Settings → Advanced → Allow apps to take exclusive control."
4. **Corporate screen-share detection.** Some endpoint DLP tools flag `getDisplayMedia` calls even for audio-only. Low probability, but if the call is denied we need a clear error ("your organisation's security policy blocked system audio capture — contact IT") rather than a silent failure.
5. **First-run mic permission.** Electron will prompt on first `getUserMedia`. Handle with `session.setPermissionRequestHandler` auto-grant for this app (acceptable — it's signed, internal-use).

## Phases

### Phase 1 — land the new path behind a flag (~1 day)

- Build `audio-capture.ts`, wire IPC, add `setDisplayMediaRequestHandler`.
- Feature flag: `USE_WASAPI_CAPTURE=1`. Default off.
- Record a meeting with the flag on, verify the WAV is well-formed and AssemblyAI accepts it.

### Phase 2 — parity check (~0.5 day)

- Record the same 10-minute meeting with both paths.
- Diff the AssemblyAI transcripts. Gate: no substantive degradation in word error rate or speaker diarisation.

### Phase 3 — flip and clean (~0.5 day)

- Remove the DirectShow code path and its tests.
- Remove the tray mic/loopback pickers.
- Remove the setup docs for VB-Audio / Stereo Mix.
- Update [CLAUDE.md](../../../CLAUDE.md) "Deviations from Original Spec" section.
- Bump desktop version to 1.1.0 so Windows Installer cleanly upgrades existing 1.0.0 installs.
- Build fresh MSI, smoke-test install → record → transcribe → uninstall on a clean VM.

## Out of scope

- macOS / Linux capture. macOS uses ScreenCaptureKit (Electron 28+ handles this natively through the same API) and Linux uses PipeWire — both should work with the same renderer code, but we're not targeting either yet.
- Per-app audio capture (capturing only Zoom's output, say). Requires Windows 11 24H2's new `AudioCaptureStream` API — future enhancement if the demo exposes a clear need.
- In-app mic selector UI. If later feedback says the default-device heuristic is wrong, revisit.
