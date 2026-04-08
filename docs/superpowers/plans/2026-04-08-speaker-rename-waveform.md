# Speaker Rename + Audio Waveform & Transcript Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inline speaker label editing to the transcript and replace the plain `<audio>` element with a Wavesurfer.js waveform that highlights and auto-scrolls the active transcript segment during playback.

**Architecture:** Two independent features, both scoped to the meeting detail view. Feature #3 (speaker rename) adds a backend PATCH endpoint + a new `SpeakerLabel` frontend component wired into `MeetingDetailContent` via SWR optimistic updates. Feature #4 (waveform) rewrites `AudioPlayer.tsx` around Wavesurfer.js with a client-side-only dynamic import, then feeds `onTimeUpdate` events into `MeetingDetailContent` to drive `activeSegmentIndex` state and `scrollIntoView`.

**Tech Stack:** Python/FastAPI (backend), Next.js 14 App Router + TypeScript + Tailwind (frontend), SWR (data/cache), Wavesurfer.js v7 (waveform), Vitest + @testing-library/react (frontend tests), pytest + httpx AsyncClient + aiosqlite (backend tests).

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `backend/app/schemas.py` | Modify | Add `RenameSpeakerRequest` + `RenameSpeakerResponse` Pydantic schemas |
| `backend/app/routers/meetings.py` | Modify | Add `PATCH /{id}/rename-speaker` endpoint |
| `backend/tests/test_rename_speaker.py` | Create | Backend tests for the rename endpoint |
| `web/src/lib/api.ts` | Modify | Add `renameSpeaker()` API helper function |
| `web/src/components/SpeakerLabel.tsx` | Create | Inline-editable speaker name component |
| `web/src/components/AudioPlayer.tsx` | Rewrite | Wavesurfer.js waveform with `onTimeUpdate` prop |
| `web/src/app/(protected)/meetings/[[...id]]/MeetingDetailContent.tsx` | Modify | Wire `SpeakerLabel` + transcript sync state |
| `web/package.json` | Modify | Add `wavesurfer.js` dependency |

---

## FEATURE #3 — Speaker Label Rename

---

### Task 1: Backend schemas for rename-speaker

**Files:**
- Modify: `backend/app/schemas.py`

- [ ] **Step 1: Add schemas**

Open `backend/app/schemas.py`. Add these two classes after the existing `MeetingUploadResponse` block (around line 65):

```python
class RenameSpeakerRequest(BaseModel):
    """Request body for PATCH /api/meetings/{id}/rename-speaker."""
    old_name: str = Field(..., min_length=1, max_length=100)
    new_name: str = Field(..., min_length=1, max_length=100)


class RenameSpeakerResponse(BaseModel):
    """Response from PATCH /api/meetings/{id}/rename-speaker."""
    updated_count: int
```

- [ ] **Step 2: Verify import runs cleanly**

```bash
cd backend && python -c "from app.schemas import RenameSpeakerRequest, RenameSpeakerResponse; print('OK')"
```

Expected output: `OK`

- [ ] **Step 3: Commit**

```bash
git add backend/app/schemas.py
git commit -m "feat: add RenameSpeakerRequest and RenameSpeakerResponse schemas"
```

---

### Task 2: Backend endpoint — PATCH /api/meetings/{id}/rename-speaker (TDD)

**Files:**
- Modify: `backend/app/routers/meetings.py`
- Create: `backend/tests/test_rename_speaker.py`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_rename_speaker.py`:

```python
"""Tests for PATCH /api/meetings/{id}/rename-speaker."""
import pytest
from datetime import datetime
from httpx import AsyncClient, ASGITransport
from sqlalchemy import JSON, event
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.api.dependencies import get_current_user
from app.models import User, Meeting, MeetingStatus, Transcript
from app.main import app

TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"


