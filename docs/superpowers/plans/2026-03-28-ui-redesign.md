# UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cluttered sidebar + tabbed meeting detail with a slim icon rail, 7-day calendar strip, recording panel, and single-scroll meeting detail with progressive processing feedback.

**Architecture:** Slim icon sidebar replaces full-width nav. Dashboard moves calendar + recording into the main panel. Meeting detail replaces tabs with a single scrollable page that progressively reveals content as the Celery pipeline completes, using SWR polling.

**Tech Stack:** Next.js 14 (App Router), TypeScript, Tailwind CSS, SWR, Lucide React, Electron IPC, FastAPI, Celery

**Spec:** `docs/superpowers/specs/2026-03-28-ui-redesign-design.md`

---

## File Map

### New Files
| File | Responsibility |
|------|---------------|
| `web/src/components/IconSidebar.tsx` | 56px icon-only nav rail with tooltips and active state |
| `web/src/components/DayStrip.tsx` | 7-day horizontal calendar pill strip with selection, meeting dots, loading/error states |
| `web/src/components/DayMeetingList.tsx` | Meeting cards for a selected day, with "Select" pill for recording |
| `web/src/components/RecordingPanel.tsx` | Three-state component: pre-filled ready, ad-hoc form, active recording |
| `web/src/components/ProcessingProgress.tsx` | Pipeline progress card with step checklist mapped to MeetingStatus enum |

### Modified Files
| File | Change |
|------|--------|
| `web/src/app/(protected)/layout.tsx` | Swap `Nav` → `IconSidebar`, remove `RecordingStatusBar` |
| `web/src/app/(protected)/page.tsx` | Full rewrite: dashboard with header, day strip, recording panel, past meetings |
| `web/src/app/(protected)/meetings/[[...id]]/MeetingDetailContent.tsx` | Replace tabbed layout with single-scroll layout + SWR polling |
| `web/src/lib/api.ts` | Add `SWRConfiguration` param to `useMeeting`, add `retryMeeting()` mutation |
| `web/src/components/UploadModal.tsx` | Make attendees required, add `File.lastModified` date default |
| `web/src/components/MeetingList.tsx` | Add "Past Meetings" section heading, empty state |
| `desktop/src/main/graph.ts` | Change query window from 8h → 7 days |
| `backend/app/schemas.py` | Make `MeetingUploadMetadata.attendees` require `min_length=1` |
| `backend/app/routers/meetings.py` | Add `POST /api/meetings/{id}/retry` endpoint |

### Removed Files (delete after replacement is wired)
| File | Replaced By |
|------|------------|
| `web/src/components/CalendarPanel.tsx` | `DayStrip.tsx` + `DayMeetingList.tsx` |
| `web/src/components/RecordingControls.tsx` | `RecordingPanel.tsx` |
| `web/src/components/RecordingStatusBar.tsx` | Recording indicator in dashboard header |
| `web/src/components/Nav.tsx` | `IconSidebar.tsx` |
| `web/src/components/MeetingHeader.tsx` | Inlined into `MeetingDetailContent.tsx` |
| `web/src/components/SummaryView.tsx` | Inlined into `MeetingDetailContent.tsx` |
| `web/src/components/TranscriptView.tsx` | Inlined into `MeetingDetailContent.tsx` |

### Retained Files (no changes)
- `web/src/components/ExportMenu.tsx`
- `web/src/components/DeleteMeetingButton.tsx`
- `web/src/components/SearchFilter.tsx`
- `web/src/components/StatusBadge.tsx`
- `web/src/components/AudioPlayer.tsx`
- `web/src/components/ActionItemsTable.tsx`

---

## Task 1: Install Lucide React + Fix Graph API Window

**Files:**
- Modify: `web/package.json`
- Modify: `desktop/src/main/graph.ts:22`

These are two small, independent foundation changes that unblock the rest.

- [ ] **Step 1: Install lucide-react**

```bash
cd web && npm install lucide-react
```

Verify it's in `package.json` under `dependencies`.

- [ ] **Step 2: Fix Graph API query window**

In `desktop/src/main/graph.ts`, line 22, change:
```typescript
// FROM:
endDateTime: new Date(now.getTime() + 8 * 3600000).toISOString(),
// TO:
endDateTime: new Date(now.getTime() + 7 * 24 * 3600000).toISOString(),
```

This changes the calendar view from "next 8 hours" to "next 7 days", fixing the root cause of "No upcoming meetings."

- [ ] **Step 3: Commit**

```bash
git add web/package.json web/package-lock.json desktop/src/main/graph.ts
git commit -m "feat: install lucide-react, extend Graph API window to 7 days"
```

---

## Task 2: Backend — Attendees Validation + Retry Endpoint

**Files:**
- Modify: `backend/app/schemas.py:53`
- Modify: `backend/app/routers/meetings.py`
- Test: `backend/tests/test_retry_endpoint.py`

- [ ] **Step 1: Write test for attendees validation**

**Note:** Check `backend/tests/conftest.py` for the exact fixture names and patterns (sync vs async). The tests below use the project's existing test conventions. Adapt `client` fixture name and `db_session` to match conftest. If tests use synchronous `TestClient` (from `starlette.testclient`), convert the async patterns below to sync. If they use `httpx.AsyncClient`, use async as shown.

Create `backend/tests/test_attendees_validation.py`:

```python
"""Test that upload requires at least one attendee."""
import json
from io import BytesIO


def test_upload_rejects_empty_attendees(client, sample_audio):
    """POST /api/meetings/upload should reject requests with zero attendees."""
    metadata = json.dumps({
        "meeting_title": "Test Meeting",
        "attendees": [],  # empty — should fail
    })

    response = client.post(
        "/api/meetings/upload",
        files={"audio_file": ("test.wav", BytesIO(sample_audio), "audio/wav")},
        data={"metadata": metadata},
    )
    assert response.status_code == 422
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && python -m pytest tests/test_attendees_validation.py -v
```

Expected: FAIL (currently accepts empty attendees).

