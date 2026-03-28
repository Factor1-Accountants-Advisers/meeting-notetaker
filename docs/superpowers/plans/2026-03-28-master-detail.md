# Master-Detail Dashboard Layout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the dashboard from single-column to master-detail split — clicking a past meeting shows its details in the right panel without page navigation.

**Architecture:** The dashboard page (`page.tsx`) becomes a two-column flex layout. Left panel (400px) holds the existing dashboard content with a redesigned compact meeting list. Right panel (flex-1) embeds `MeetingDetailContent` when a meeting is selected. The standalone `/meetings/[[...id]]` route remains for direct links.

**Tech Stack:** Next.js 14 App Router, React, SWR, Tailwind CSS, Lucide React

**Spec:** `docs/superpowers/specs/2026-03-28-master-detail-design.md`

---

### File Map

| File | Action | Purpose |
|------|--------|---------|
| `web/src/app/(protected)/layout.tsx` | Modify (1 line) | Change `overflow-auto` → `overflow-hidden` on `<main>` |
| `web/src/components/MeetingList.tsx` | Rewrite | Replace 6-column light table with dark compact card list, add selection props |
| `web/src/components/SearchFilter.tsx` | Modify | Fix light-mode styling to dark theme |
| `web/src/components/StatusBadge.tsx` | Modify | Fix light-mode styling to dark theme |
| `web/src/app/(protected)/meetings/[[...id]]/MeetingDetailContent.tsx` | Modify | Accept optional `meetingId` and `onClose` props |
| `web/src/app/(protected)/page.tsx` | Rewrite | Two-column master-detail layout with `detailMeetingId` state |

---

### Task 1: Fix layout overflow and dark theme on leaf components

These are small, independent fixes that unblock the later tasks.

**Files:**
- Modify: `web/src/app/(protected)/layout.tsx:11`
- Modify: `web/src/components/SearchFilter.tsx`
- Modify: `web/src/components/StatusBadge.tsx`

- [ ] **Step 1: Fix layout.tsx overflow**

In `web/src/app/(protected)/layout.tsx`, change line 11:

```tsx
// Before:
<main className="flex-1 p-8 overflow-auto">{children}</main>

// After:
<main className="flex-1 p-8 overflow-hidden">{children}</main>
```

- [ ] **Step 2: Fix SearchFilter dark theme**

In `web/src/components/SearchFilter.tsx`:

The search input (line 32) — replace:
```
flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
```
With:
```
flex-1 px-3 py-2 border border-gray-700 bg-gray-800 text-gray-200 placeholder-gray-500 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
```

The select dropdown (line 37) — replace:
```
px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500
```
With:
```
px-3 py-2 border border-gray-700 bg-gray-800 text-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500
```

- [ ] **Step 3: Fix StatusBadge dark theme**

In `web/src/components/StatusBadge.tsx`, replace the `statusConfig` color values:

```tsx
const statusConfig: Record<string, { label: string; className: string }> = {
  processing: { label: "Processing", className: "bg-blue-900/50 text-blue-300" },
  transcribing: { label: "Transcribing", className: "bg-blue-900/50 text-blue-300" },
  diarising: { label: "Identifying Speakers", className: "bg-purple-900/50 text-purple-300" },
  summarising: { label: "Summarising", className: "bg-yellow-900/50 text-yellow-300" },
  complete: { label: "Complete", className: "bg-green-900/50 text-green-300" },
  failed: { label: "Failed", className: "bg-red-900/50 text-red-300" },
};
```

- [ ] **Step 4: Verify the app still builds**

