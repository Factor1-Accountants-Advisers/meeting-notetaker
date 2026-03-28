# UI Redesign — Calendar Strip, Slim Sidebar, Meeting Detail Flow

**Date:** 2026-03-28
**Status:** Approved
**Branch:** feature/ui-redesign

## Problem

1. The "Upcoming Meetings" section shows "No upcoming meetings" because the Graph API query window is only 8 hours (misses meetings days away).
2. The sidebar is too cluttered — calendar, recording controls, navigation labels, and user info all compete for space.
3. After uploading a recording, there's no clear UX for what happens next — the user has to hunt for the meeting in the list.

## Design Decisions

### 1. Slim Icon Sidebar

Replace the current full-width sidebar with a ~56px icon-only rail, inspired by Vinyl's navigation pattern.

**Sidebar contents (top to bottom):**
- App brand mark icon (pen nib)
- Meetings icon (Lucide `Calendar`) — active state: blue tinted background
- Action Items icon (Lucide `CheckSquare`)
- Settings icon (Lucide `Settings`)
- Spacer
- User avatar circle (initials, e.g. "JG")

**Each icon has a tooltip on hover** showing the page name (e.g. "Meetings", "Action Items", "Settings"). Use `title` attribute or a Tooltip component for accessibility. Icons should have `aria-label` attributes.

**Removed from sidebar:**
- Text labels for nav items
- Calendar/upcoming meetings section (moves to main panel)
- Recording controls section (moves to main panel header)
- User name/email text (accessible via avatar click or settings)
- "Sign out" link (moves to settings page)

**Icon library:** Lucide React (`lucide-react`) — tree-shakeable, clean line icons, consistent with shadcn/ui ecosystem. Install via `npm install lucide-react` in `web/`.

### 2. Main Panel — Dashboard Page

**Header area:**
- Left: Current date label + "Note Taker" as app title (h1)
- Right: "Upload" button (secondary) + "Start Recording" button (primary, blue)
- Both buttons have inline Lucide icons

**Upcoming Meetings section:**
- Section heading "Upcoming Meetings" with Refresh link
- Horizontal day strip: 7 calendar days from today, including weekends
- Each day pill shows: day name (Mon/Tue/etc or "Today"), date number
- Days with meetings: dots below the number (one dot per meeting)
- Selected day: solid blue background with shadow
- Today: blue outline/tint, always highlighted even without meetings
- Weekend days: slightly dimmer but always visible
- Below the strip: selected day's label (e.g. "Monday, March 31") + meeting cards
- Meeting cards: left accent border (colored), title, time range, duration, "Microsoft Teams" label, "Select" pill
- Empty day: "No meetings scheduled" italic text
- Click a meeting → selects it for recording. The `DayMeetingList` component accepts an `onSelectMeeting(meeting: CalendarEvent)` callback prop, passed down from the dashboard page. When a calendar meeting is selected, this callback opens the `RecordingPanel` in pre-filled mode.

**Day strip loading/error states:**
- While fetching from Graph API: skeleton pill placeholders (7 grey rounded rectangles)
- On error (token expired, Graph API down): "Could not load calendar" message with Retry button
- Not in Electron (browser-only): hide the Upcoming Meetings section entirely (no Graph API available)

**Past Meetings section:**
- Below a divider
- Section heading "Past Meetings" with search input (magnifying glass icon) + status filter dropdown
- Meeting list (existing `MeetingList` component, adapted)
- Retains existing `SearchFilter` component for search/filter functionality
- Retains existing `DeleteMeetingButton` on each meeting row
- Empty state: dashed border card with "No meetings yet" message

**Graph API change:**
- `desktop/src/main/graph.ts`: Change `endDateTime` from `now + 8 hours` to `now + 7 days`
- The meeting-selector tray popup keeps its own 8-hour window (separate use case)

### 3. Recording Flow

The app records audio from the user's computer (mic + system audio via WASAPI/FFmpeg). It does NOT join the Teams meeting — the user joins Teams normally and runs Note Taker alongside it.

**Two entry points, one recording panel:**

#### A) Calendar meeting (pre-filled)
1. User clicks a meeting in the day strip → meeting card highlights with a checkmark
2. A **recording panel** expands below the meeting cards (blue-tinted card)
3. Panel shows: "Ready to Record" label, meeting title, time, attendees (all pre-filled from Graph API), audio device info (mic + system audio), and a big red **"Start Recording"** button
4. Panel has a ✕ button to dismiss without recording

#### B) Ad-hoc recording (manual entry)
1. User clicks **"Start Recording"** button in the main panel header (no meeting selected)
2. The same recording panel expands, but with a form instead of pre-filled details:
   - Label: "New Recording"
   - Meeting title: text input (required)
   - Attendees: tag input — type a name, press Enter to add as a removable pill (required, at least one). Helper text: "Helps identify speakers in the transcript"
   - Same audio device info and red "Start Recording" button
3. "Start Recording" is disabled until title and at least one attendee are provided

