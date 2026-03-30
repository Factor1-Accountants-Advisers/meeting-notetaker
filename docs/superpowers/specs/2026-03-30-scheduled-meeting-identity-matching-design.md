# Scheduled Meeting Identity Matching Design

## Goal

Improve transcript speaker labeling for scheduled meetings without fabricating certainty.

The app should use scheduled-meeting context from Microsoft Graph plus the signed-in Microsoft identity to attempt real-person speaker labels in transcripts and action items. When the match is uncertain, the app must fall back to generic labels like `Speaker 1` and `Speaker 2`.

## Scope

In scope:

- scheduled meetings only
- speaker identity matching after transcription diarization
- participant and hint persistence needed to support matching
- safe transcript and action-item ownership labeling
- preserving raw diarization identities for debugging and future reprocessing

Out of scope:

- ad-hoc meeting identity matching
- bot / test-call identity matching
- cross-meeting voiceprint recognition
- guaranteed true identity from acoustics alone
- changing the UI information architecture

## Current Constraints

- the current calendar contract only fetches `id`, `subject`, `start`, `end`, and `attendees`
- organizer data is not currently fetched from Microsoft Graph
- the current diarisation service only renames provider speaker ids to `Speaker N`
- the app already requires Microsoft sign-in and has `Calendars.Read`, `User.Read`, `openid`, and `profile`
- participant rows are already persisted on meeting upload, but speaker-to-person matching is not implemented

## Product Principle

The system must not invent speaker identities when confidence is weak.

This is especially important because transcript speaker labels influence downstream meeting summaries and action-item ownership. A wrong assignment is worse than a generic assignment.

Therefore:

- confident match: show the real display name
- uncertain match: keep `Speaker N`
- uncertain action-item owner: keep generic or unassigned rather than guessed

## Design

### Matching Scope

Only scheduled meetings should attempt identity matching.

The matching pipeline runs after transcription and diarization have already produced raw speaker-separated segments. Identity matching is a second-stage naming step, not part of raw diarization itself.

This keeps the system honest:

- raw acoustic separation remains intact
- identity is treated as a best-effort overlay
- fallback remains safe and understandable

### Candidate Identity Pool

For scheduled meetings, build the candidate pool from:

- meeting attendees
- meeting organizer
- signed-in user

The signed-in user should be included even if Microsoft Graph omits them from the attendee array for a particular event.

Each candidate identity should carry:

- `display_name`
- `email`
- stable Microsoft identifier when available
- `is_organizer`
- `is_current_user`

The visible transcript label should use `display_name` only. Email and Microsoft identifier are for internal matching and auditability.

### Persistence Model

Persist identity data in two layers:

1. `participants`
- first-class meeting people
- real meeting data, not heuristic output
- include stable person attributes where available

2. meeting-level identity-hints metadata
- signed-in user snapshot
- organizer snapshot
- candidate list snapshot used during matching
- enough context to explain later why matching did or did not succeed

This split keeps real meeting participants queryable while preserving the extra matching context separately as hint metadata.

### Transcript Model

Keep both the raw diarization identity and the final visible label.

Each segment should preserve:

- raw provider speaker id or stable internal speaker key
- matched participant reference when confidence is sufficient
- final display label shown in UI and exports
- original timestamps and text unchanged

This lets the system:

- re-run matching later without destroying the original speaker structure
- debug questionable matches
- avoid coupling UI labels to raw provider output

### Matching Rules

The identification layer should prefer stronger identity anchors first:

1. stable Microsoft identity
2. email
3. display name

The signed-in user should act as a strong hint because they are the local operator of the app and their voice is likely present on the local microphone track.

Organizer is only a secondary hint. Organizer status should never override a weak or ambiguous match on its own.

When confidence is high:

- transcript label becomes the real display name
- action-item owner can map to the matched participant

When confidence is weak or ambiguous:

- transcript label remains `Speaker N`
- action-item owner remains generic or unassigned
- no person should be shown just because they were present in the attendee roster

### Export Behavior

Exports should use the same safe visible labels as the UI.

That means:

- real names only for confident matches
- `Speaker N` for uncertain matches

The export must not expose a more aggressive mapping policy than the in-app transcript.

## Data Flow

1. User signs in with Microsoft.
2. Electron fetches scheduled meetings from Microsoft Graph.
3. Calendar event payload includes attendees and should be extended to include organizer data.
4. When a scheduled meeting is recorded or uploaded, the backend persists:
- meeting participants
- meeting-level identity hints including current-user and organizer context
5. Transcription produces diarized segments with raw speaker ids.
6. Identity matching runs against the persisted candidate pool.
7. Each transcript segment keeps both raw speaker identity and final visible label.
8. Summary and action-item extraction consume the safe visible labels.
9. UI and exports show the same final labels.

## Error Handling

- if organizer data is unavailable, matching should still proceed with attendees plus signed-in user
- if current-user identity is unavailable, matching should still proceed with attendee-based hints
- if a speaker cannot be confidently matched, preserve generic speaker labels
- if all identity hints are absent or incomplete, the system should behave exactly like today and produce `Speaker N`

The system should degrade safely, not fail the whole meeting-processing pipeline.

## Testing

Verification should cover:

- scheduled meeting candidate pool includes attendees, organizer, and signed-in user
- signed-in user is included even when missing from attendee list
- transcript storage preserves both raw speaker key and final visible label
- confident match produces real display name
- uncertain match stays `Speaker N`
- action-item owner mapping does not assign a real person when confidence is weak
- exports use the same visible labels as the UI
- meetings without organizer data still process correctly

## Notes

- this design improves identity labeling only for scheduled meetings
- this does not create cross-file speaker recognition
- persisting identity hints does not automatically improve future meetings on its own, but it creates the foundation for later reuse and better heuristics
- the current Graph permission set appears sufficient for this design because it already supports calendar access and signed-in user identity