Run: `cd web && npx next build`
Expected: Build succeeds. The only visual change is darker filter/badge styling.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/(protected)/layout.tsx web/src/components/SearchFilter.tsx web/src/components/StatusBadge.tsx
git commit -m "fix: dark theme for SearchFilter, StatusBadge; prevent nested scrollbars in layout"
```

---

### Task 2: Redesign MeetingList as compact dark card list with selection support

The current `MeetingList` is a 6-column light-mode `<table>` that won't fit in a 400px panel. Replace it with a compact card list that supports optional selection.

**Files:**
- Rewrite: `web/src/components/MeetingList.tsx`

**Prerequisites:** Task 1 (StatusBadge dark theme)

**Current interface (no props):**
```tsx
export default function MeetingList() { ... }
```

**New interface:**
```tsx
interface MeetingListProps {
  onSelectMeeting?: (id: number) => void;
  selectedMeetingId?: number | null;
}
export default function MeetingList({ onSelectMeeting, selectedMeetingId }: MeetingListProps) { ... }
```

- [ ] **Step 1: Rewrite MeetingList**

Replace the full contents of `web/src/components/MeetingList.tsx`:

```tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { useMeetings } from "@/lib/api";
import StatusBadge from "./StatusBadge";
import SearchFilter from "./SearchFilter";
import DeleteMeetingButton from "./DeleteMeetingButton";