- [ ] **Step 3: Make attendees required in schema**

In `backend/app/schemas.py`, line 53, change:
```python
# FROM:
attendees: List[ParticipantBase] = Field(default_factory=list)
# TO:
attendees: List[ParticipantBase] = Field(..., min_length=1)
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && python -m pytest tests/test_attendees_validation.py -v
```

Expected: PASS.

- [ ] **Step 5: Write test for retry endpoint**

Create `backend/tests/test_retry_endpoint.py`:

**Note:** Adapt fixtures to match conftest.py conventions (sync/async). Example shown with sync style matching existing test patterns.

```python
"""Test the meeting retry endpoint."""
from unittest.mock import patch

from app.models import Meeting, MeetingStatus


def test_retry_requeues_failed_meeting(client, db_session):
    """POST /api/meetings/{id}/retry should reset status and re-enqueue."""
    # Get the test user (created by fixture)
    user = db_session.query(Meeting).first().user_id if db_session.query(Meeting).first() else 1

    # Create a failed meeting
    meeting = Meeting(
        title="Failed Meeting",
        status=MeetingStatus.FAILED,
        audio_blob_url="audio/test.wav",
        user_id=user,
    )
    db_session.add(meeting)
    db_session.commit()
    db_session.refresh(meeting)

    with patch("app.routers.meetings.process_meeting") as mock_task:
        mock_task.delay.return_value.id = "mock-task-id"
        response = client.post(f"/api/meetings/{meeting.id}/retry")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "processing"
    mock_task.delay.assert_called_once_with(meeting.id)


def test_retry_rejects_non_failed_meeting(client, db_session):
    """Cannot retry a meeting that isn't in FAILED state."""
    meeting = Meeting(
        title="Processing Meeting",
        status=MeetingStatus.PROCESSING,
        audio_blob_url="audio/test.wav",
        user_id=1,
    )
    db_session.add(meeting)
    db_session.commit()
    db_session.refresh(meeting)

    response = client.post(f"/api/meetings/{meeting.id}/retry")
    assert response.status_code == 409
```

- [ ] **Step 6: Run test to verify it fails**

```bash
cd backend && python -m pytest tests/test_retry_endpoint.py -v
```

Expected: FAIL (endpoint doesn't exist yet).

- [ ] **Step 7: Implement retry endpoint**

In `backend/app/routers/meetings.py`, add after the delete endpoint:

```python
@router.post("/api/meetings/{meeting_id}/retry", response_model=MeetingUploadResponse)
async def retry_meeting(
    meeting_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Re-enqueue a failed meeting for processing."""
    meeting = await db.get(Meeting, meeting_id)
    if not meeting or meeting.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Meeting not found")

    if meeting.status != MeetingStatus.FAILED:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot retry meeting in '{meeting.status.value}' state — only failed meetings can be retried",
        )

    meeting.status = MeetingStatus.PROCESSING
    await db.commit()

    task = process_meeting.delay(meeting.id)
    logger.info(f"Retry task enqueued: {task.id} for meeting {meeting.id}")

    return MeetingUploadResponse(meeting_id=meeting.id, status="processing")
```

Ensure `process_meeting` is imported at the top of the file (it already is for the upload endpoint).

- [ ] **Step 8: Run tests to verify they pass**

```bash
cd backend && python -m pytest tests/test_retry_endpoint.py tests/test_attendees_validation.py -v
```

Expected: All PASS.

- [ ] **Step 9: Run full backend test suite**

```bash
cd backend && python -m pytest -v
```

Expected: All existing tests still pass.

- [ ] **Step 10: Commit**

```bash
git add backend/app/schemas.py backend/app/routers/meetings.py backend/tests/test_retry_endpoint.py backend/tests/test_attendees_validation.py
git commit -m "feat: require attendees on upload, add POST /meetings/{id}/retry endpoint"
```

---

## Task 3: Update `useMeeting` Hook + Add `retryMeeting` Mutation

**Files:**
- Modify: `web/src/lib/api.ts:1,76-78`

- [ ] **Step 1: Add SWRConfiguration to imports**

In `web/src/lib/api.ts`, line 1, change:
```typescript
// FROM:
import useSWR, { SWRResponse } from "swr";
// TO:
import useSWR, { SWRResponse, SWRConfiguration } from "swr";
```

- [ ] **Step 2: Update useMeeting signature**

In `web/src/lib/api.ts`, lines 76-78, change:
```typescript
// FROM:
export function useMeeting(id: number | undefined): SWRResponse<MeetingDetail> {
  return useSWR(id != null ? `/api/meetings/${id}` : null, fetcher);
}
// TO:
export function useMeeting(
  id: number | undefined,
  options?: SWRConfiguration
): SWRResponse<MeetingDetail> {
  return useSWR(id != null ? `/api/meetings/${id}` : null, fetcher, options);
}
```

- [ ] **Step 3: Add retryMeeting mutation**

Add after the `deleteMeeting` function (after line 155):

```typescript
export async function retryMeeting(id: number): Promise<{ meeting_id: number; status: string }> {
  const headers = await authHeaders();
  const res = await fetch(`/api/meetings/${id}/retry`, {
    method: "POST",
    headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Retry failed: ${res.status}`);
  }
  return res.json();
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd web && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/api.ts
git commit -m "feat: add SWR polling support to useMeeting, add retryMeeting mutation"
```

---

## Task 4: IconSidebar Component

**Files:**
- Create: `web/src/components/IconSidebar.tsx`
- Modify: `web/src/app/(protected)/layout.tsx`

The sidebar is a standalone component with no data dependencies, making it safe to build and wire early.

- [ ] **Step 1: Create IconSidebar**

Create `web/src/components/IconSidebar.tsx`:

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Calendar, CheckSquare, Settings, PenTool } from "lucide-react";
import { useAuth } from "@/lib/useAuth";

const navItems = [
  { href: "/", label: "Meetings", icon: Calendar },
  { href: "/action-items", label: "Action Items", icon: CheckSquare },
  { href: "/settings", label: "Settings", icon: Settings },
];

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export default function IconSidebar() {
  const pathname = usePathname();
  const { user } = useAuth();

  return (
    <nav className="w-14 bg-gray-900 flex flex-col items-center py-4 min-h-screen gap-1">
      {/* Brand mark */}
      <div className="mb-6 text-gray-400">
        <PenTool className="w-6 h-6" />
      </div>

      {/* Nav icons */}
      {navItems.map((item) => {
        const active =
          item.href === "/"
            ? pathname === "/" || pathname.startsWith("/meetings")
            : pathname.startsWith(item.href);
        const Icon = item.icon;

        return (
          <Link
            key={item.href}
            href={item.href}
            title={item.label}
            aria-label={item.label}
            className={`w-10 h-10 flex items-center justify-center rounded-lg transition-colors ${
              active
                ? "bg-blue-600/20 text-blue-400"
                : "text-gray-500 hover:bg-gray-800 hover:text-gray-300"
            }`}
          >
            <Icon className="w-5 h-5" />
          </Link>
        );
      })}

      {/* Spacer */}
      <div className="flex-1" />

      {/* User avatar */}
      {user && (
        <Link
          href="/settings"
          title={user.name}
          aria-label={`${user.name} — Settings`}
          className="w-9 h-9 rounded-full bg-gray-700 text-gray-300 text-xs font-medium flex items-center justify-center hover:bg-gray-600 transition-colors"
        >
          {getInitials(user.name)}
        </Link>
      )}
    </nav>
  );
}
```