@pytest.fixture()
async def async_db():
    engine = create_async_engine(
        TEST_DATABASE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    for table in Base.metadata.tables.values():
        for column in table.columns:
            if isinstance(column.type, JSONB):
                column.type = JSON()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )
    async with session_factory() as session:
        yield session

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest.fixture()
async def seed_data(async_db: AsyncSession):
    user = User(id=1, email="test@example.com", name="Test User",
                azure_ad_id="test-id", role="user")
    async_db.add(user)
    await async_db.flush()

    meeting = Meeting(
        id=10, title="Test Meeting",
        scheduled_time=datetime.utcnow(),
        status=MeetingStatus.COMPLETE,
        audio_blob_url="audio/test.wav",
        user_id=1,
    )
    async_db.add(meeting)
    await async_db.flush()

    transcript = Transcript(
        meeting_id=10,
        full_text="Hello world",
        segments=[
            {"speaker": "Speaker A", "start": 0.0, "end": 2.0, "text": "Hello."},
            {"speaker": "Speaker B", "start": 2.0, "end": 4.0, "text": "World."},
            {"speaker": "Speaker A", "start": 4.0, "end": 6.0, "text": "Goodbye."},
        ],
        speaker_identified=False,
    )
    async_db.add(transcript)

    other_user = User(id=2, email="other@example.com", name="Other",
                      azure_ad_id="other-id", role="user")
    other_meeting = Meeting(
        id=20, title="Other Meeting",
        scheduled_time=datetime.utcnow(),
        status=MeetingStatus.COMPLETE,
        audio_blob_url="audio/other.wav",
        user_id=2,
    )
    async_db.add(other_user)
    async_db.add(other_meeting)
    await async_db.commit()
    return {"user": user, "meeting": meeting, "transcript": transcript}


