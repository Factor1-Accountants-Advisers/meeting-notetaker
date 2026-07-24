# Ad-hoc Attendee Picker Design

## Goal

Restore the desktop ad-hoc meeting attendee input required by IN-64 so the
Notetaker can use the selected employees as meeting-scoped voiceprint
candidates through IN-378.

## Decisions

- Ad-hoc attendees are trusted speaker-identification hints supplied by the
  authenticated recorder. They are not a server-verified meeting roster.
- Selecting an attendee does not grant access and does not add an email
  recipient. Manual/ad-hoc transcripts continue to be emailed only to the
  recorder.
- Manual attendees are stored separately from Graph metadata. Reusing
  `graph_metadata.attendees` would incorrectly make a manual recording behave
  like a calendar meeting for delivery and metadata rules.
- The Storage API contract remains unchanged. Manual attendees are submitted
  using its existing `invitee` candidate source because the contract permits
  only `invitee`, `organizer`, `recorder`, and `controlled_expansion`.
- The picker offers locally known enrolled staff and also accepts a typed,
  valid email. The Storage API deliberately has no list-all voiceprint
  endpoint, so typed exact lookup is required for employees not yet known to
  that desktop installation.

## User Experience

The Home capture card gains an optional **People attending** field between the
meeting title and the recording actions.

- Typing filters locally known enrolled staff by name or email.
- Choosing a result adds a removable chip showing the person's display name.
- A valid typed email can be added directly with Enter or an Add action.
- Duplicate emails are rejected case-insensitively.
- At most 49 people can be selected, leaving room for the recorder inside the
  Storage API's 50-candidate request limit.
- The meeting title remains required; attendees remain optional.
- The input and chips are disabled while another recording is active.
- Light and dark themes use the existing flat surface, token, typography, and
  focus conventions from `docs/design-handoff.md`.

## Data Model and Flow

Introduce a `ManualMeetingAttendee` shape containing:

- `name`: optional display name
- `email`: required, trimmed, case-normalized email

`MeetingCreate` accepts `manual_attendees`, and `Meeting` persists it so
processing retries use the same candidate set.

The renderer flow becomes:

1. Load locally known staff from `GET /api/v1/people`.
2. Collect selected people in the Home capture card.
3. Call `createMeeting(title, ..., manualAttendees)`.
4. Persist `manual_attendees` on the new meeting.
5. When audio processing begins, build candidates in this order:
   Graph invitees, manual attendees, Graph organizer, recorder, controlled
   expansion.
6. Send the bounded, normalized candidate list through the existing IN-378
   Storage API client.

The legacy local voiceprint matcher follows the same ordering so disabling the
central cutover does not change manual attendee behavior.

## Output and Delivery

For manual recordings, selected attendees appear in the canonical
`full_invitee_list`/meeting metadata so summaries can state who attended.
Meeting-type classification remains unchanged: manual meetings without Graph
metadata retain the existing deterministic fallback.

`_email_recipients` remains Graph-only for attendee delivery. Manual meetings
still resolve to the recorder exactly once.

## Validation and Failure Behavior

- Invalid attendee emails are rejected by the backend with 422.
- More than 49 manual attendees are rejected by the backend.
- Candidate construction still normalizes, deduplicates, and enforces the
  existing hard cap of 50.
- If the local people list is unavailable, typed email entry remains usable.
- If central lookup is unavailable, the existing bounded local fallback and
  retryable-failure behavior remain unchanged.

## Testing

- Schema tests cover normalization, invalid emails, and the 49-person bound.
- Meeting creation tests prove manual attendees persist.
- IN-378 tests prove manual attendees precede recorder and expansion
  candidates and deduplicate correctly.
- Legacy matcher tests prove selected manual attendees become local
  voiceprint candidates.
- Export tests prove manual attendees appear in output without changing
  manual meeting-type fallback.
- Email tests continue to prove manual recordings email only the recorder.
- A renderer verification script covers filtering, typed-email addition,
  deduplication, the selection cap, selected chips, and the optional-field
  presentation.

## Out of Scope

- Enumerating all central voiceprints or adding a Storage API list endpoint
- Microsoft Graph directory search or additional delegated Graph scopes
- Verifying that selected employees were physically present
- Emailing manual attendees
- Granting meeting access from the attendee list
- Directory support or voiceprint enrolment for external clients. A typed
  un-enrolled email is harmless but will be returned as missing by IN-378.
