# Master-Detail Dashboard Layout

**Date:** 2026-03-28
**Status:** Approved
**Branch:** feature/ui-redesign

## Problem

The dashboard has a `max-w-4xl` content constraint that leaves significant white space on the right side of the screen, especially on wide monitors. The space is wasted and makes the layout feel unfinished.

## Solution

Convert the dashboard into a master-detail split layout. The left panel contains the existing dashboard content (calendar, recording, past meetings list). The right panel shows meeting details inline when a past meeting is selected — no page navigation required.

## Layout Structure

**Two-column flex layout:**
- **Left panel (`w-[400px]`, fixed width, scrollable):** Header with Upload/Record buttons, DayStrip + DayMeetingList (Electron only), RecordingPanel, divider, past meetings list with search + status filter
- **Right panel (`flex-1`, scrollable):** Meeting detail content (header, audio player, summary, action items, transcript) when a meeting is selected
- **Empty state (right panel):** Centered `FileText` icon + "Select a meeting to view details" when no meeting is selected

**Scroll behavior:**
- Both panels scroll independently with `overflow-y-auto`
- Height: `h-[calc(100vh-4rem)]` — the parent `<main>` has `p-8` (2rem top + 2rem bottom = 4rem total vertical padding)
- The parent `<main>` in `layout.tsx` must change from `overflow-auto` to `overflow-hidden` to prevent nested scrollbar conflicts. This is a one-line change.

## Component Changes

### `layout.tsx` (Protected Layout)

- Change `<main>` from `overflow-auto` to `overflow-hidden` to prevent nested scrollbars with the independently-scrolling panels

### `page.tsx` (Dashboard)

- Add `detailMeetingId: number | null` state (named `detailMeetingId` to avoid confusion with existing `selectedMeeting` state which tracks the calendar event for recording)
- Layout becomes flex row: left panel (`w-[400px]`) + right panel (`flex-1`)
- Left panel wraps all existing dashboard content (remove `max-w-4xl` constraint)
- Right panel renders `MeetingDetailContent` with `meetingId` prop when selected, empty state placeholder when not
- Pass `onSelectMeeting` callback and `detailMeetingId` to `MeetingList`

### `MeetingList.tsx`

**Layout overhaul:** The current 6-column white-background `<table>` will not fit at 400px and clashes with the dark theme. Replace with a compact dark card list:
- Each meeting renders as a card: title (bold), date + duration + status badge on a second line, delete button (icon only, top-right)
- Cards have `bg-gray-900/50 border border-gray-800 rounded-lg` to match existing dark theme components
- Compact padding (`p-3`) to fit the 400px panel

**New optional props:** `onSelectMeeting?: (id: number) => void` and `selectedMeetingId?: number | null`
- When `onSelectMeeting` is provided, clicking a meeting calls the callback instead of navigating via `<Link>`
- When `selectedMeetingId` matches a meeting card, highlight it with a blue left border (`border-l-2 border-l-blue-500`) and subtle background tint
- When `onSelectMeeting` is not provided, cards link to `/meetings/[id]` as before (backward-compatible)
- SearchFilter component stays as-is above the cards

**Deletion edge case:** If the user deletes the currently-selected meeting (via `DeleteMeetingButton`), the SWR cache invalidates and `useMeeting` in the detail panel returns an error. The detail panel already handles this with "Meeting not found." — acceptable behavior, no special handling needed.

### `MeetingDetailContent.tsx`

- Accept optional `meetingId?: number` prop and `onClose?: () => void` prop
- When `meetingId` prop is provided, use it instead of reading from URL params
- When `onClose` is provided (embedded mode), the "Back to Meetings" button calls `onClose()` **instead of** `router.push("/")` — not in addition to it
- When on standalone `/meetings/[[...id]]` route (no props), behavior is unchanged — reads from URL params, back button navigates to `/`
- Keep the existing `max-w-3xl` constraint on the root div for readability in the right panel

### Unchanged

- `/meetings/[[...id]]` route — still works for direct links and bookmarks, renders full-width `MeetingDetailContent` reading from URL params
- All child components: AudioPlayer, ActionItemsTable, ProcessingProgress, ExportMenu, StatusBadge
- IconSidebar, DayStrip, DayMeetingList, RecordingPanel
- Backend API — no changes

## Selection Behavior

- Clicking a past meeting in the left list highlights it and loads detail in right panel
- Clicking a different meeting swaps the detail — SWR caching makes previously viewed meetings load instantly
- "Back to Meetings" button in embedded mode calls `onClose` to clear `detailMeetingId` and show empty state
- Direct URL access to `/meetings/[id]` still works as a standalone full-width page

## Scope

- **4 files modified:** `layout.tsx` (one-line overflow change), `page.tsx`, `MeetingList.tsx`, `MeetingDetailContent.tsx`
- **0 new files**
- **0 new components**
- **0 backend changes**
- **Existing routes preserved**
