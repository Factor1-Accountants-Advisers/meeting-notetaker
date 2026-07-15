# IN-131 Recording Controls and Long-Audio Reliability Implementation Plan

**Goal:** Restore reliable in-app recording controls and prevent long two-track uploads from freezing the API or silently entering transcription with a materially truncated merge.

**Architecture:** Keep `CaptureController` as the single media owner. Add one guarded command surface in `App` and make both the renderer screen and tray invoke it. Keep the existing upload contract, but execute disk/ffmpeg preparation in a worker thread and validate the ffmpeg output boundary before queueing the pipeline.

**Tech Stack:** Electron, React, TypeScript, FastAPI, Python `asyncio`, ffmpeg, unittest.

- [x] Task 1: Add failing renderer state regression
  - [x] Render active, paused, scheduled, and saving variants of `RecordingScreen`.
  - [x] Prove current UI lacks Pause/Resume/Stop and saving feedback.

- [x] Task 2: Restore shared recording controls
  - [x] Add accessible Pause/Resume/Stop controls and saving state.
  - [x] Route screen, tray, and auto-stop through one guarded controller.
  - [x] Re-run renderer regression and typechecks.

- [x] Task 3: Add failing long-audio preparation regressions
  - [x] Test ffmpeg progress-duration parsing and materially short merge rejection.
  - [x] Test that preparation yields the event loop while ffmpeg work is in progress.

- [x] Task 4: Harden long-audio preparation
  - [x] Move file writes/merge off the event-loop thread.
  - [x] Scale merge timeout from the declared recording duration.
  - [x] Validate and log merged duration/bytes before pipeline queueing.

- [x] Task 5: Record evidence and verify
  - [x] Update `docs/jira-progress.md` with IN-131 conflict and implementation evidence.
  - [x] Run Graph fixtures, typechecks, build, backend tests, and `git diff --check`.

Verification completed 2026-07-15: Graph fixtures passed; recording-control fixtures passed; TypeScript typechecks passed; Electron production build passed; 69 backend tests passed; Python compileall passed; `git diff --check` passed.
