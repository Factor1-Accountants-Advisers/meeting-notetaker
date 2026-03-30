# Audio Setup And Sign-In Refresh Design

## Goal

Improve demo-readiness and first-time usability for the desktop app by:

- making audio device setup obvious and easy for non-technical users
- preventing recording until microphone and system audio are explicitly configured
- refreshing the sign-in page so it matches the current frontend visual system
- opening the created meeting detail/progress view after a successful manual upload

## Scope

In scope:

- protected settings page UX and styling
- recording-panel blocked state when audio devices are not configured
- direct navigation from blocked recording state to settings
- sign-in page visual redesign
- upload success handoff into meeting detail / processing view

Out of scope:

- Graph-backed attendee autocomplete
- first-run onboarding wizard
- empty-attendee fallback UX for calendar meetings
- backend or auth contract changes

## Current Constraints

- audio devices are already available via `electronAPI.getAudioDevices()`
- selected microphone and loopback names are already persisted in `localStorage`
- recording currently falls back to guessed devices if no saved selection exists
- manual upload currently succeeds but only refreshes the meetings list
- design system already uses the light/dark tokenized shell introduced on the dashboard

## Design

### Settings Page

The settings page becomes a guided setup screen rather than a generic preferences form.

Structure:

- primary heading: `Audio Setup`
- short plain-language helper copy explaining that Note Taker needs both a microphone and system audio before recording
- one setup card containing:
  - `Microphone` selector
  - short helper text explaining this captures the user’s voice
  - `System Audio` selector
  - short helper text explaining this captures Teams / computer audio
  - one strong primary action: `Save audio setup`
- clear saved state feedback after save
- secondary app information below in a quieter `About` section
- sign-out remains available but visually demoted

Interaction:

- if running outside Electron, audio controls do not render
- saved device names continue to come from `localStorage`
- the page should be visually consistent with the new dashboard shell: rounded surfaces, soft borders, restrained typography

### Recording Panel Gate

Recording should be blocked unless both required devices are explicitly configured.

Behavior:

- before enabling `Start Recording`, the panel checks `settings:micName` and `settings:loopbackName`
- if either is missing:
  - disable the primary recording button
  - show a plain warning message
  - show one obvious action button: `Set up audio devices`
  - clicking that action navigates the user to `/settings`
- remove implicit fallback to arbitrary detected devices for live recording

Messaging:

- keep copy simple and non-technical
- example: `Before recording, choose your microphone and system audio.`

This gate applies to both:

- selected calendar meeting recording
- ad-hoc recording

### Sign-In Page

The sign-in page should match the main app’s calmer shell.

Structure:

- centered single card
- app name
- one short sentence explaining sign-in
- primary `Sign in` button
- small secondary text shown during the device-code flow

Visual direction:

- same off-white/light-shell style as the dashboard
- rounded card and soft border/shadow
- no legacy dark fullscreen styling
- no extra onboarding steps for now

### Upload Success Handoff

After a successful manual upload:

- use the returned `meeting_id`
- close the upload modal
- open that meeting immediately in the right-side detail/progress view

This makes the user land directly in the processing journey instead of manually finding the new meeting.

## Data Flow

### Audio Setup

1. Settings page loads devices from Electron.
2. User selects microphone and loopback.
3. User saves selections into `localStorage`.
4. Recording panel reads saved values before recording.
5. If values are missing, recording remains blocked and user is sent to settings.

### Manual Upload

1. User uploads a file from the modal.
2. Frontend receives `{ meeting_id, status }`.
3. Meetings list is revalidated.
4. Modal closes.
5. Dashboard selects `meeting_id` into the right detail panel.
6. Existing status polling handles progress updates.

## Error Handling

- if device enumeration fails in settings, show a user-facing error or empty state rather than broken selectors
- if recording is blocked due to missing device configuration, this is treated as a guided setup state, not an error state
- if upload succeeds but detail fetch fails, the meeting should still appear in the list via SWR revalidation

## Testing

Frontend verification should cover:

- settings page loads device options and saves selections
- recording button is disabled when either device selection is missing
- `Set up audio devices` navigates to settings
- recording becomes enabled when both selections are present
- manual upload opens the created meeting detail view
- sign-in page visually matches the current shell and still performs login

## Notes

- organizer-aware attendee UI remains blocked by missing organizer data in the current calendar contract
- polling remains the active processing update mechanism
- no backend API changes are required for this scope
