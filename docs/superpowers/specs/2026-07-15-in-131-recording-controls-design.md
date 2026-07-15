# IN-131 recording controls and long-audio reliability design

## Context

IN-88's 10 July scope correction removed manual Start/Stop controls from the recording UI. Commit `ab06ba2` implemented that interpretation. IN-120 later restored tray controls only. IN-131 is newer and takes precedence: an active recording must expose Pause/Resume/Stop in the recording screen as well as the tray.

The IN-131 log also shows a 77-minute two-track recording being saved locally in full while the `/audio` request blocked unrelated API reads during synchronous ffmpeg work. The original source files are not retained on this development machine, so the precise downstream truncation boundary cannot be reproduced from the attachment metadata alone.

## Design

- Restore Pause/Resume/Stop on `RecordingScreen` for manual and scheduled recordings.
- Route screen, tray, and automatic-stop commands through the same guarded controller in `App` so behavior cannot drift.
- Disable controls and show an explicit saving/uploading state as soon as Stop begins; duplicate Stop commands remain idempotent.
- Keep scheduled-only Extend alongside the shared controls.
- Move audio file preparation and ffmpeg merging off FastAPI's event-loop thread so long recordings do not freeze meeting/status reads.
- Scale the ffmpeg timeout for long recordings and compare ffmpeg's completed output duration with the client-reported duration. Reject a materially short merge before transcription rather than producing partial notes.
- Log byte counts and duration boundaries without logging audio, transcripts, credentials, or signed URLs.

## Verification

- Static renderer regression verifies active, paused, and saving states.
- Backend tests verify ffmpeg duration parsing, short-merge rejection, and event-loop responsiveness during preparation.
- Run Graph fixtures, TypeScript typechecks, production build, all backend tests, and `git diff --check`.