- [ ] **Step 2: Wire IconSidebar into layout**

Replace the entire contents of `web/src/app/(protected)/layout.tsx`:

```tsx
import AuthGuard from "@/components/AuthGuard";
import IconSidebar from "@/components/IconSidebar";

export default function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      <div className="flex min-h-screen bg-gray-950">
        <IconSidebar />
        <main className="flex-1 p-8 overflow-auto">{children}</main>
      </div>
    </AuthGuard>
  );
}
```

This removes `Nav` and `RecordingStatusBar` from the layout. The recording indicator will live in the dashboard page header instead.

- [ ] **Step 3: Verify app compiles and sidebar renders**

```bash
cd web && npm run build
```

Expected: Build succeeds. The sidebar should render as a slim icon rail.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/IconSidebar.tsx web/src/app/\(protected\)/layout.tsx
git commit -m "feat: replace full-width Nav with slim IconSidebar"
```

---

## Task 5: DayStrip Component

**Files:**
- Create: `web/src/components/DayStrip.tsx`

This is a pure presentational component. It accepts `meetings`, `selectedDate`, `onSelectDate`, plus loading/error state props. No data fetching inside it.

- [ ] **Step 1: Create DayStrip**

Create `web/src/components/DayStrip.tsx`:

```tsx
"use client";

import { useMemo } from "react";
import { RefreshCw } from "lucide-react";
import type { CalendarEvent } from "@/types";

interface DayStripProps {
  meetings: CalendarEvent[];
  selectedDate: string; // ISO date string "YYYY-MM-DD"
  onSelectDate: (date: string) => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onRefresh?: () => void;
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function getDayLabel(d: Date, today: Date): string {
  if (toDateKey(d) === toDateKey(today)) return "Today";
  return d.toLocaleDateString("en-US", { weekday: "short" });
}

function isWeekend(d: Date): boolean {
  const day = d.getDay();
  return day === 0 || day === 6;
}

export default function DayStrip({
  meetings,
  selectedDate,
  onSelectDate,
  loading,
  error,
  onRetry,
  onRefresh,
}: DayStripProps) {
  const today = useMemo(() => new Date(), []);

  // Generate 7 days starting from today
  const days = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, [today]);

