# End-to-end transcription reliability and lightweight progress design

## Goal

Make Meeting Note-Taker work end-to-end for both instant and scheduled recordings:

1. Capture microphone + system audio.
2. Save and transcode the recording.
3. Upload the audio to the local backend.
4. Transcribe with speaker labels where possible.
5. Summarise the meeting.
6. Extract action items.
7. Show clear progress and failure states so the user can tell what happened without reading logs.

This is a reliability-first release with lightweight Granola-style polish. It is not a full UI redesign.

## Current findings

The v1.1.3 installed app can now start and stop recording. Recent logs show the audio path works:

- WASAPI capture starts.
- WebM audio is captured.
- The file is transcoded to WAV.
- `POST /api/meetings/upload` returns `200 OK`.

The failure occurs after upload. The packaged backend logs:

`Transcription pipeline failed: Please provide an API key via the ASSEMBLYAI_API_KEY environment variable or the global settings.`

The per-user runtime config file exists at:

`%APPDATA%\meeting-notetaker-desktop\.env.production.local`

It contains the expected provider keys, but the Electron backend launcher does not currently load that file into the spawned Python backend process.

## Approach

Use the smallest reliable patch that proves the full pipeline in the installed app.

### 1. Runtime AI configuration

Update the Electron backend launcher to load runtime environment overrides before spawning FastAPI.

Source:

`%APPDATA%\meeting-notetaker-desktop\.env.production.local`

Supported keys for this patch:

- `ASSEMBLYAI_API_KEY`
- `OPENAI_API_KEY`

Rules:

- Never log secret values.
- Log only whether each runtime key is present.
- Existing process environment values still work.
- Per-user runtime config overrides bundled/public config where needed.

### 2. Pipeline status visibility

Expose lightweight, readable status in the UI using existing meeting status fields where possible.

Target labels:

- Recording
- Finalising audio
- Uploading
- Transcribing
- Summarising
- Extracting action items
- Complete
- Failed: `<human-readable reason>`

This should feel closer to Granola’s calm progress model: simple status text, obvious completion, and obvious failure reason.

### 3. Recoverability

For today, recoverability means:

- Failed meetings show the cause clearly.
- If upload succeeded but transcription failed, the stored meeting/audio remains available for reprocessing or debugging.
- Logs remain detailed enough to identify backend/provider failures.

A full retry/reprocess button can be added if the current backend already exposes a safe reprocess endpoint. If not, do not block the reliability fix on building a new reprocess workflow.

## Flows to verify

### Instant recording

1. Click record from the app.
2. Speak/play test audio.
3. Stop recording.
4. Confirm upload succeeds.
5. Confirm meeting transitions through processing states.
6. Confirm transcript, summary, and action items appear.

### Scheduled recording

1. Use a real or test calendar meeting.
2. Trigger scheduled recording flow.
3. Stop recording after a short test.
4. Confirm the same upload and processing outputs appear.
5. Confirm scheduled meeting metadata is preserved in the created meeting.

## Testing strategy

### Automated tests

- Add a desktop main-process unit test for runtime env loading from `.env.production.local`.
- Add or update tests for user-visible upload/pipeline status if the existing UI state makes that practical.
- Run existing desktop Jest suite.
- Run relevant backend tests if touched.
- Build Electron outputs so source and compiled JS stay in sync.

### Manual installed-app smoke test

After packaging/release:

1. Install v1.1.4.
2. Confirm About shows v1.1.4.
3. Run instant recording end-to-end.
4. Run scheduled recording end-to-end.
5. Confirm final output has transcript, summary, and action items.
6. Confirm no secrets are logged.

## Non-goals

- Full Granola clone or major UI redesign.
- New transcription provider architecture.
- Teams bot or official Teams transcript import.
- Changing the product’s calendar scheduling semantics beyond what is required to verify scheduled recording.

## Success criteria

The goal is complete when the installed app can process both an instant recording and a scheduled recording from capture to final meeting output, with clear UI status and failure messaging if any stage fails.