function formatDuration(seconds: number | null): string {
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  return `${m} min`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

interface MeetingListProps {
  onSelectMeeting?: (id: number) => void;
  selectedMeetingId?: number | null;
}

export default function MeetingList({
  onSelectMeeting,
  selectedMeetingId,
}: MeetingListProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const { data, error, isLoading } = useMeetings(
    1,
    20,
    statusFilter || undefined
  );

  const hasFilters = search !== "" || statusFilter !== "";

  const filtered = (data?.items ?? []).filter((m) => {
    if (search && !m.title.toLowerCase().includes(search.toLowerCase()))
      return false;
    return true;
  });

  return (
    <div>
      <SearchFilter
        search={search}
        onSearchChange={setSearch}
        statusFilter={statusFilter}
        onStatusChange={setStatusFilter}
      />

      {isLoading && (
        <div className="text-gray-500 text-sm py-4">Loading meetings...</div>
      )}
      {error && (
        <div className="text-red-400 text-sm py-4">
          {error.message || "Failed to load meetings."}
        </div>
      )}
      {!isLoading && !error && filtered.length === 0 && (
        <div className="text-gray-500 text-sm py-4">
          {hasFilters
            ? "No meetings match your filters."
            : "No meetings yet."}
        </div>
      )}

      {filtered.length > 0 && (
        <div className="space-y-2 mt-3">
          {filtered.map((m) => {
            const isSelected = selectedMeetingId === m.id;
            const CardWrapper = onSelectMeeting ? "button" : "div";

            return (
              <CardWrapper
                key={m.id}
                onClick={
                  onSelectMeeting
                    ? () => onSelectMeeting(m.id)
                    : undefined
                }
                className={`w-full text-left relative p-3 rounded-lg border transition-colors ${
                  isSelected
                    ? "border-blue-500/50 bg-blue-950/30 border-l-2 border-l-blue-500"
                    : "border-gray-800 bg-gray-900/50 hover:bg-gray-800/50"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    {onSelectMeeting ? (
                      <span className="text-sm font-medium text-gray-200 block truncate">
                        {m.title}
                      </span>
                    ) : (
                      <Link
                        href={`/meetings/${m.id}`}
                        className="text-sm font-medium text-blue-400 hover:text-blue-300 block truncate"
                      >
                        {m.title}
                      </Link>
                    )}
                    <div className="flex items-center gap-2 mt-1 text-xs text-gray-500">
                      {formatDate(m.scheduled_time) && (
                        <span>{formatDate(m.scheduled_time)}</span>
                      )}
                      {formatDuration(m.duration_seconds) && (
                        <>
                          <span>·</span>
                          <span>{formatDuration(m.duration_seconds)}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <StatusBadge status={m.status} />
                    <DeleteMeetingButton
                      meetingId={m.id}
                      meetingTitle={m.title}
                    />
                  </div>
                </div>
              </CardWrapper>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

Key changes from the old version:
- `<table>` replaced with card list (`space-y-2` div with rounded cards)
- All light-mode classes replaced with dark theme (`bg-gray-900/50`, `border-gray-800`, `text-gray-200`)
- Optional `onSelectMeeting` prop: when provided, cards are `<button>` elements that call the callback; when absent, title is a `<Link>` (backward-compatible)
- Optional `selectedMeetingId` prop: highlights the active card with blue border
- Compact layout: title + date/duration on one card, status badge + delete button right-aligned
- Removed: participants column, full date/time (just month + day now)

- [ ] **Step 2: Verify the app builds and the meeting list still works**

Run: `cd web && npx next build`
Expected: Build succeeds. MeetingList renders without `onSelectMeeting` prop (backward-compatible — titles are links).

- [ ] **Step 3: Commit**

```bash
git add web/src/components/MeetingList.tsx
git commit -m "feat: redesign MeetingList as compact dark card list with selection support"
```

---

### Task 3: Make MeetingDetailContent accept props for embedded mode

Add optional `meetingId` and `onClose` props so the component can be embedded in the dashboard panel.

**Files:**
- Modify: `web/src/app/(protected)/meetings/[[...id]]/MeetingDetailContent.tsx`

- [ ] **Step 1: Add props interface and update the component**

At the top of the component, add the props interface and modify the ID resolution and back button:

```tsx
// Add props interface before the component:
interface MeetingDetailContentProps {
  meetingId?: number;
  onClose?: () => void;
}

// Change the function signature from:
export default function MeetingDetailContent() {

// To:
export default function MeetingDetailContent({
  meetingId: meetingIdProp,
  onClose,
}: MeetingDetailContentProps) {
```

- [ ] **Step 2: Update ID resolution**

Replace lines 51-55 (the params/ID resolution block):

```tsx
// Before:
const params = useParams<{ id: string[] | string }>();
const router = useRouter();
const rawId = params?.id;
const meetingId = Array.isArray(rawId) ? rawId[0] : rawId;
const numericId = meetingId ? Number(meetingId) : undefined;

// After:
const params = useParams<{ id: string[] | string }>();
const router = useRouter();
const rawId = params?.id;
const paramId = Array.isArray(rawId) ? rawId[0] : rawId;
const numericId = meetingIdProp ?? (paramId ? Number(paramId) : undefined);
```

Note: `meetingIdProp` takes precedence over URL params. When embedded in the dashboard, the prop is passed directly. When on the standalone route, it falls back to URL params.

Also update the guard check at line 72. Replace:
```tsx
if (!meetingId) return <div className="text-gray-500">No meeting selected.</div>;
```
With:
```tsx
if (!numericId) return <div className="text-gray-500">No meeting selected.</div>;
```

This is required because the `meetingId` variable was renamed to `paramId` above, so the old reference would cause a compile error.

- [ ] **Step 3: Update the back button**

Replace the back button (around line 92-98):

```tsx
// Before:
<button
  onClick={() => router.push("/")}
  className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-300 mb-6 transition-colors"
>
  <ArrowLeft className="w-4 h-4" />
  Back to Meetings
</button>

// After:
<button
  onClick={() => (onClose ? onClose() : router.push("/"))}
  className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-300 mb-6 transition-colors"
>
  <ArrowLeft className="w-4 h-4" />
  {onClose ? "Close" : "Back to Meetings"}
</button>
```

When `onClose` is provided (embedded mode), it calls the callback and shows "Close". When not provided (standalone route), it navigates to `/` and shows "Back to Meetings".

- [ ] **Step 4: Verify the app builds and the standalone meeting detail route still works**

Run: `cd web && npx next build`
Expected: Build succeeds. The `/meetings/[id]` route works exactly as before (no props passed = URL param mode).

- [ ] **Step 5: Commit**

```bash
git add web/src/app/(protected)/meetings/[[...id]]/MeetingDetailContent.tsx
git commit -m "feat: MeetingDetailContent accepts optional meetingId and onClose props"
```

---

### Task 4: Rewrite dashboard page as master-detail layout

Wire everything together: two-column layout, left panel with existing content, right panel with meeting detail or empty state.

**Files:**
- Rewrite: `web/src/app/(protected)/page.tsx`

**Prerequisites:** Tasks 1, 2, 3

- [ ] **Step 1: Rewrite page.tsx**

Replace the full contents of `web/src/app/(protected)/page.tsx`:

```tsx
"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { Upload, Mic, FileText } from "lucide-react";
import { getElectronAPIOrNull } from "@/lib/electron-bridge";
import { useRecordingStatus } from "@/lib/useRecordingStatus";
import MeetingList from "@/components/MeetingList";
import UploadModal from "@/components/UploadModal";
import DayStrip from "@/components/DayStrip";
import DayMeetingList from "@/components/DayMeetingList";
import RecordingPanel from "@/components/RecordingPanel";
import MeetingDetailContent from "./meetings/[[...id]]/MeetingDetailContent";
import type { CalendarEvent } from "@/types";

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default function DashboardPage() {
  const electron = getElectronAPIOrNull();
  const isElectron = !!electron;
  const { recording } = useRecordingStatus();

  const [showUpload, setShowUpload] = useState(false);
  const [selectedDate, setSelectedDate] = useState(toDateKey(new Date()));
  const [selectedCalendarEvent, setSelectedCalendarEvent] =
    useState<CalendarEvent | null>(null);
  const [showRecordingPanel, setShowRecordingPanel] = useState(false);
  const [detailMeetingId, setDetailMeetingId] = useState<number | null>(null);

  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [calendarError, setCalendarError] = useState<string | null>(null);

  const fetchCalendar = useCallback(async () => {
    if (!electron) return;
    setCalendarLoading(true);
    setCalendarError(null);
    try {
      const events = await electron.getCalendar();
      setCalendarEvents(events);
    } catch {
      setCalendarError("Could not load calendar");
    } finally {
      setCalendarLoading(false);
    }
  }, [electron]);

  useEffect(() => {
    if (isElectron) fetchCalendar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dayMeetings = useMemo(
    () =>
      calendarEvents.filter(
        (m) => new Date(m.start).toISOString().slice(0, 10) === selectedDate
      ),
    [calendarEvents, selectedDate]
  );

  const selectedDateLabel = useMemo(() => {
    const d = new Date(selectedDate + "T00:00:00");
    return d.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }, [selectedDate]);

  const handleSelectMeeting = (meeting: CalendarEvent) => {
    setSelectedCalendarEvent(meeting);
    setShowRecordingPanel(true);
  };

  const handleStartAdHoc = () => {
    setSelectedCalendarEvent(null);
    setShowRecordingPanel(true);
  };

  const handleDismissPanel = () => {
    setShowRecordingPanel(false);
    setSelectedCalendarEvent(null);
  };

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="flex gap-6 h-[calc(100vh-4rem)]">
      {/* Left Panel */}
      <div className="w-[400px] flex-shrink-0 overflow-y-auto pr-2">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-gray-100">Note Taker</h1>
            <p className="text-sm text-gray-500 mt-0.5">{today}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowUpload(true)}
              disabled={recording}
              className="px-3 py-1.5 text-sm font-medium text-gray-300 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded-lg flex items-center gap-1.5 transition-colors"
            >
              <Upload className="w-3.5 h-3.5" />
              Upload
            </button>
            {isElectron && (
              <button
                onClick={handleStartAdHoc}
                disabled={recording}
                className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg flex items-center gap-1.5 transition-colors"
              >
                <Mic className="w-3.5 h-3.5" />
                Record
              </button>
            )}
          </div>
        </div>

        {recording && (
          <div className="flex items-center gap-1.5 mb-4">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="text-xs font-medium text-red-400">Recording</span>
          </div>
        )}

        {/* Upcoming Meetings — Electron only */}
        {isElectron && (
          <section
            className={`mb-6 ${recording ? "opacity-50 pointer-events-none" : ""}`}
          >
            <DayStrip
              meetings={calendarEvents}
              selectedDate={selectedDate}
              onSelectDate={setSelectedDate}
              loading={calendarLoading}
              error={calendarError}
              onRetry={fetchCalendar}
              onRefresh={fetchCalendar}
            />
            <DayMeetingList
              meetings={dayMeetings}
              selectedMeetingId={selectedCalendarEvent?.id ?? null}
              onSelectMeeting={handleSelectMeeting}
              dateLabel={selectedDateLabel}
            />
          </section>
        )}

        {/* Recording Panel */}
        {showRecordingPanel && isElectron && (
          <section className="mb-6">
            <RecordingPanel
              selectedMeeting={selectedCalendarEvent}
              onDismiss={handleDismissPanel}
            />
          </section>
        )}

        {/* Divider */}
        <hr className="border-gray-800 mb-6" />

        {/* Past Meetings */}
        <section>
          <MeetingList
            onSelectMeeting={setDetailMeetingId}
            selectedMeetingId={detailMeetingId}
          />
        </section>
      </div>

      {/* Right Panel */}
      <div className="flex-1 overflow-y-auto border-l border-gray-800 pl-6">
        {detailMeetingId ? (
          <MeetingDetailContent
            meetingId={detailMeetingId}
            onClose={() => setDetailMeetingId(null)}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-gray-600">
            <FileText className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm">Select a meeting to view details</p>
          </div>
        )}
      </div>

      {/* Upload Modal */}
      {showUpload && <UploadModal onClose={() => setShowUpload(false)} />}
    </div>
  );
}
```

Key changes from the old version:
- Layout: `max-w-4xl` single column → `flex gap-6 h-[calc(100vh-4rem)]` two-column
- State: `selectedMeeting` renamed to `selectedCalendarEvent` (avoids confusion with `detailMeetingId`)
- New state: `detailMeetingId` controls which meeting is shown in the right panel
- Left panel: `w-[400px] flex-shrink-0 overflow-y-auto` with all existing content
- Right panel: `flex-1 overflow-y-auto` with `MeetingDetailContent` or empty state
- Buttons slightly more compact (`px-3 py-1.5`, shorter labels) to fit the narrower panel
- `MeetingDetailContent` imported directly from its file path and rendered inline with `meetingId` and `onClose` props
- Margins reduced from `mb-8` to `mb-6` to fit the narrower panel

- [ ] **Step 2: Verify the app builds**

Run: `cd web && npx next build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/(protected)/page.tsx
git commit -m "feat: master-detail dashboard layout with inline meeting detail panel"
```

---

### Task 5: Final verification

**Prerequisites:** All previous tasks

- [ ] **Step 1: Full build**

Run: `cd web && npx next build`
Expected: Build succeeds with no errors.

- [ ] **Step 2: TypeScript check**

Run: `cd web && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Backend tests**

Run: `cd backend && python -m pytest tests/test_retry_endpoint.py -v`
Expected: 3/3 pass (our tests from the UI redesign branch).

- [ ] **Step 4: Visual smoke test**

Start the dev servers and verify in the Electron app:
1. Dashboard shows two-column layout
2. Left panel: header, day strip, calendar meetings, divider, past meetings list
3. Right panel: "Select a meeting to view details" empty state
4. Click a past meeting → detail loads in right panel with summary, action items, transcript
5. Click a different meeting → detail swaps
6. Click "Close" button in detail → returns to empty state
7. Direct URL `/meetings/[id]` still works as standalone full-width page