  // Map date keys → meeting count
  const meetingCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const m of meetings) {
      const key = new Date(m.start).toISOString().slice(0, 10);
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }, [meetings]);

  if (error) {
    return (
      <div className="text-center py-6">
        <p className="text-sm text-red-400 mb-2">Could not load calendar</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="text-sm text-blue-400 hover:text-blue-300"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">
          Upcoming Meetings
        </h2>
        {onRefresh && (
          <button
            onClick={onRefresh}
            className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
          >
            <RefreshCw className="w-3 h-3" />
            Refresh
          </button>
        )}
      </div>

      <div className="flex gap-2">
        {loading
          ? Array.from({ length: 7 }, (_, i) => (
              <div
                key={i}
                className="w-14 h-16 rounded-xl bg-gray-800 animate-pulse"
              />
            ))
          : days.map((d) => {
              const key = toDateKey(d);
              const isSelected = key === selectedDate;
              const isToday = toDateKey(d) === toDateKey(today);
              const count = meetingCounts[key] || 0;
              const weekend = isWeekend(d);

              return (
                <button
                  key={key}
                  onClick={() => onSelectDate(key)}
                  className={`w-14 h-16 rounded-xl flex flex-col items-center justify-center gap-0.5 text-xs transition-all ${
                    isSelected
                      ? "bg-blue-600 text-white shadow-lg shadow-blue-600/30"
                      : isToday
                        ? "bg-blue-600/10 text-blue-400 border border-blue-500/30"
                        : "bg-gray-800/50 hover:bg-gray-800"
                  } ${weekend && !isSelected && !isToday ? "opacity-60" : ""}`}
                >
                  <span className="text-[10px] font-medium uppercase">
                    {getDayLabel(d, today)}
                  </span>
                  <span className="text-lg font-bold">{d.getDate()}</span>
                  {count > 0 && (
                    <div className="flex gap-0.5">
                      {Array.from({ length: Math.min(count, 3) }, (_, i) => (
                        <div
                          key={i}
                          className={`w-1 h-1 rounded-full ${
                            isSelected ? "bg-white/70" : "bg-blue-400"
                          }`}
                        />
                      ))}
                    </div>
                  )}
                </button>
              );
            })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd web && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/DayStrip.tsx
git commit -m "feat: add DayStrip calendar pill strip component"
```

---

## Task 6: DayMeetingList Component

**Files:**
- Create: `web/src/components/DayMeetingList.tsx`

Shows meeting cards for a selected day. Accepts `meetings` (pre-filtered for the day), `selectedMeetingId`, and `onSelectMeeting` callback.

- [ ] **Step 1: Create DayMeetingList**

Create `web/src/components/DayMeetingList.tsx`:

```tsx
"use client";

import { Check } from "lucide-react";
import type { CalendarEvent } from "@/types";

interface DayMeetingListProps {
  meetings: CalendarEvent[];
  selectedMeetingId: string | null;
  onSelectMeeting: (meeting: CalendarEvent) => void;
  dateLabel: string; // e.g. "Monday, March 31"
}

/** Consistent accent colors for meeting cards */
const ACCENT_COLORS = [
  "border-blue-500",
  "border-purple-500",
  "border-emerald-500",
  "border-amber-500",
  "border-rose-500",
];

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
}

export default function DayMeetingList({
  meetings,
  selectedMeetingId,
  onSelectMeeting,
  dateLabel,
}: DayMeetingListProps) {
  return (
    <div className="mt-4">
      <p className="text-xs text-gray-500 font-medium mb-3">{dateLabel}</p>

      {meetings.length === 0 ? (
        <p className="text-sm text-gray-600 italic">No meetings scheduled</p>
      ) : (
        <div className="space-y-2">
          {meetings.map((meeting, i) => {
            const isSelected = meeting.id === selectedMeetingId;
            const accent = ACCENT_COLORS[i % ACCENT_COLORS.length];

            return (
              <button
                key={meeting.id}
                onClick={() => onSelectMeeting(meeting)}
                className={`w-full text-left p-3 rounded-lg border-l-4 ${accent} transition-all ${
                  isSelected
                    ? "bg-blue-600/10 ring-1 ring-blue-500/30"
                    : "bg-gray-800/40 hover:bg-gray-800/70"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-200 truncate">
                    {meeting.subject}
                  </span>
                  {isSelected ? (
                    <Check className="w-4 h-4 text-blue-400 flex-shrink-0" />
                  ) : (
                    <span className="text-[10px] text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full flex-shrink-0">
                      Select
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-1 text-xs text-gray-500">
                  <span>
                    {formatTime(meeting.start)} – {formatTime(meeting.end)}
                  </span>
                  <span>·</span>
                  <span>{formatDuration(meeting.start, meeting.end)}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd web && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add web/src/components/DayMeetingList.tsx
git commit -m "feat: add DayMeetingList component for calendar day meetings"
```

---

## Task 7: RecordingPanel Component

**Files:**
- Create: `web/src/components/RecordingPanel.tsx`

Single component with three visual states: pre-filled (calendar meeting selected), ad-hoc form (no meeting), and active recording. Uses Electron bridge for recording controls.

**Prerequisite:** The current `ElectronAPI.stopRecording()` returns `Promise<void>`. The RecordingPanel needs it to return `Promise<{ meetingId: number } | void>` so it can navigate to the meeting detail page after upload. Before creating this component:
1. Update `web/src/lib/electron-bridge.ts`: change `stopRecording` type to `() => Promise<{ meetingId: number } | void>`
2. Update `desktop/src/renderer/preload-web.ts`: ensure the IPC handler returns the upload result
3. Update `desktop/src/main/ipc.ts` `recorder:stop` handler: after stopping + uploading, return `{ meetingId }` from the upload response

If the Electron IPC changes are deferred, the `handleStop` function below should fall back to navigating to `/` instead of `/meetings/{id}`.

- [ ] **Step 1: Create RecordingPanel**

Create `web/src/components/RecordingPanel.tsx`:

```tsx
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Mic, Volume2, X, CircleDot, Square, AlertCircle } from "lucide-react";
import { getElectronAPIOrNull } from "@/lib/electron-bridge";
import { useRecordingStatus } from "@/lib/useRecordingStatus";
import type { CalendarEvent } from "@/types";

type PanelMode = "prefilled" | "adhoc" | "recording";

interface RecordingPanelProps {
  selectedMeeting: CalendarEvent | null;
  onDismiss: () => void;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export default function RecordingPanel({
  selectedMeeting,
  onDismiss,
}: RecordingPanelProps) {
  const router = useRouter();
  const electron = getElectronAPIOrNull();
  const { recording, elapsed } = useRecordingStatus();

  // Ad-hoc form state
  const [title, setTitle] = useState("");
  const [attendees, setAttendees] = useState<string[]>([]);
  const [attendeeInput, setAttendeeInput] = useState("");

  // Error states
  const [error, setError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const mode: PanelMode = recording
    ? "recording"
    : selectedMeeting
      ? "prefilled"
      : "adhoc";

  const meetingTitle = selectedMeeting?.subject ?? title;
  const meetingAttendees = selectedMeeting
    ? selectedMeeting.attendees.map((a) => a.name)
    : attendees;

  const canStart =
    mode === "prefilled" || (title.trim() !== "" && attendees.length > 0);

  const handleAddAttendee = useCallback(() => {
    const name = attendeeInput.trim();
    if (name && !attendees.includes(name)) {
      setAttendees((prev) => [...prev, name]);
    }
    setAttendeeInput("");
  }, [attendeeInput, attendees]);

  const handleRemoveAttendee = (name: string) => {
    setAttendees((prev) => prev.filter((a) => a !== name));
  };

  const handleStart = async () => {
    if (!electron) return;
    setError(null);
    try {
      const devices = await electron.getAudioDevices();
      await electron.startRecording({
        meetingTitle,
        micDevice: devices?.[0] || "default",
      });
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : "Microphone access denied. Check your system permissions."
      );
    }
  };

  const handleStop = async () => {
    if (!electron) return;
    setUploadError(null);
    try {
      const result = await electron.stopRecording();
      if (result?.meetingId) {
        router.push(`/meetings/${result.meetingId}`);
      }
    } catch (err: unknown) {
      setUploadError(
        err instanceof Error
          ? err.message
          : "Failed to upload recording. Your file is saved locally."
      );
    }
  };

  // ── Active recording state ──
  if (mode === "recording") {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="text-xs font-semibold text-red-400 uppercase tracking-wide">
              Recording in Progress
            </span>
          </div>
        </div>

        <p className="text-sm font-medium text-gray-200 mb-1">{meetingTitle}</p>

        <div className="text-4xl font-mono font-bold text-gray-100 my-4">
          {formatElapsed(elapsed)}
        </div>

        {/* Simulated audio levels */}
        <div className="flex gap-4 mb-4 text-xs text-gray-500">
          <div className="flex items-center gap-1.5">
            <Mic className="w-3 h-3" />
            <div className="flex gap-px items-end h-3">
              {[3, 5, 8, 6, 4, 7, 5].map((h, i) => (
                <div
                  key={i}
                  className="w-1 bg-green-500/60 rounded-full"
                  style={{ height: `${h * 1.5}px` }}
                />
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Volume2 className="w-3 h-3" />
            <div className="flex gap-px items-end h-3">
              {[4, 7, 5, 8, 6, 3, 7].map((h, i) => (
                <div
                  key={i}
                  className="w-1 bg-green-500/60 rounded-full"
                  style={{ height: `${h * 1.5}px` }}
                />
              ))}
            </div>
          </div>
        </div>

        {uploadError && (
          <div className="flex items-start gap-2 p-3 mb-3 rounded-lg bg-red-500/10 border border-red-500/20">
            <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-xs text-red-300">{uploadError}</p>
              <button
                onClick={handleStop}
                className="text-xs text-blue-400 hover:text-blue-300 mt-1"
              >
                Retry Upload
              </button>
            </div>
          </div>
        )}

        <button
          onClick={handleStop}
          className="w-full py-3 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold rounded-xl flex items-center justify-center gap-2 transition-colors"
        >
          <Square className="w-4 h-4" fill="currentColor" />
          Stop Recording
        </button>
      </div>
    );
  }

  // ── Ready state (pre-filled or ad-hoc) ──
  return (
    <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-5">
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs font-semibold text-blue-400 uppercase tracking-wide">
          {mode === "prefilled" ? "Ready to Record" : "New Recording"}
        </span>
        <button onClick={onDismiss} className="text-gray-600 hover:text-gray-400">
          <X className="w-4 h-4" />
        </button>
      </div>

      {mode === "prefilled" && selectedMeeting ? (
        // Pre-filled from calendar
        <div className="mb-4">
          <p className="text-sm font-medium text-gray-200">
            {selectedMeeting.subject}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            {new Date(selectedMeeting.start).toLocaleDateString("en-US", {
              weekday: "short",
              month: "short",
              day: "numeric",
            })}{" "}
            · {new Date(selectedMeeting.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
            {" – "}
            {new Date(selectedMeeting.end).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">
            {selectedMeeting.attendees.map((a) => a.name).join(", ")}
          </p>
        </div>
      ) : (
        // Ad-hoc form
        <div className="space-y-3 mb-4">
          <div>
            <label className="text-xs text-gray-500 font-medium block mb-1">
              Meeting Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Quick sync with David"
              className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-gray-200 placeholder:text-gray-600 outline-none focus:border-blue-500/40"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 font-medium block mb-1">
              Attendees
            </label>
            <div className="w-full px-2.5 py-1.5 bg-white/5 border border-white/10 rounded-lg min-h-[38px] flex flex-wrap gap-1 items-center">
              {attendees.map((name) => (
                <span
                  key={name}
                  className="bg-blue-500/15 text-blue-300 px-2 py-0.5 rounded text-xs flex items-center gap-1"
                >
                  {name}
                  <button
                    onClick={() => handleRemoveAttendee(name)}
                    className="opacity-60 hover:opacity-100"
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                type="text"
                value={attendeeInput}
                onChange={(e) => setAttendeeInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddAttendee();
                  }
                }}
                placeholder={attendees.length === 0 ? "Add name..." : ""}
                className="flex-1 min-w-[80px] bg-transparent text-xs text-gray-200 outline-none placeholder:text-gray-600 py-0.5"
              />
            </div>
            <p className="text-[10px] text-gray-600 mt-1">
              Press Enter to add. Helps identify speakers in the transcript.
            </p>
          </div>
        </div>
      )}

      {/* Device info */}
      <div className="flex gap-4 mb-4 text-xs text-gray-500">
        <span className="flex items-center gap-1">
          <Mic className="w-3 h-3" /> Microphone
        </span>
        <span className="flex items-center gap-1">
          <Volume2 className="w-3 h-3" /> System Audio
        </span>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 mb-3 rounded-lg bg-red-500/10 border border-red-500/20">
          <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-red-300">{error}</p>
        </div>
      )}

      <button
        onClick={handleStart}
        disabled={!canStart}
        className="w-full py-3.5 bg-red-600 hover:bg-red-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-semibold rounded-xl flex items-center justify-center gap-2 transition-colors shadow-lg shadow-red-600/20 disabled:shadow-none"
      >
        <CircleDot className="w-4 h-4" />
        Start Recording
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd web && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add web/src/components/RecordingPanel.tsx
git commit -m "feat: add RecordingPanel with pre-filled, ad-hoc, and active states"
```

---

## Task 8: ProcessingProgress Component

**Files:**
- Create: `web/src/components/ProcessingProgress.tsx`

Displays pipeline progress as a vertical checklist mapped to `MeetingStatus` enum values.

- [ ] **Step 1: Create ProcessingProgress**

Create `web/src/components/ProcessingProgress.tsx`:

```tsx
"use client";

import { Loader2, CheckCircle2, XCircle, AlertCircle } from "lucide-react";
import { retryMeeting } from "@/lib/api";
import { useSWRConfig } from "swr";
import { useState } from "react";

interface ProcessingProgressProps {
  meetingId: number;
  status: string;
}

type StepState = "done" | "active" | "pending";

interface PipelineStep {
  label: string;
  state: StepState;
}

function getSteps(status: string): PipelineStep[] {
  const steps: { key: string; label: string }[] = [
    { key: "processing", label: "Preparing audio" },
    { key: "transcribing", label: "Transcribing audio" },
    { key: "diarising", label: "Identifying speakers" },
    { key: "summarising", label: "Generating summary & action items" },
  ];

  const statusOrder = ["processing", "transcribing", "diarising", "summarising", "complete"];
  const currentIdx = statusOrder.indexOf(status);

  return steps.map((step, i) => {
    const stepIdx = statusOrder.indexOf(step.key);
    if (currentIdx > stepIdx) return { label: step.label, state: "done" as const };
    if (currentIdx === stepIdx) return { label: step.label, state: "active" as const };
    return { label: step.label, state: "pending" as const };
  });
}

export default function ProcessingProgress({
  meetingId,
  status,
}: ProcessingProgressProps) {
  const { mutate } = useSWRConfig();
  const [retrying, setRetrying] = useState(false);

  if (status === "complete") return null;

  const isFailed = status === "failed";

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await retryMeeting(meetingId);
      await mutate(`/api/meetings/${meetingId}`);
    } catch {
      // error shown via SWR revalidation
    } finally {
      setRetrying(false);
    }
  };

  if (isFailed) {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-5">
        <div className="flex items-center gap-2 mb-2">
          <XCircle className="w-5 h-5 text-red-400" />
          <h3 className="text-sm font-semibold text-red-300">
            Processing failed
          </h3>
        </div>
        <p className="text-xs text-gray-400 mb-3">
          Something went wrong while processing your meeting. You can try again.
        </p>
        <button
          onClick={handleRetry}
          disabled={retrying}
          className="px-4 py-2 text-xs font-medium text-white bg-red-600 hover:bg-red-700 disabled:bg-gray-700 rounded-lg transition-colors"
        >
          {retrying ? "Retrying..." : "Retry Processing"}
        </button>
      </div>
    );
  }

  const steps = getSteps(status);

  return (
    <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-5">
      <div className="flex items-center gap-2 mb-4">
        <Loader2 className="w-5 h-5 text-blue-400 animate-spin" />
        <h3 className="text-sm font-semibold text-blue-300">
          Processing your meeting...
        </h3>
      </div>

      <div className="space-y-3">
        {steps.map((step, i) => (
          <div key={i} className="flex items-center gap-3">
            {step.state === "done" && (
              <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />
            )}
            {step.state === "active" && (
              <Loader2 className="w-4 h-4 text-blue-400 animate-spin flex-shrink-0" />
            )}
            {step.state === "pending" && (
              <div className="w-4 h-4 rounded-full border border-gray-700 flex-shrink-0" />
            )}
            <span
              className={`text-sm ${
                step.state === "done"
                  ? "text-gray-400"
                  : step.state === "active"
                    ? "text-gray-200"
                    : "text-gray-600"
              }`}
            >
              {step.label}
              {step.state === "active" && "..."}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd web && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add web/src/components/ProcessingProgress.tsx
git commit -m "feat: add ProcessingProgress pipeline status card"
```

---

## Task 9: Dashboard Page Rewrite

**Files:**
- Modify: `web/src/app/(protected)/page.tsx` (full rewrite)
- Modify: `web/src/components/UploadModal.tsx` (make attendees required, add date default)

This is the largest task — it wires together DayStrip, DayMeetingList, RecordingPanel, and the existing MeetingList + UploadModal on the main dashboard page.

- [ ] **Step 1: Update UploadModal — make attendees required**

In `web/src/components/UploadModal.tsx`, find the upload button's `disabled` condition and add attendees validation. Also add `File.lastModified` as the default date.

The key changes:
1. Add validation: disable submit when `attendees.length === 0`
2. Show validation message below attendees input when empty on submit attempt
3. When a file is selected, auto-populate the date field with `new Date(file.lastModified).toISOString().slice(0, 16)` if the date field is empty

Look at the existing code and make targeted edits. The attendees input already exists — just add a validation check and a required indicator (`*`).

- [ ] **Step 2: Rewrite dashboard page**

Replace the entire contents of `web/src/app/(protected)/page.tsx`:

```tsx
"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { Upload, Mic } from "lucide-react";
import { getElectronAPIOrNull } from "@/lib/electron-bridge";
import { useRecordingStatus } from "@/lib/useRecordingStatus";
import MeetingList from "@/components/MeetingList";
import UploadModal from "@/components/UploadModal";
import DayStrip from "@/components/DayStrip";
import DayMeetingList from "@/components/DayMeetingList";
import RecordingPanel from "@/components/RecordingPanel";
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
  const [selectedMeeting, setSelectedMeeting] = useState<CalendarEvent | null>(null);
  const [showRecordingPanel, setShowRecordingPanel] = useState(false);

  // Calendar data (Electron only)
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

  // Fetch on mount (Electron only)
  useEffect(() => {
    if (isElectron) fetchCalendar();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Filter meetings for selected day
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
    setSelectedMeeting(meeting);
    setShowRecordingPanel(true);
  };

  const handleStartAdHoc = () => {
    setSelectedMeeting(null);
    setShowRecordingPanel(true);
  };

  const handleDismissPanel = () => {
    setShowRecordingPanel(false);
    setSelectedMeeting(null);
  };

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">Note Taker</h1>
          <p className="text-sm text-gray-500 mt-0.5">{today}</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowUpload(true)}
            disabled={recording}
            className="px-4 py-2 text-sm font-medium text-gray-300 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded-lg flex items-center gap-2 transition-colors"
          >
            <Upload className="w-4 h-4" />
            Upload
          </button>
          {isElectron && (
            <button
              onClick={handleStartAdHoc}
              disabled={recording}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg flex items-center gap-2 transition-colors"
            >
              <Mic className="w-4 h-4" />
              Start Recording
            </button>
          )}
          {recording && (
            <div className="flex items-center gap-1.5 ml-2">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-xs font-medium text-red-400">Recording</span>
            </div>
          )}
        </div>
      </div>

      {/* Upcoming Meetings — Electron only */}
      {isElectron && (
        <section className={`mb-8 ${recording ? "opacity-50 pointer-events-none" : ""}`}>
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
            selectedMeetingId={selectedMeeting?.id ?? null}
            onSelectMeeting={handleSelectMeeting}
            dateLabel={selectedDateLabel}
          />
        </section>
      )}

      {/* Recording Panel */}
      {showRecordingPanel && isElectron && (
        <section className="mb-8">
          <RecordingPanel
            selectedMeeting={selectedMeeting}
            onDismiss={handleDismissPanel}
          />
        </section>
      )}

      {/* Divider */}
      <hr className="border-gray-800 mb-8" />

      {/* Past Meetings */}
      <section>
        <MeetingList />
      </section>

      {/* Upload Modal */}
      {showUpload && <UploadModal onClose={() => setShowUpload(false)} />}
    </div>
  );
}
```

- [ ] **Step 3: Verify app compiles**

```bash
cd web && npx tsc --noEmit
```

- [ ] **Step 4: Build and verify**

```bash
cd web && npm run build
```

Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/\(protected\)/page.tsx web/src/components/UploadModal.tsx
git commit -m "feat: rewrite dashboard with day strip, recording panel, past meetings"
```

---

## Task 10: Meeting Detail Page — Single Scroll Rewrite

**Files:**
- Modify: `web/src/app/(protected)/meetings/[[...id]]/MeetingDetailContent.tsx` (full rewrite)

Replace the tabbed layout with a single scrollable page featuring progressive content reveal, SWR polling, and the processing progress card.

- [ ] **Step 1: Rewrite MeetingDetailContent**

Replace the entire contents of `web/src/app/(protected)/meetings/[[...id]]/MeetingDetailContent.tsx`:

```tsx
"use client";

import { useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  FileText,
  CheckSquare,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useMeeting } from "@/lib/api";
import AudioPlayer, { type AudioPlayerHandle } from "@/components/AudioPlayer";
import ActionItemsTable from "@/components/ActionItemsTable";
import ExportMenu from "@/components/ExportMenu";
import StatusBadge from "@/components/StatusBadge";
import ProcessingProgress from "@/components/ProcessingProgress";

const SPEAKER_COLORS = [
  "text-blue-400",
  "text-purple-400",
  "text-emerald-400",
  "text-amber-400",
  "text-rose-400",
  "text-cyan-400",
];

const INITIAL_SEGMENTS = 5;

function formatTimestamp(seconds: number): string {
  const min = Math.floor(seconds / 60);
  const sec = Math.floor(seconds % 60);
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function SkeletonBlock({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className="h-4 bg-gray-800 rounded animate-pulse"
          style={{ width: `${70 + Math.random() * 30}%` }}
        />
      ))}
    </div>
  );
}

export default function MeetingDetailContent() {
  const params = useParams<{ id: string[] | string }>();
  const router = useRouter();
  const rawId = params?.id;
  const meetingId = Array.isArray(rawId) ? rawId[0] : rawId;

  const numericId = meetingId ? Number(meetingId) : undefined;

  // SWR polling: 3s while processing, stop on terminal states
  const { data: m, error, isLoading } = useMeeting(numericId, {
    refreshInterval:
      !numericId ? 0
      : m?.status === "complete" || m?.status === "failed" ? 0
      : 3000,
  });

  const audioRef = useRef<AudioPlayerHandle>(null);
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);

  if (!meetingId) return <div className="text-gray-500">No meeting selected.</div>;
  if (isLoading) return <div className="text-gray-500">Loading meeting...</div>;
  if (error || !m) return <div className="text-red-400">Meeting not found.</div>;

  const segments = m.transcript?.segments ?? [];
  const visibleSegments = transcriptExpanded
    ? segments
    : segments.slice(0, INITIAL_SEGMENTS);

  // Build speaker → color map
  const speakerColors: Record<string, string> = {};
  const uniqueSpeakers = [...new Set(segments.map((s) => s.speaker))];
  uniqueSpeakers.forEach((speaker, i) => {
    speakerColors[speaker] = SPEAKER_COLORS[i % SPEAKER_COLORS.length];
  });

  const isProcessing = !isTerminal && m.status !== "complete";

  return (
    <div className="max-w-3xl">
      {/* Back link */}
      <button
        onClick={() => router.push("/")}
        className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-300 mb-6 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Meetings
      </button>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-xl font-bold text-gray-100">{m.title}</h1>
            <StatusBadge status={m.status} />
          </div>
          <p className="text-sm text-gray-500">
            {m.scheduled_time &&
              new Date(m.scheduled_time).toLocaleDateString("en-US", {
                weekday: "long",
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            {m.duration_seconds &&
              ` · ${Math.round(m.duration_seconds / 60)} min`}
            {m.participants.length > 0 &&
              ` · ${m.participants.map((p) => p.name).join(", ")}`}
          </p>
        </div>
        {m.status === "complete" && (
          <ExportMenu
            meetingTitle={m.title}
            segments={m.transcript?.segments ?? null}
            summary={m.summary}
          />
        )}
      </div>

      {/* Audio player */}
      {m.audio_url ? (
        <AudioPlayer ref={audioRef} src={m.audio_url} />
      ) : (
        <div className="py-3 px-4 rounded-lg bg-gray-800/50 text-sm text-gray-600 mb-6">
          Audio unavailable
        </div>
      )}

      {/* Processing progress */}
      {isProcessing && (
        <div className="mt-6">
          <ProcessingProgress meetingId={m.id} status={m.status} />
        </div>
      )}

      {/* Summary */}
      <div className="mt-8 p-5 rounded-xl bg-gray-900/50 border border-gray-800">
        <div className="flex items-center gap-2 mb-4">
          <FileText className="w-4 h-4 text-gray-500" />
          <h2 className="text-sm font-semibold text-gray-300">Summary</h2>
        </div>
        {m.summary ? (
          <div className="space-y-4">
            <p className="text-sm text-gray-300 leading-relaxed">
              {m.summary.summary_text}
            </p>
            {m.summary.key_points.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">
                  Key Points
                </h3>
                <ul className="list-disc list-inside space-y-1 text-sm text-gray-400">
                  {m.summary.key_points.map((point, i) => (
                    <li key={i}>{point}</li>
                  ))}
                </ul>
              </div>
            )}
            {m.summary.follow_ups.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">
                  Follow-ups
                </h3>
                <ul className="list-disc list-inside space-y-1 text-sm text-gray-400">
                  {m.summary.follow_ups.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <SkeletonBlock lines={4} />
        )}
      </div>

      {/* Action Items */}
      <div className="mt-6 p-5 rounded-xl bg-gray-900/50 border border-gray-800">
        <div className="flex items-center gap-2 mb-4">
          <CheckSquare className="w-4 h-4 text-gray-500" />
          <h2 className="text-sm font-semibold text-gray-300">Action Items</h2>
          {m.action_items.length > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-gray-800 text-xs text-gray-400">
              {m.action_items.length}
            </span>
          )}
        </div>
        {m.action_items.length > 0 || m.status === "complete" ? (
          <ActionItemsTable items={m.action_items} />
        ) : (
          <SkeletonBlock lines={3} />
        )}
      </div>

      {/* Transcript */}
      <div className="mt-6 p-5 rounded-xl bg-gray-900/50 border border-gray-800">
        <h2 className="text-sm font-semibold text-gray-300 mb-4">Transcript</h2>
        {segments.length > 0 ? (
          <div className="space-y-3">
            {visibleSegments.map((seg, i) => (
              <div key={i} className="flex gap-3">
                <div className="flex-shrink-0 w-20">
                  <span className={`text-xs font-medium ${speakerColors[seg.speaker] || "text-gray-400"}`}>
                    {seg.speaker}
                  </span>
                  <button
                    onClick={() => audioRef.current?.seekTo(seg.start)}
                    className="block text-[10px] text-gray-600 hover:text-blue-400 mt-0.5 transition-colors"
                  >
                    {formatTimestamp(seg.start)}
                  </button>
                </div>
                <p className="text-sm text-gray-400 leading-relaxed flex-1">
                  {seg.text}
                </p>
              </div>
            ))}
            {segments.length > INITIAL_SEGMENTS && (
              <button
                onClick={() => setTranscriptExpanded(!transcriptExpanded)}
                className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 mt-2 transition-colors"
              >
                {transcriptExpanded ? (
                  <>
                    <ChevronUp className="w-3 h-3" /> Show less
                  </>
                ) : (
                  <>
                    <ChevronDown className="w-3 h-3" /> Show full transcript (
                    {segments.length} segments)
                  </>
                )}
              </button>
            )}
          </div>
        ) : m.status === "complete" ? (
          <p className="text-sm text-gray-600 italic">No transcript available</p>
        ) : (
          <SkeletonBlock lines={5} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd web && npx tsc --noEmit
```

- [ ] **Step 3: Build the app**

```bash
cd web && npm run build
```

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add web/src/app/\(protected\)/meetings/\[\[...id\]\]/MeetingDetailContent.tsx
git commit -m "feat: replace tabbed meeting detail with single-scroll layout + SWR polling"
```

---

## Task 11: Clean Up — Remove Old Components

**Files:**
- Delete: `web/src/components/CalendarPanel.tsx`
- Delete: `web/src/components/RecordingControls.tsx`
- Delete: `web/src/components/RecordingStatusBar.tsx`
- Delete: `web/src/components/Nav.tsx`
- Delete: `web/src/components/MeetingHeader.tsx`
- Delete: `web/src/components/SummaryView.tsx`
- Delete: `web/src/components/TranscriptView.tsx`

Only do this AFTER Tasks 4, 9, and 10 are complete and the app compiles without errors.

- [ ] **Step 1: Verify no remaining imports of old components**

```bash
cd web && grep -rn "CalendarPanel\|RecordingControls\|RecordingStatusBar\|from.*Nav\"\|MeetingHeader\|SummaryView\|TranscriptView" src/ --include="*.tsx" --include="*.ts" | grep -v "node_modules"
```

The only results should be the files themselves (their own definitions). If any other file still imports them, fix those imports first.

- [ ] **Step 2: Delete old components**

```bash
rm web/src/components/CalendarPanel.tsx web/src/components/RecordingControls.tsx web/src/components/RecordingStatusBar.tsx web/src/components/Nav.tsx web/src/components/MeetingHeader.tsx web/src/components/SummaryView.tsx web/src/components/TranscriptView.tsx
```

- [ ] **Step 3: Verify build still passes**

```bash
cd web && npm run build
```

Expected: Build succeeds with no import errors.

- [ ] **Step 4: Commit**

```bash
git add -A web/src/components/
git commit -m "refactor: remove old components replaced by UI redesign"
```

---

## Task 12: Final Verification

- [ ] **Step 1: Run full frontend build**

```bash
cd web && npm run build
```

- [ ] **Step 2: Run backend tests**

```bash
cd backend && python -m pytest -v
```

- [ ] **Step 3: Run TypeScript check**

```bash
cd web && npx tsc --noEmit
```

- [ ] **Step 4: Visual smoke test**

Start the dev server and verify:
1. Slim icon sidebar renders with 3 nav icons + avatar
2. Dashboard shows "Note Taker" header with Upload + Start Recording buttons
3. (Electron) Day strip shows 7 days with meeting dots
4. (Electron) Clicking a meeting shows recording panel in pre-filled mode
5. (Electron) "Start Recording" header button shows ad-hoc form
6. Past Meetings section shows meeting list with search/filter
7. Clicking a meeting navigates to `/meetings/{id}` with single-scroll layout
8. Processing meetings show the pipeline progress card
9. Complete meetings show summary, action items, and transcript inline

- [ ] **Step 5: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address issues found during smoke test"
```