#### Active recording state
Once "Start Recording" is clicked (either path):
- Panel transitions from blue → red-tinted with pulsing "Recording in Progress" label
- Shows: meeting title, start time, **large elapsed timer** (monospace, e.g. "24:37"), **audio level bars** for mic and system audio (green gradient), red **"Stop Recording"** button
- **Header shows a recording indicator**: pulsing red dot + "Recording" text (visible even when scrolled down)
- **Day strip dims** with `opacity: 0.5` and `pointer-events: none` (can't switch meetings mid-recording)
- The "Upload" header button is also disabled during recording

#### After stopping
1. User clicks "Stop Recording"
2. App saves the .wav file locally, then uploads to `POST /api/meetings/upload` with the meeting title + attendees as metadata
3. Navigates immediately to `/meetings/{id}` with the processing view (same flow as upload)

#### Recording error states
- **Microphone access denied**: Show inline error in recording panel — "Microphone access denied. Check your system permissions." with a "Retry" button.
- **System audio unavailable**: Show warning (not blocking) — "System audio capture unavailable. Only microphone audio will be recorded." Recording can still proceed with mic-only.
- **Upload failure after stop**: Show error toast/banner — "Failed to upload recording. Your file is saved locally at [path]." with "Retry Upload" button. The local .wav file is preserved so the user can retry or use the manual Upload flow.
- **Not in Electron (browser-only)**: Hide the "Start Recording" header button entirely (recording requires Electron's WASAPI/FFmpeg bridge). The Upload button remains available.

#### New component
- `RecordingPanel.tsx` — handles both pre-filled (calendar) and ad-hoc (form) modes, plus the active recording state with timer and audio levels. Single component, three visual states: pre-filled ready, form ready, active recording.

### 4. Upload Flow

**Trigger:** Click "Upload" button in main panel header.

**Upload modal** (modify existing `web/src/components/UploadModal.tsx`):
- File picker: drag-and-drop zone or click to browse. Accepts .wav, .mp3, .mp4, .m4v, .mov (existing)
- Meeting title: text input, required (existing)
- Attendees: multi-input for names/emails (existing, currently optional). **Change to required** — improves diarization accuracy by giving the pipeline expected speaker names. Add frontend validation to require at least one attendee. Also update the backend `MeetingUploadMetadata` schema in `schemas.py` to enforce `min_length=1` on the `attendees` field so the constraint is enforced server-side too.
- Date/time: use `File.lastModified` as the default value if no date is provided. User can override. This is a best-effort default — `lastModified` reflects when the file was last saved, which is typically close to the recording time.

**After upload:**
- Modal closes
- Navigate immediately to `/meetings/{id}` (the `[[...id]]` catch-all route at `web/src/app/(protected)/meetings/[[...id]]/`)
- Meeting detail page shows processing state

### 5. Meeting Detail Page — Single Scroll Layout

Replace the current tabbed layout in `web/src/app/(protected)/meetings/[[...id]]/MeetingDetailContent.tsx` with a single scrollable page.

**Page structure (top to bottom):**

**Header:**
- Back link: "← Back to Meetings" (navigates to dashboard)
- Meeting title (h1) + status badge ("Processing" / "Complete" / "Failed")
- Metadata line: date, time, duration, attendee names
- `ExportMenu` component (existing, retained) — visible only when status is "complete"

**Audio player** (existing `AudioPlayer.tsx` component, retained):
- Horizontal bar: play button, progress bar, time display
- Always visible — the backend stores the path in `audio_blob_url` (DB column) and the API returns a pre-signed URL as `audio_url` in the response. The frontend uses `meeting.audio_url`. Available immediately via `GET /api/meetings/{id}` before processing completes.
- If `audio_url` is null (storage error or not yet available): show a muted "Audio unavailable" placeholder instead of the player.

**Processing progress card** (visible only while status is processing/transcribing/diarising/summarising):
- Blue-tinted card with spinner icon and "Processing your meeting..." heading
- Pipeline steps as a vertical checklist, mapped to backend `MeetingStatus` enum:
  - `PROCESSING` → "Preparing audio..." (blue spinner) — initial state after upload, before transcription begins
  - `TRANSCRIBING` → Preparation ✓, "Transcribing audio..." (blue spinner, ~2 min)
  - `DIARISING` → Preparation ✓, Transcription ✓, "Identifying speakers..." (blue spinner)
  - `SUMMARISING` → Preparation ✓, Transcription ✓, Speakers ✓, "Generating summary & action items..." (blue spinner)
  - `COMPLETE` → card disappears, all sections populated
  - `FAILED` → red-tinted card with error icon, "Processing failed" heading, error message from backend, and "Retry" button. **Note:** The retry endpoint (`POST /api/meetings/{id}/retry`) does not exist yet — it must be added to the backend as part of this work. It should re-enqueue the Celery task chain and reset status to `PROCESSING`.

**Summary section:**
- Card with heading "Summary" + Lucide `FileText` icon
- Summary paragraph (3-5 sentences)
- "Key Points" subheading + bulleted list
- "Follow-ups" subheading + bulleted list (if any)
- During processing: skeleton loading blocks (3 lines of varying width)

**Action Items section:**
- Card with heading "Action Items" + count badge
- Each item: checkbox + description + assignee name (blue) + due date
- Checkboxes are interactive (toggle open/complete via `PATCH /api/action-items/{id}`)
- During processing: skeleton loading blocks

**Transcript section:**
- Card with heading "Transcript"
- Speaker-labeled segments: speaker name (unique color per speaker) + timestamp + text
- Initially shows first ~5 segments with "Show full transcript (N segments)" expand link
- Clicking a timestamp seeks the audio player to that position
- During processing: skeleton loading blocks

**Progressive reveal:** Each section transitions from skeleton → populated content as its pipeline step completes. Uses SWR polling (see Status Update Mechanism below).

## Components Affected

### New Components (all in `web/src/components/`)
- `DayStrip.tsx` — horizontal day pill strip with selection state
- `DayMeetingList.tsx` — meeting cards for a selected day
- `IconSidebar.tsx` — slim icon-only navigation rail with tooltips
- `ProcessingProgress.tsx` — pipeline progress card with step states mapped to `MeetingStatus` enum
- `RecordingPanel.tsx` — recording panel with three states: pre-filled ready, ad-hoc form, active recording

### Modified Components
- `web/src/app/(protected)/meetings/[[...id]]/MeetingDetailContent.tsx` — replace tabbed layout with single-scroll layout
- `web/src/components/CalendarPanel.tsx` — remove (functionality replaced by DayStrip)
- `web/src/components/Nav.tsx` — replace with IconSidebar
- `web/src/components/MeetingList.tsx` — adapt for "Past Meetings" section
- `web/src/components/UploadModal.tsx` — make attendees required, add date auto-population from file metadata
- `web/src/components/RecordingControls.tsx` — remove (functionality replaced by RecordingPanel)
- `web/src/components/RecordingStatusBar.tsx` — remove (recording indicator moves to header in main panel)
- `web/src/app/(protected)/page.tsx` — new dashboard layout with day strip + recording panel + past meetings

### Removed Components (functionality absorbed into new layout)
- `web/src/components/MeetingHeader.tsx` — remove. Its content (title, metadata, status badge, export menu) is inlined directly into the `MeetingDetailContent.tsx` header section.
- `web/src/components/SummaryView.tsx` — remove. Summary rendering is inlined into `MeetingDetailContent.tsx` as the Summary card section with skeleton loading states.
- `web/src/components/TranscriptView.tsx` — remove. Transcript rendering is inlined into `MeetingDetailContent.tsx` as the Transcript card section with speaker colors, timestamp seeking, and expand/collapse.

### Retained Components (no changes, integrated into new layout)
- `web/src/components/ExportMenu.tsx` — shown in meeting detail header when complete
- `web/src/components/DeleteMeetingButton.tsx` — shown on meeting rows in Past Meetings
- `web/src/components/SearchFilter.tsx` — used in Past Meetings section
- `web/src/components/StatusBadge.tsx` — used in meeting detail header and meeting list
- `web/src/components/AudioPlayer.tsx` — used in meeting detail audio player section
- `web/src/components/ActionItemsTable.tsx` — used in meeting detail action items section (checkboxes for toggling status)

### Modified Backend
- `desktop/src/main/graph.ts` — change query window from 8 hours to 7 days
- `backend/app/schemas.py` — make `MeetingUploadMetadata.attendees` required with `min_length=1`
- `backend/app/routers/meetings.py` — add `POST /api/meetings/{id}/retry` endpoint (re-enqueue Celery pipeline, reset status to `PROCESSING`)

### New Dependency
- `lucide-react` — add to `web/package.json`

## Status Update Mechanism

The meeting detail page needs real-time status updates during processing.

**Approach:** SWR polling with `refreshInterval` of 3 seconds while meeting status is not `COMPLETE` and not `FAILED`. When status reaches a terminal state, stop polling.

**Required change to `useMeeting` hook** in `web/src/lib/api.ts`: The current signature is `useMeeting(id)` with no SWR options. Add an optional second parameter for SWR config:

```tsx
// Add SWRConfiguration to the existing import:
// import useSWR, { SWRResponse, SWRConfiguration } from "swr";

export function useMeeting(
  id: number | undefined,
  options?: SWRConfiguration
): SWRResponse<MeetingDetail> {
  return useSWR(id != null ? `/api/meetings/${id}` : null, fetcher, options);
}

// Usage in MeetingDetailContent.tsx:
const { data } = useMeeting(id, {
  refreshInterval: status !== 'complete' && status !== 'failed' ? 3000 : 0
});
```

WebSocket (`/ws/meetings/{id}/status`) can replace polling as a future enhancement.

## Out of Scope

- Automatic recording (calendar-based triggers — Phase 4)
- WebSocket real-time updates (use polling for now)
- Mobile responsive layout
- Audio level visualization implementation (the active recording UI shows level bars, but actual FFmpeg audio level data piped to the renderer is a stretch goal — static or simulated levels are acceptable for MVP)