@pytest.fixture()
async def client(async_db: AsyncSession, seed_data):
    async def override_db():
        yield async_db

    async def override_user():
        return seed_data["user"]

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_user

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        yield ac

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_rename_speaker_replaces_all_occurrences(client: AsyncClient, async_db: AsyncSession):
    resp = await client.patch(
        "/api/meetings/10/rename-speaker",
        json={"old_name": "Speaker A", "new_name": "John Smith"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["updated_count"] == 2  # Two segments had "Speaker A"

    # Verify DB persisted the change
    from sqlalchemy import select
    from app.models import Transcript
    result = await async_db.execute(select(Transcript).where(Transcript.meeting_id == 10))
    t = result.scalar_one()
    speakers = [seg["speaker"] for seg in t.segments]
    assert "Speaker A" not in speakers
    assert speakers.count("John Smith") == 2
    assert speakers.count("Speaker B") == 1


@pytest.mark.asyncio
async def test_rename_speaker_nonexistent_meeting_returns_404(client: AsyncClient):
    resp = await client.patch(
        "/api/meetings/999/rename-speaker",
        json={"old_name": "Speaker A", "new_name": "John"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_rename_speaker_other_users_meeting_returns_404(client: AsyncClient):
    resp = await client.patch(
        "/api/meetings/20/rename-speaker",
        json={"old_name": "Speaker A", "new_name": "John"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_rename_speaker_empty_new_name_returns_422(client: AsyncClient):
    resp = await client.patch(
        "/api/meetings/10/rename-speaker",
        json={"old_name": "Speaker A", "new_name": "   "},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_rename_zero_matches_returns_zero_count(client: AsyncClient):
    resp = await client.patch(
        "/api/meetings/10/rename-speaker",
        json={"old_name": "Speaker X", "new_name": "Nobody"},
    )
    assert resp.status_code == 200
    assert resp.json()["updated_count"] == 0
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd backend && python -m pytest tests/test_rename_speaker.py -v 2>&1 | head -40
```

Expected: most tests fail with `404` or `405` (route not yet defined). `test_rename_speaker_empty_new_name_returns_422` may fail with a connection error. That's correct.

- [ ] **Step 3: Add the endpoint to meetings.py**

Open `backend/app/routers/meetings.py`. Find the existing `from app.schemas import (...)` block and add `RenameSpeakerRequest, RenameSpeakerResponse` to it:

```python
from app.schemas import (
    MeetingUploadResponse, MeetingUploadMetadata,
    MeetingListItem, MeetingListResponse, MeetingDetailResponse,
    ParticipantResponse, TranscriptResponse, SummaryResponse,
    ActionItemResponse,
    RenameSpeakerRequest, RenameSpeakerResponse,   # add these two
)
```

Then add the endpoint at the end of the file (before any module-level code if any):

```python
@router.patch("/{meeting_id}/rename-speaker", response_model=RenameSpeakerResponse)
async def rename_speaker(
    meeting_id: int,
    body: RenameSpeakerRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RenameSpeakerResponse:
    """Rename all occurrences of a speaker label in a meeting transcript.

    Replaces every segment where speaker == old_name with new_name.
    Scoped to the current user's meetings only.

    Args:
        meeting_id: Meeting to update.
        body: old_name (current label) and new_name (replacement).
        current_user: Authenticated user.
        db: Database session.

    Returns:
        RenameSpeakerResponse with count of updated segments.

    Raises:
        HTTPException 404: If meeting or transcript not found, or not owned by user.
        HTTPException 422: If new_name is blank after stripping whitespace.
    """
    new_name = body.new_name.strip()
    if not new_name:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="new_name must not be blank",
        )

    # Verify meeting ownership
    result = await db.execute(
        select(Meeting).where(
            Meeting.id == meeting_id,
            Meeting.user_id == current_user.id,
        )
    )
    meeting = result.scalar_one_or_none()
    if not meeting:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Meeting not found")

    # Fetch transcript
    t_result = await db.execute(
        select(Transcript).where(Transcript.meeting_id == meeting_id)
    )
    transcript = t_result.scalar_one_or_none()
    if not transcript:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transcript not found")

    # Replace speaker labels
    segments = list(transcript.segments or [])
    updated_count = 0
    for seg in segments:
        if seg.get("speaker") == body.old_name:
            seg["speaker"] = new_name
            updated_count += 1

    # Persist — reassign to trigger SQLAlchemy change detection on JSON column
    transcript.segments = segments
    from sqlalchemy.orm.attributes import flag_modified
    flag_modified(transcript, "segments")
    await db.commit()

    return RenameSpeakerResponse(updated_count=updated_count)
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd backend && python -m pytest tests/test_rename_speaker.py -v
```

Expected: All non-placeholder tests pass. `test_rename_zero_matches_returns_zero_count` passes with `updated_count == 0`.

- [ ] **Step 5: Commit**

```bash
git add backend/app/schemas.py backend/app/routers/meetings.py backend/tests/test_rename_speaker.py
git commit -m "feat: add PATCH /api/meetings/{id}/rename-speaker endpoint"
```

---

### Task 3: Frontend API helper — renameSpeaker()

**Files:**
- Modify: `web/src/lib/api.ts`

- [ ] **Step 1: Add the function**

Open `web/src/lib/api.ts`. Add this function after `deleteActionItem` at the end of the file:

```ts
export async function renameSpeaker(
  meetingId: number,
  oldName: string,
  newName: string,
): Promise<{ updated_count: number }> {
  const headers = await authHeaders();
  const res = await fetch(`/api/meetings/${meetingId}/rename-speaker`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ old_name: oldName, new_name: newName }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Rename failed: ${res.status}`);
  }
  return res.json();
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd web && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/api.ts
git commit -m "feat: add renameSpeaker API helper"
```

---

### Task 4: SpeakerLabel component (TDD)

**Files:**
- Create: `web/src/components/SpeakerLabel.tsx`
- Create: `web/src/components/SpeakerLabel.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `web/src/components/SpeakerLabel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SpeakerLabel from "./SpeakerLabel";

// Mock the renameSpeaker API helper
vi.mock("@/lib/api", () => ({
  renameSpeaker: vi.fn().mockResolvedValue({ updated_count: 2 }),
}));

const defaultProps = {
  name: "Speaker A",
  colorClass: "text-blue-400",
  meetingId: 1,
  onRenamed: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SpeakerLabel", () => {
  it("renders speaker name as a span by default", () => {
    render(<SpeakerLabel {...defaultProps} />);
    expect(screen.getByText("Speaker A")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("switches to input on click", () => {
    render(<SpeakerLabel {...defaultProps} />);
    fireEvent.click(screen.getByText("Speaker A"));
    const input = screen.getByRole("textbox");
    expect(input).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe("Speaker A");
  });

  it("cancels edit on Escape without saving", async () => {
    render(<SpeakerLabel {...defaultProps} />);
    fireEvent.click(screen.getByText("Speaker A"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "John" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByText("Speaker A")).toBeInTheDocument();
    expect(defaultProps.onRenamed).not.toHaveBeenCalled();
  });

  it("saves on Enter and calls onRenamed", async () => {
    const { renameSpeaker } = await import("@/lib/api");
    render(<SpeakerLabel {...defaultProps} />);
    fireEvent.click(screen.getByText("Speaker A"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "John Smith" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(renameSpeaker).toHaveBeenCalledWith(1, "Speaker A", "John Smith");
      expect(defaultProps.onRenamed).toHaveBeenCalledWith("Speaker A", "John Smith");
    });
  });

  it("does not save if new name is blank", async () => {
    const { renameSpeaker } = await import("@/lib/api");
    render(<SpeakerLabel {...defaultProps} />);
    fireEvent.click(screen.getByText("Speaker A"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(renameSpeaker).not.toHaveBeenCalled();
  });

  it("does not save if name is unchanged", async () => {
    const { renameSpeaker } = await import("@/lib/api");
    render(<SpeakerLabel {...defaultProps} />);
    fireEvent.click(screen.getByText("Speaker A"));
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(renameSpeaker).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd web && npm test -- SpeakerLabel.test 2>&1 | tail -20
```

Expected: fails with "Cannot find module" or component not found.

- [ ] **Step 3: Implement SpeakerLabel**

Create `web/src/components/SpeakerLabel.tsx`:

```tsx
"use client";

import { useState, useRef } from "react";
import { renameSpeaker } from "@/lib/api";

interface SpeakerLabelProps {
  name: string;
  colorClass: string;
  meetingId: number;
  onRenamed: (oldName: string, newName: string) => void;
}

export default function SpeakerLabel({
  name,
  colorClass,
  meetingId,
  onRenamed,
}: SpeakerLabelProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [hasError, setHasError] = useState(false);
  const isSubmitting = useRef(false);

  function startEdit() {
    setIsEditing(true);
    setHasError(false);
  }

  async function save(input: HTMLInputElement) {
    const newName = input.value.trim();
    if (!newName || newName === name) {
      setIsEditing(false);
      return;
    }
    try {
      await renameSpeaker(meetingId, name, newName);
      onRenamed(name, newName);
      setIsEditing(false);
    } catch {
      setHasError(true);
      setTimeout(() => {
        setHasError(false);
        setIsEditing(false);
      }, 2000);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      isSubmitting.current = true;
      save(e.currentTarget).finally(() => {
        isSubmitting.current = false;
      });
    } else if (e.key === "Escape") {
      setIsEditing(false);
    }
  }

  function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
    if (isSubmitting.current) return;
    save(e.currentTarget);
  }

  if (!isEditing) {
    return (
      <span
        className={`cursor-pointer text-sm font-semibold ${colorClass} hover:opacity-70 transition-opacity`}
        onClick={startEdit}
        title="Click to rename"
      >
        {name}
      </span>
    );
  }

  return (
    <input
      type="text"
      defaultValue={name}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      className={`w-24 rounded border px-1 text-sm font-semibold bg-[color:var(--surface-muted)] text-[color:var(--text-primary)] outline-none focus:ring-1 ${
        hasError
          ? "border-red-500 ring-red-500"
          : "border-[color:var(--accent-text)] ring-[color:var(--accent-text)]"
      }`}
    />
  );
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd web && npm test -- SpeakerLabel.test 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/SpeakerLabel.tsx web/src/components/SpeakerLabel.test.tsx
git commit -m "feat: add SpeakerLabel inline-edit component"
```

---

### Task 5: Wire SpeakerLabel into MeetingDetailContent

**Files:**
- Modify: `web/src/app/(protected)/meetings/[[...id]]/MeetingDetailContent.tsx`

**Context:** This file already uses `useMeeting(numericId, { refreshInterval })`. The `mutate` function is returned by `useSWR` but not currently destructured. We need it for optimistic updates. The speaker `<span>` is at line 221.

- [ ] **Step 1: Destructure `mutate` from `useMeeting`**

Find this line (around line 66):

```ts
const { data: m, error, isLoading } = useMeeting(numericId, {
```

Change to:

```ts
const { data: m, error, isLoading, mutate } = useMeeting(numericId, {
```

- [ ] **Step 2: Add import for SpeakerLabel**

Add to the import block at the top:

```ts
import SpeakerLabel from "@/components/SpeakerLabel";
```

- [ ] **Step 3: Add the onRenamed callback**

Add this function inside the component body, after the `speakerColors` block (around line 93).

**Note on rollback:** `SpeakerLabel` calls `onRenamed` only after the PATCH succeeds (see `save()` in `SpeakerLabel.tsx` — `onRenamed` is inside the `try` block, after `await renameSpeaker()`). If the PATCH fails, `SpeakerLabel` shows a red error border and does NOT call `onRenamed`. So `handleSpeakerRenamed` only ever runs on success — no rollback is needed here.

```ts
function handleSpeakerRenamed(oldName: string, newName: string) {
  if (!m) return;
  const updatedSegments = (m.transcript?.segments ?? []).map((seg) =>
    seg.speaker === oldName ? { ...seg, speaker: newName } : seg
  );
  const updatedMeeting = {
    ...m,
    transcript: m.transcript
      ? { ...m.transcript, segments: updatedSegments }
      : null,
  };
  mutate(updatedMeeting, false);
}
```

- [ ] **Step 4: Replace the speaker `<span>` with `<SpeakerLabel>`**

In the transcript segment loop, find this block (around line 221–223):

```tsx
<span className={`text-sm font-semibold ${speakerColors[seg.speaker] || "text-[color:var(--text-secondary)]"}`}>
  {seg.speaker}
</span>
```

Replace with:

```tsx
<SpeakerLabel
  name={seg.speaker}
  colorClass={speakerColors[seg.speaker] || "text-[color:var(--text-secondary)]"}
  meetingId={m.id}
  onRenamed={handleSpeakerRenamed}
/>
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd web && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 6: Smoke test in browser**

Start the dev server (`npm run dev` in `web/`) and open a meeting with a complete transcript. Click a speaker name — verify it becomes an input. Type a new name, press Enter — verify all occurrences of that speaker update across the transcript.

- [ ] **Step 7: Commit**

```bash
git add web/src/app/\(protected\)/meetings/\[\[...id\]\]/MeetingDetailContent.tsx
git commit -m "feat: wire SpeakerLabel into transcript with optimistic SWR rename"
```

---

## FEATURE #4 — Audio Waveform + Transcript Sync

---

### Task 6: Install Wavesurfer.js

**Files:**
- Modify: `web/package.json`

- [ ] **Step 1: Install the package**

```bash
cd web && npm install wavesurfer.js@^7
```

- [ ] **Step 2: Verify install**

```bash
ls web/node_modules/wavesurfer.js/dist/wavesurfer.js 2>/dev/null && echo "installed" || echo "not found"
```

Expected: `installed`

- [ ] **Step 3: Commit**

```bash
git add web/package.json web/package-lock.json
git commit -m "chore: add wavesurfer.js dependency"
```

---

### Task 7: Rewrite AudioPlayer with Wavesurfer.js

**Files:**
- Rewrite: `web/src/components/AudioPlayer.tsx`

**Context:** The current file is a `forwardRef` component exposing `AudioPlayerHandle.seekTo(seconds)`. That public interface must stay identical — `MeetingDetailContent` calls `audioRef.current?.seekTo(seg.start)` on timestamp clicks. We add one new optional prop: `onTimeUpdate`.

Wavesurfer.js references `window` at module load time. We must NOT `import WaveSurfer from 'wavesurfer.js'` at the top of the file — it will crash during Next.js SSR. Instead, use a dynamic `import()` inside `useEffect`.

- [ ] **Step 1: Rewrite AudioPlayer.tsx**

Replace the entire contents of `web/src/components/AudioPlayer.tsx` with:

```tsx
"use client";

import { useRef, useEffect, useImperativeHandle, forwardRef, useState } from "react";

export interface AudioPlayerHandle {
  seekTo: (seconds: number) => void;
}

interface AudioPlayerProps {
  src: string | null;
  onTimeUpdate?: (currentTime: number) => void;
}

const AudioPlayer = forwardRef<AudioPlayerHandle, AudioPlayerProps>(
  function AudioPlayer({ src, onTimeUpdate }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wavesurferRef = useRef<any>(null);
    const pendingSeekRef = useRef<number | null>(null);
    const [loadError, setLoadError] = useState(false);

    useImperativeHandle(ref, () => ({
      seekTo(seconds: number) {
        const ws = wavesurferRef.current;
        if (!ws) return;
        const duration = ws.getDuration();
        if (duration > 0) {
          ws.seekTo(seconds / duration);
        } else {
          // Audio not ready yet — store and apply on ready
          pendingSeekRef.current = seconds;
        }
      },
    }));

    useEffect(() => {
      if (!src || !containerRef.current) return;

      let destroyed = false;

      // Dynamic import keeps Wavesurfer out of the SSR bundle
      import("wavesurfer.js").then(({ default: WaveSurfer }) => {
        if (destroyed) return;

        // Read CSS custom property values for theme-aware colours
        const style = getComputedStyle(document.documentElement);
        const waveColor = style.getPropertyValue("--border-subtle").trim() || "#d1d5db";
        const progressColor = style.getPropertyValue("--accent-text").trim() || "#6366f1";

        const ws = WaveSurfer.create({
          container: containerRef.current!,
          url: src,
          waveColor,
          progressColor,
          height: 64,
          barWidth: 2,
          barRadius: 2,
          interact: true,
        });

        wavesurferRef.current = ws;

        ws.on("ready", () => {
          if (pendingSeekRef.current !== null) {
            const duration = ws.getDuration();
            if (duration > 0) {
              ws.seekTo(pendingSeekRef.current / duration);
            }
            pendingSeekRef.current = null;
          }
        });

        ws.on("timeupdate", (currentTime: number) => {
          onTimeUpdate?.(currentTime);
        });

        ws.on("error", () => {
          if (!destroyed) setLoadError(true);
        });
      });

      return () => {
        destroyed = true;
        wavesurferRef.current?.destroy();
        wavesurferRef.current = null;
      };
      // onTimeUpdate intentionally omitted from deps — callers should memoize if needed
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [src]);

    if (!src) return null;

    if (loadError) {
      return (
        <div className="surface-card rounded-[24px] border border-[color:var(--border-subtle)] p-4 shadow-[var(--shadow-soft)]">
          <p className="text-sm text-[color:var(--text-secondary)]">Audio could not be loaded.</p>
        </div>
      );
    }

    return (
      <div className="surface-card rounded-[24px] border border-[color:var(--border-subtle)] p-4 shadow-[var(--shadow-soft)]">
        <div ref={containerRef} className="w-full" />
      </div>
    );
  }
);

export default AudioPlayer;
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd web && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Smoke test waveform renders**

Start the dev server and open a meeting with audio. Verify: waveform renders (bars visible), play/pause works via clicking the waveform, clicking a transcript timestamp seeks the audio (the `audioRef.current?.seekTo` path still works).

- [ ] **Step 4: Commit**

```bash
git add web/src/components/AudioPlayer.tsx
git commit -m "feat: replace audio element with Wavesurfer.js waveform"
```

---

### Task 8: Transcript sync — highlight + auto-scroll active segment

**Files:**
- Modify: `web/src/app/(protected)/meetings/[[...id]]/MeetingDetailContent.tsx`

**Context:** `AudioPlayer` now fires `onTimeUpdate(currentTime)`. We need to find the active segment index via binary search and apply a highlight class + scroll. The `visibleSegments` slice (first 5 when collapsed) means `segmentRefs` may only have refs for a subset — `scrollIntoView` will be a no-op for segments not yet rendered (graceful degradation).

- [ ] **Step 1: Add imports**

Add `useCallback` to the React import line. It should already have `useState`, `useRef`, `useEffect`:

```ts
import { useState, useRef, useEffect, useCallback } from "react";
```

- [ ] **Step 2: Add activeSegmentIndex state and segmentRefs**

Add these two lines inside the component, near the existing `audioRef` and `transcriptExpanded` declarations:

```ts
const [activeSegmentIndex, setActiveSegmentIndex] = useState<number | null>(null);
const segmentRefs = useRef<(HTMLDivElement | null)[]>([]);
```

- [ ] **Step 3: Add handleTimeUpdate**

Add this callback inside the component, after `handleSpeakerRenamed`. `segments` is already defined earlier in the component as `const segments = m.transcript?.segments ?? [];` — this callback closes over it:

```ts
const handleTimeUpdate = useCallback(
  (currentTime: number) => {
    // Binary search for the segment whose window contains currentTime
    let lo = 0;
    let hi = segments.length - 1;
    let found: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const seg = segments[mid];
      if (currentTime < seg.start) {
        hi = mid - 1;
      } else if (currentTime >= seg.end) {
        lo = mid + 1;
      } else {
        found = mid;
        break;
      }
    }
    setActiveSegmentIndex(found);
  },
  [segments],
);
```

- [ ] **Step 4: Add scroll effect**

Add this `useEffect` after the existing poll-stop effect (around line 75):

```ts
useEffect(() => {
  if (activeSegmentIndex === null) return;
  segmentRefs.current[activeSegmentIndex]?.scrollIntoView({
    behavior: "smooth",
    block: "nearest",
  });
}, [activeSegmentIndex]);
```

- [ ] **Step 5: Pass onTimeUpdate to AudioPlayer**

Find the AudioPlayer usage (around line 140):

```tsx
<AudioPlayer ref={audioRef} src={m.audio_url} />
```

Change to:

```tsx
<AudioPlayer ref={audioRef} src={m.audio_url} onTimeUpdate={handleTimeUpdate} />
```

- [ ] **Step 6: Add refs and highlight class to segment rows**

Find the segment `<div>` in the `visibleSegments.map` (around line 219). It currently starts:

```tsx
<div key={i} className="flex gap-4 rounded-[22px] border border-[color:var(--border-subtle)] bg-[color:var(--surface-muted)] px-4 py-4">
```

Change to:

```tsx
<div
  key={i}
  ref={(el) => { segmentRefs.current[i] = el; }}
  className={`flex gap-4 rounded-[22px] border px-4 py-4 transition-colors duration-200 ${
    activeSegmentIndex === i
      ? "border-[color:var(--accent-text)] bg-[color:var(--surface-soft)]"
      : "border-[color:var(--border-subtle)] bg-[color:var(--surface-muted)]"
  }`}
>
```

- [ ] **Step 7: Verify TypeScript compiles**

```bash
cd web && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 8: Smoke test the full sync**

Open a meeting with audio and a transcript. Press play. Verify: the active segment gets a highlighted border as the audio progresses, and the page scrolls to keep the active segment visible. Click a transcript timestamp — audio seeks, and the highlight moves immediately.

Also expand the transcript (click "Show full transcript") and verify the sync still works for segments beyond the initial 5.

- [ ] **Step 9: Commit**

```bash
git add web/src/app/\(protected\)/meetings/\[\[...id\]\]/MeetingDetailContent.tsx
git commit -m "feat: transcript sync — highlight and auto-scroll active segment during playback"
```

---

## Final Checks

- [ ] **Run all backend tests**

```bash
cd backend && python -m pytest tests/ -v 2>&1 | tail -30
```

Expected: all pass, no regressions.

- [ ] **Run all frontend tests**

```bash
cd web && npm test 2>&1 | tail -20
```

Expected: all pass, including the new `SpeakerLabel.test.tsx`.

- [ ] **Build check**

```bash
cd web && npm run build 2>&1 | tail -20
```

Expected: build succeeds with no errors. (Wavesurfer.js dynamic import means no SSR errors.)

- [ ] **Final commit tag**

```bash
git tag feature/speaker-rename-waveform
```
