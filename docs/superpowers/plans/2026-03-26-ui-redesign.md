# Unified Main Window UI Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all core user actions (calendar, recording, upload, settings) from the system tray into the Electron main window, making the tray a shortcut rather than the primary interface.

**Architecture:** The main window loads the Next.js web app as a renderer. Currently the preload bridge (`preload-web.ts`) only exposes 5 auth/config APIs. We expand the bridge to include calendar, recording, and audio device APIs so the web app can drive all features. The web app conditionally renders Electron-only panels (calendar sidebar, recording controls) by checking `window.electronAPI?.isElectron`.

**Tech Stack:** Electron (main process), Next.js 14 App Router (renderer), TypeScript, Tailwind CSS, SWR, FastAPI (backend), pytest, Jest

---

## Current State

The Electron main window is essentially **read-only** — it shows a meeting list table and an upload modal. All primary actions are elsewhere:

| Feature | Current Location | Problem |
|---------|-----------------|---------|
| Start/Stop recording | Tray context menu | Not discoverable |
| Calendar / meeting selection | Separate popup window | Disconnected from main UI |
| Recording status | Tray tooltip text | Not visible in main window |
| Audio device config | `.env.local` file | No UI |
| Delete meeting | Not implemented | Missing |
| Export transcript | Not implemented | Missing |
| Search/filter meetings | Not implemented | Missing |

### Root Cause: IPC Bridge Gap

`preload-web.ts` exposes only: `getToken`, `signOut`, `getBackendUrl`, `getAppVersion`, `isElectron`.

`ipc.ts` already registers handlers for `recorder:start`, `recorder:stop`, `recorder:is-recording`, `graph:get-calendar`, `uploader:upload`, `meeting-selector:select` — but these are **not wired** through the web preload.

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| (no new file — `web/src/lib/electron-bridge.ts` is extended) | Expanded ElectronAPI interface + safe `getElectronAPIOrNull()` accessor |
| `web/src/lib/useRecordingStatus.ts` | Shared hook for recording state, timer, and status subscription |
| `web/src/lib/format.ts` | Shared formatting utilities (elapsed time) |
| `web/src/components/CalendarPanel.tsx` | Sidebar panel listing upcoming Graph API meetings |
| `web/src/components/RecordingControls.tsx` | Start/stop recording with timer and meeting context |
| `web/src/components/RecordingStatusBar.tsx` | Persistent bottom bar visible during recording |
| `web/src/components/SearchFilter.tsx` | Search input + status filter for meeting list |
| `web/src/components/DeleteMeetingButton.tsx` | Delete button with confirmation dialog |
| `web/src/components/ExportMenu.tsx` | Export transcript/summary dropdown |
| `web/src/app/(protected)/settings/page.tsx` | Settings page (audio devices, sign out, version) |
| `desktop/tests/preload-web.test.ts` | Tests for expanded preload bridge |
| `backend/tests/test_delete_meeting.py` | Tests for DELETE /api/meetings/{id} |

### Modified Files

| File | Changes |
|------|---------|
| `web/src/lib/electron-bridge.ts` | Expand ElectronAPI interface, add `getElectronAPIOrNull()` |
| `desktop/src/renderer/preload-web.ts` | Add calendar, recording, upload, audio device APIs |
| `desktop/src/main/ipc.ts` | Add `audio:get-devices` handler, recording status push |
| `desktop/src/main/tray.ts` | Broadcast recording state changes to main window |
| `desktop/src/main/index.ts` | Export `getMainWindow()` accessor for status push |
| `web/src/app/(protected)/page.tsx` | Two-column dashboard layout with sidebar |
| `web/src/app/(protected)/layout.tsx` | Add RecordingStatusBar |
| `web/src/components/MeetingList.tsx` | Integrate SearchFilter and delete column |
| `web/src/components/Nav.tsx` | Add Settings link |
| `web/src/lib/api.ts` | Add `deleteMeeting()` function |
| `web/src/types/index.ts` | Add `CalendarEvent` type |
| `backend/app/routers/meetings.py` | Add `DELETE /api/meetings/{id}` endpoint |

---

## Task 1: Expand Electron API Types & Bridge

**Files:**
- Modify: `web/src/lib/electron-bridge.ts` (EXISTING — extend, do not create a new file)
- Modify: `web/src/types/index.ts`

**Important:** `web/src/lib/electron-bridge.ts` already exists with `ElectronAPI`, `isElectron()`, and `getElectronAPI()`. It is imported by `web/src/lib/useAuth.ts`. We extend this file rather than creating a duplicate.

The existing `getElectronAPI()` **throws** if not in Electron. New components need a **non-throwing** variant that returns `undefined` for graceful degradation. We add `getElectronAPIOrNull()` alongside the existing throwing version.

- [ ] **Step 1: Add CalendarEvent type to shared types**

Add to `web/src/types/index.ts`:

```typescript
export interface CalendarAttendee {
  name: string;
  email: string;
}

export interface CalendarEvent {
  id: string;
  subject: string;
  start: string;
  end: string;
  attendees: CalendarAttendee[];
}
```

- [ ] **Step 2: Expand ElectronAPI interface and add safe accessor**

Replace the full contents of `web/src/lib/electron-bridge.ts`:

```typescript
import type { CalendarEvent } from "@/types";

// --- Recording types ---

export interface RecordingOptions {
  micName: string;
  loopbackName: string;
  outputPath: string;
}

export interface RecordingStatus {
  recording: boolean;
  meetingTitle?: string;
  startedAt?: number;
}

export interface AudioDevice {
  name: string;
  id: string;
}

export interface MeetingMetadata {
  meeting_title: string;
  attendees: { name: string; email?: string }[];
  scheduled_time?: string;
}

export interface UploadArgs {
  recordingOptions: RecordingOptions;
  metadata: MeetingMetadata;
  backendUrl: string;
}

export interface UploadResult {
  meeting_id: number;
  status: string;
}

// --- Electron API interface ---

export interface ElectronAPI {
  // Auth (existing)
  getToken: () => Promise<string>;
  signOut: () => Promise<void>;
  getBackendUrl: () => Promise<string>;
  getAppVersion: () => string;
  isElectron: true;

  // Calendar
  getCalendar: () => Promise<CalendarEvent[]>;

  // Recording
  startRecording: (opts: RecordingOptions) => Promise<void>;
  stopRecording: () => Promise<void>;
  isRecording: () => Promise<boolean>;
  onRecordingStatus: (cb: (status: RecordingStatus) => void) => () => void;

  // Upload via main process
  uploadRecording: (args: UploadArgs) => Promise<UploadResult>;

  // Meeting metadata
  selectMeeting: (event: CalendarEvent) => Promise<void>;

  // Audio devices
  getAudioDevices: () => Promise<AudioDevice[]>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

// --- Accessors ---

/**
 * Returns true when running inside Electron (preload-web.ts injected the bridge).
 */
export function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.electronAPI?.isElectron;
}

/**
 * Get the Electron API. Throws if not running in Electron.
 * Use this in code paths that MUST be in Electron (e.g., useAuth).
 */
export function getElectronAPI(): ElectronAPI {
  if (!window.electronAPI) {
    throw new Error("electronAPI not available — not running in Electron");
  }
  return window.electronAPI;
}

/**
 * Safe, non-throwing accessor. Returns undefined in browser.
 * Caches the reference for stable React dependency identity.
 * Use this in components that conditionally render Electron features.
 */
let _cachedApi: ElectronAPI | undefined;
let _resolved = false;

export function getElectronAPIOrNull(): ElectronAPI | undefined {
  if (!_resolved) {
    _resolved = true;
    if (typeof window !== "undefined" && window.electronAPI?.isElectron) {
      _cachedApi = window.electronAPI;
    }
  }
  return _cachedApi;
}
```

- [ ] **Step 3: Verify useAuth.ts still compiles (it imports from electron-bridge)**

Run: `cd web && npx tsc --noEmit`
Expected: No type errors (useAuth imports `isElectron` and `getElectronAPI` which still exist with same signatures)

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/electron-bridge.ts web/src/types/index.ts
git commit -m "feat: expand ElectronAPI interface with calendar, recording, and device APIs"
```

---

## Task 2: Expand Preload Bridge

**Files:**
- Modify: `desktop/src/renderer/preload-web.ts`
- Test: `desktop/tests/preload-web.test.ts`

- [ ] **Step 1: Write the failing test**

Create `desktop/tests/preload-web.test.ts`:

```typescript
jest.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: jest.fn(),
  },
  ipcRenderer: {
    invoke: jest.fn(),
    sendSync: jest.fn(),
    on: jest.fn(),
    removeListener: jest.fn(),
  },
}));

import { contextBridge, ipcRenderer } from 'electron';

describe('preload-web', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('exposes all expected API methods', () => {
    require('../src/renderer/preload-web');

    const exposedApi = (contextBridge.exposeInMainWorld as jest.Mock).mock.calls[0][1];

    // Existing APIs
    expect(exposedApi.isElectron).toBe(true);
    expect(typeof exposedApi.getToken).toBe('function');
    expect(typeof exposedApi.signOut).toBe('function');
    expect(typeof exposedApi.getBackendUrl).toBe('function');
    expect(typeof exposedApi.getAppVersion).toBe('function');

    // New APIs
    expect(typeof exposedApi.getCalendar).toBe('function');
    expect(typeof exposedApi.startRecording).toBe('function');
    expect(typeof exposedApi.stopRecording).toBe('function');
    expect(typeof exposedApi.isRecording).toBe('function');
    expect(typeof exposedApi.onRecordingStatus).toBe('function');
    expect(typeof exposedApi.uploadRecording).toBe('function');
    expect(typeof exposedApi.selectMeeting).toBe('function');
    expect(typeof exposedApi.getAudioDevices).toBe('function');
  });

  it('getCalendar invokes correct IPC channel', async () => {
    require('../src/renderer/preload-web');
    const api = (contextBridge.exposeInMainWorld as jest.Mock).mock.calls[0][1];

    (ipcRenderer.invoke as jest.Mock).mockResolvedValue([]);
    await api.getCalendar();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('graph:get-calendar');
  });

  it('startRecording passes options to IPC', async () => {
    require('../src/renderer/preload-web');
    const api = (contextBridge.exposeInMainWorld as jest.Mock).mock.calls[0][1];

    const opts = { micName: 'Mic', loopbackName: 'Speaker', outputPath: '/tmp/out.wav' };
    (ipcRenderer.invoke as jest.Mock).mockResolvedValue(undefined);
    await api.startRecording(opts);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('recorder:start', opts);
  });

  it('onRecordingStatus subscribes and returns unsubscribe fn', () => {
    require('../src/renderer/preload-web');
    const api = (contextBridge.exposeInMainWorld as jest.Mock).mock.calls[0][1];

    const cb = jest.fn();
    const unsub = api.onRecordingStatus(cb);

    expect(ipcRenderer.on).toHaveBeenCalledWith('recorder:status-changed', expect.any(Function));
    expect(typeof unsub).toBe('function');

    unsub();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith('recorder:status-changed', expect.any(Function));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && npx jest tests/preload-web.test.ts --verbose`
Expected: FAIL — new API methods are not yet exposed

- [ ] **Step 3: Update preload-web.ts with new APIs**

Replace the full contents of `desktop/src/renderer/preload-web.ts`:

```typescript
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Auth (existing)
  getToken: (): Promise<string> => ipcRenderer.invoke('auth:get-id-token'),
  signOut: (): Promise<void> => ipcRenderer.invoke('auth:sign-out'),
  getBackendUrl: (): Promise<string> => ipcRenderer.invoke('app:get-backend-url'),
  getAppVersion: (): string => ipcRenderer.sendSync('app:get-version'),
  isElectron: true as const,

  // Calendar
  getCalendar: () => ipcRenderer.invoke('graph:get-calendar'),

  // Recording
  startRecording: (opts: { micName: string; loopbackName: string; outputPath: string }) =>
    ipcRenderer.invoke('recorder:start', opts),
  stopRecording: () => ipcRenderer.invoke('recorder:stop'),
  isRecording: () => ipcRenderer.invoke('recorder:is-recording'),
  onRecordingStatus: (cb: (status: { recording: boolean; meetingTitle?: string; startedAt?: number }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, status: { recording: boolean; meetingTitle?: string; startedAt?: number }) => cb(status);
    ipcRenderer.on('recorder:status-changed', handler);
    return () => { ipcRenderer.removeListener('recorder:status-changed', handler); };
  },

  // Upload via main process
  uploadRecording: (args: { recordingOptions: { micName: string; loopbackName: string; outputPath: string }; metadata: { meeting_title: string; attendees: { name: string; email?: string }[]; scheduled_time?: string }; backendUrl: string }) =>
    ipcRenderer.invoke('uploader:upload', args),

  // Meeting metadata
  selectMeeting: (event: { id: string; subject: string; start: string; end: string; attendees: { name: string; email: string }[] }) =>
    ipcRenderer.invoke('meeting-selector:select', event),

  // Audio devices
  getAudioDevices: () => ipcRenderer.invoke('audio:get-devices'),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && npx jest tests/preload-web.test.ts --verbose`
Expected: PASS — all API methods exposed

- [ ] **Step 5: Commit**

```bash
git add desktop/src/renderer/preload-web.ts desktop/tests/preload-web.test.ts
git commit -m "feat: expand preload bridge with calendar, recording, and device APIs"
```

---

## Task 3: Audio Device Enumeration IPC Handler

**Files:**
- Modify: `desktop/src/main/ipc.ts`
- Test: `desktop/tests/ipc-devices.test.ts`

- [ ] **Step 1: Write the failing test**

Create `desktop/tests/ipc-devices.test.ts`:

```typescript
jest.mock('electron', () => ({
  ipcMain: {
    handle: jest.fn(),
    on: jest.fn(),
  },
  BrowserWindow: { fromWebContents: jest.fn() },
  shell: { openExternal: jest.fn() },
  app: { getVersion: jest.fn(() => '1.0.0') },
}));
jest.mock('../src/main/auth', () => ({
  acquireToken: jest.fn(),
  acquireIdToken: jest.fn(),
  clearTokenCache: jest.fn(),
}));
jest.mock('../src/main/graph', () => ({ getUpcomingMeetings: jest.fn() }));
jest.mock('../src/main/recorder', () => ({
  startRecording: jest.fn(),
  stopRecording: jest.fn(),
  isRecording: jest.fn(),
}));
jest.mock('../src/main/uploader', () => ({ uploadRecording: jest.fn() }));
jest.mock('../src/main/tray', () => ({ setPendingMeeting: jest.fn() }));

import { ipcMain } from 'electron';

describe('audio:get-devices IPC handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('registers audio:get-devices handler', () => {
    require('../src/main/ipc').registerIpcHandlers();
    const handleCalls = (ipcMain.handle as jest.Mock).mock.calls;
    const channels = handleCalls.map((c: [string, Function]) => c[0]);
    expect(channels).toContain('audio:get-devices');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && npx jest tests/ipc-devices.test.ts --verbose`
Expected: FAIL — `audio:get-devices` not in registered channels

- [ ] **Step 3: Add the handler to ipc.ts**

Add to the `registerIpcHandlers()` function in `desktop/src/main/ipc.ts`:

```typescript
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Inside registerIpcHandlers():
ipcMain.handle('audio:get-devices', async (): Promise<{ name: string; id: string }[]> => {
  try {
    // Use ffmpeg to list DirectShow audio devices on Windows
    const { stderr } = await execAsync('ffmpeg -list_devices true -f dshow -i dummy 2>&1', {
      timeout: 5000,
    }).catch((e) => ({ stderr: e.stderr || '', stdout: '' }));

    const devices: { name: string; id: string }[] = [];
    const lines = stderr.split('\n');
    let isAudio = false;

    for (const line of lines) {
      if (line.includes('DirectShow audio devices')) {
        isAudio = true;
        continue;
      }
      if (line.includes('DirectShow video devices')) {
        isAudio = false;
        continue;
      }
      if (isAudio) {
        const match = line.match(/"([^"]+)"/);
        if (match && !line.includes('Alternative name')) {
          devices.push({ name: match[1], id: match[1] });
        }
      }
    }
    return devices;
  } catch {
    return [];
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && npx jest tests/ipc-devices.test.ts --verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/ipc.ts desktop/tests/ipc-devices.test.ts
git commit -m "feat: add audio:get-devices IPC handler using ffmpeg dshow listing"
```

---

## Task 4: Recording Status Push (Main → Renderer)

**Files:**
- Modify: `desktop/src/main/index.ts`
- Modify: `desktop/src/main/tray.ts`

- [ ] **Step 1: Add getMainWindow accessor to index.ts**

Add to `desktop/src/main/index.ts` after the `showMainWindow` function:

```typescript
export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}
```

- [ ] **Step 2: Broadcast recording state from tray.ts**

Add import at top of `desktop/src/main/tray.ts`:

```typescript
import { getMainWindow } from './index';
```

Add a helper function:

```typescript
function broadcastRecordingStatus(recording: boolean, meetingTitle?: string): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('recorder:status-changed', {
      recording,
      meetingTitle: meetingTitle || _pendingTitle || undefined,
      startedAt: recording ? Date.now() : undefined,
    });
  }
}
```

Add calls in `handleStartRecording()` (after `startRecording()`) and `handleStopRecording()` (after `stopRecording()`):

```typescript
// In handleStartRecording, after startRecording() call:
broadcastRecordingStatus(true, _pendingTitle);

// In handleStopRecording, after stopRecording() call:
broadcastRecordingStatus(false);
```

- [ ] **Step 3: Verify desktop compiles**

Run: `cd desktop && npx tsc -p tsconfig.main.json --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add desktop/src/main/index.ts desktop/src/main/tray.ts
git commit -m "feat: broadcast recording status from main process to renderer"
```

---

## Task 5: Backend DELETE Endpoint

**Files:**
- Modify: `backend/app/routers/meetings.py`
- Create: `backend/tests/test_delete_meeting.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_delete_meeting.py`:

```python
"""Tests for DELETE /api/meetings/{id}."""
import pytest
from datetime import datetime
from httpx import AsyncClient, ASGITransport
from sqlalchemy import JSON, event
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.api.dependencies import get_current_user
from app.models import User, Meeting, MeetingStatus
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

    meeting = Meeting(id=10, title="Deletable Meeting",
                      scheduled_time=datetime.utcnow(),
                      status=MeetingStatus.COMPLETE,
                      audio_blob_url="audio/test.wav", user_id=1)
    async_db.add(meeting)

    other_user = User(id=2, email="other@example.com", name="Other User",
                      azure_ad_id="other-id", role="user")
    other_meeting = Meeting(id=20, title="Other Meeting",
                            scheduled_time=datetime.utcnow(),
                            status=MeetingStatus.COMPLETE,
                            audio_blob_url="audio/other.wav", user_id=2)
    async_db.add(other_user)
    async_db.add(other_meeting)
    await async_db.commit()
    return {"user": user, "meeting": meeting, "other_meeting": other_meeting}


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
async def test_delete_own_meeting(client: AsyncClient):
    resp = await client.delete("/api/meetings/10")
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_delete_nonexistent_returns_404(client: AsyncClient):
    resp = await client.delete("/api/meetings/999")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_other_users_meeting_returns_404(client: AsyncClient):
    resp = await client.delete("/api/meetings/20")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_is_permanent(client: AsyncClient):
    await client.delete("/api/meetings/10")
    resp = await client.get("/api/meetings/10")
    assert resp.status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_delete_meeting.py -v`
Expected: FAIL — 405 Method Not Allowed (endpoint doesn't exist)

- [ ] **Step 3: Add DELETE endpoint to meetings router**

Add to `backend/app/routers/meetings.py`:

```python
@router.delete("/{meeting_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_meeting(
    meeting_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a meeting owned by the authenticated user."""
    result = await db.execute(
        select(Meeting).where(Meeting.id == meeting_id, Meeting.user_id == current_user.id)
    )
    meeting = result.scalar_one_or_none()
    if not meeting:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Meeting not found")

    await db.delete(meeting)
    await db.commit()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_delete_meeting.py -v`
Expected: All 4 tests PASS

- [ ] **Step 5: Run full backend test suite**

Run: `cd backend && python -m pytest -v`
Expected: All existing tests still pass

- [ ] **Step 6: Commit**

```bash
git add backend/app/routers/meetings.py backend/tests/test_delete_meeting.py
git commit -m "feat: add DELETE /api/meetings/{id} endpoint with ownership check"
```

---

## Task 6: Frontend deleteMeeting API + CalendarEvent Type

**Files:**
- Modify: `web/src/lib/api.ts`

- [ ] **Step 1: Add deleteMeeting function**

Add to `web/src/lib/api.ts` after the `uploadMeeting` function:

```typescript
export async function deleteMeeting(id: number): Promise<void> {
  const headers = await authHeaders();
  const res = await fetch(`/api/meetings/${id}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Delete failed: ${res.status}`);
  }
}
```

- [ ] **Step 2: Verify frontend compiles**

Run: `cd web && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/api.ts
git commit -m "feat: add deleteMeeting API function"
```

---

## Task 7: CalendarPanel Component

**Files:**
- Create: `web/src/components/CalendarPanel.tsx`

- [ ] **Step 1: Create CalendarPanel component**

Create `web/src/components/CalendarPanel.tsx`:

```tsx
"use client";

import { useState, useEffect, useCallback } from "react";
import { getElectronAPIOrNull } from "@/lib/electron-bridge";
import type { CalendarEvent } from "@/types";

interface CalendarPanelProps {
  onSelectMeeting: (event: CalendarEvent) => void;
  selectedMeetingId: string | null;
}

function formatTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function CalendarPanel({ onSelectMeeting, selectedMeetingId }: CalendarPanelProps) {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const api = getElectronAPIOrNull();

  const loadCalendar = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.getCalendar();
      setEvents(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load calendar");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    loadCalendar();
  }, [loadCalendar]);

  if (!api) return null; // Hide in browser

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
          Upcoming
        </h2>
        <button
          onClick={loadCalendar}
          disabled={loading}
          className="text-xs text-blue-600 hover:text-blue-800 disabled:text-gray-400"
        >
          Refresh
        </button>
      </div>

      {loading && <p className="text-sm text-gray-400">Loading calendar...</p>}
      {error && <p className="text-sm text-red-500">{error}</p>}

      {!loading && !error && events.length === 0 && (
        <p className="text-sm text-gray-400">No upcoming meetings</p>
      )}

      <ul className="space-y-1">
        {events.map((evt) => (
          <li key={evt.id}>
            <button
              onClick={() => onSelectMeeting(evt)}
              className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                selectedMeetingId === evt.id
                  ? "bg-blue-50 border border-blue-200 text-blue-900"
                  : "hover:bg-gray-50 text-gray-700"
              }`}
            >
              <p className="font-medium truncate">{evt.subject}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {formatTime(evt.start)} – {formatTime(evt.end)}
                {evt.attendees.length > 0 && ` · ${evt.attendees.length} attendee${evt.attendees.length > 1 ? "s" : ""}`}
              </p>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Verify frontend compiles**

Run: `cd web && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add web/src/components/CalendarPanel.tsx
git commit -m "feat: add CalendarPanel component for upcoming meetings sidebar"
```

---

## Task 8: Shared Recording Hook & Format Utility

**Files:**
- Create: `web/src/lib/format.ts`
- Create: `web/src/lib/useRecordingStatus.ts`

Both `RecordingControls` and `RecordingStatusBar` need identical timer logic and elapsed-time formatting. Extract these into shared modules to avoid duplication.

- [ ] **Step 1: Create format utility**

Create `web/src/lib/format.ts`:

```typescript
/**
 * Format milliseconds as mm:ss or h:mm:ss.
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
```

- [ ] **Step 2: Create useRecordingStatus hook**

Create `web/src/lib/useRecordingStatus.ts`:

```typescript
"use client";

import { useState, useEffect, useRef } from "react";
import { getElectronAPIOrNull } from "@/lib/electron-bridge";

interface RecordingState {
  recording: boolean;
  meetingTitle?: string;
  elapsed: number;
}

/**
 * Hook that subscribes to recording status from Electron's main process.
 * Returns current recording state with a live-updating elapsed timer.
 * Returns { recording: false, elapsed: 0 } when not in Electron.
 */
export function useRecordingStatus(): RecordingState {
  const [recording, setRecording] = useState(false);
  const [meetingTitle, setMeetingTitle] = useState<string | undefined>();
  const [elapsed, setElapsed] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const api = getElectronAPIOrNull();

  // Poll initial state + subscribe to pushes
  useEffect(() => {
    if (!api) return;
    api.isRecording().then((isRec) => {
      setRecording(isRec);
      if (isRec) startTimeRef.current = Date.now();
    });

    const unsub = api.onRecordingStatus((status) => {
      setRecording(status.recording);
      setMeetingTitle(status.meetingTitle);
      if (status.recording && status.startedAt) {
        startTimeRef.current = status.startedAt;
      } else {
        startTimeRef.current = null;
      }
    });
    return unsub;
  }, [api]);

  // Elapsed timer
  useEffect(() => {
    if (recording) {
      if (!startTimeRef.current) startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        setElapsed(Date.now() - (startTimeRef.current ?? Date.now()));
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      setElapsed(0);
      startTimeRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [recording]);

  return { recording, meetingTitle, elapsed };
}
```

- [ ] **Step 3: Verify frontend compiles**

Run: `cd web && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/format.ts web/src/lib/useRecordingStatus.ts
git commit -m "feat: extract shared useRecordingStatus hook and formatElapsed utility"
```

---

## Task 9: RecordingControls Component

**Files:**
- Create: `web/src/components/RecordingControls.tsx`

Uses the shared `useRecordingStatus` hook from Task 8 — no duplicated timer logic.

- [ ] **Step 1: Create RecordingControls component**

Create `web/src/components/RecordingControls.tsx`:

```tsx
"use client";

import { useCallback } from "react";
import { getElectronAPIOrNull } from "@/lib/electron-bridge";
import { useRecordingStatus } from "@/lib/useRecordingStatus";
import { formatElapsed } from "@/lib/format";
import type { CalendarEvent } from "@/types";

interface RecordingControlsProps {
  selectedMeeting: CalendarEvent | null;
}

export default function RecordingControls({ selectedMeeting }: RecordingControlsProps) {
  const { recording, elapsed } = useRecordingStatus();
  const api = getElectronAPIOrNull();

  const handleStart = useCallback(async () => {
    if (!api) return;
    const outputPath = `meeting-${Date.now()}.wav`;
    const micName = localStorage.getItem("settings:micName") ?? "";
    const loopbackName = localStorage.getItem("settings:loopbackName") ?? "";
    await api.startRecording({ micName, loopbackName, outputPath });
    if (selectedMeeting) {
      await api.selectMeeting(selectedMeeting);
    }
  }, [api, selectedMeeting]);

  const handleStop = useCallback(async () => {
    if (!api) return;
    await api.stopRecording();
  }, [api]);

  if (!api) return null;

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
        Recording
      </h2>

      {recording ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 bg-red-500 rounded-full animate-pulse" />
            <span className="text-sm font-medium text-red-700">Recording</span>
            <span className="text-sm text-gray-500 ml-auto font-mono">
              {formatElapsed(elapsed)}
            </span>
          </div>
          <button
            onClick={handleStop}
            className="w-full px-3 py-2 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 transition-colors"
          >
            Stop Recording
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-gray-500">
            {selectedMeeting
              ? `Meeting: ${selectedMeeting.subject}`
              : "Select a meeting above, or record ad-hoc"}
          </p>
          <button
            onClick={handleStart}
            className="w-full px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors"
          >
            Start Recording
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify frontend compiles**

Run: `cd web && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add web/src/components/RecordingControls.tsx
git commit -m "feat: add RecordingControls component using shared recording hook"
```

---

## Task 10: RecordingStatusBar Component

**Files:**
- Create: `web/src/components/RecordingStatusBar.tsx`
- Modify: `web/src/app/(protected)/layout.tsx`

Uses the shared `useRecordingStatus` hook and `formatElapsed` from Task 8 — no duplicated logic.

- [ ] **Step 1: Create RecordingStatusBar component**

Create `web/src/components/RecordingStatusBar.tsx`:

```tsx
"use client";

import { getElectronAPIOrNull } from "@/lib/electron-bridge";
import { useRecordingStatus } from "@/lib/useRecordingStatus";
import { formatElapsed } from "@/lib/format";

export default function RecordingStatusBar() {
  const { recording, meetingTitle, elapsed } = useRecordingStatus();
  const api = getElectronAPIOrNull();

  if (!recording) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-red-600 text-white px-4 py-2 flex items-center gap-3 z-50">
      <span className="inline-block w-2 h-2 bg-white rounded-full animate-pulse" />
      <span className="text-sm font-medium">
        Recording{meetingTitle ? `: ${meetingTitle}` : ""}
      </span>
      <span className="text-sm font-mono ml-auto">{formatElapsed(elapsed)}</span>
      <button
        onClick={() => api?.stopRecording()}
        className="px-3 py-1 bg-white text-red-600 text-sm font-medium rounded hover:bg-red-50 transition-colors"
      >
        Stop
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Add RecordingStatusBar to protected layout**

Modify `web/src/app/(protected)/layout.tsx`:

```tsx
import AuthGuard from "@/components/AuthGuard";
import Nav from "@/components/Nav";
import RecordingStatusBar from "@/components/RecordingStatusBar";

export default function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      <Nav />
      <main className="flex-1 p-8 overflow-auto min-h-screen">{children}</main>
      <RecordingStatusBar />
    </AuthGuard>
  );
}
```

- [ ] **Step 3: Verify frontend compiles**

Run: `cd web && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add web/src/components/RecordingStatusBar.tsx web/src/app/\(protected\)/layout.tsx
git commit -m "feat: add persistent RecordingStatusBar to protected layout"
```

---

## Task 11: Dashboard Redesign (Two-Column Layout)

**Files:**
- Modify: `web/src/app/(protected)/page.tsx`

- [ ] **Step 1: Rewrite dashboard page with sidebar layout**

Replace `web/src/app/(protected)/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { getElectronAPIOrNull } from "@/lib/electron-bridge";
import MeetingList from "@/components/MeetingList";
import UploadModal from "@/components/UploadModal";
import CalendarPanel from "@/components/CalendarPanel";
import RecordingControls from "@/components/RecordingControls";
import type { CalendarEvent } from "@/types";

export default function DashboardPage() {
  const [showUpload, setShowUpload] = useState(false);
  const [selectedMeeting, setSelectedMeeting] = useState<CalendarEvent | null>(null);
  const electron = !!getElectronAPIOrNull();

  return (
    <div className={electron ? "flex gap-8" : ""}>
      {/* Sidebar — Electron only */}
      {electron && (
        <aside className="w-64 flex-shrink-0 space-y-6">
          <CalendarPanel
            onSelectMeeting={setSelectedMeeting}
            selectedMeetingId={selectedMeeting?.id ?? null}
          />
          <hr className="border-gray-200" />
          <RecordingControls selectedMeeting={selectedMeeting} />
        </aside>
      )}

      {/* Main content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Meetings</h1>
          <button
            onClick={() => setShowUpload(true)}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors"
          >
            Upload Recording
          </button>
        </div>
        <MeetingList />
        {showUpload && <UploadModal onClose={() => setShowUpload(false)} />}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify frontend compiles**

Run: `cd web && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add web/src/app/\(protected\)/page.tsx
git commit -m "feat: two-column dashboard with calendar sidebar and recording controls"
```

---

## Task 12: Search & Filter for Meeting List

**Files:**
- Create: `web/src/components/SearchFilter.tsx`
- Modify: `web/src/components/MeetingList.tsx`

- [ ] **Step 1: Create SearchFilter component**

Create `web/src/components/SearchFilter.tsx`:

```tsx
"use client";

interface SearchFilterProps {
  search: string;
  onSearchChange: (value: string) => void;
  statusFilter: string;
  onStatusChange: (value: string) => void;
}

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "processing", label: "Processing" },
  { value: "transcribing", label: "Transcribing" },
  { value: "summarising", label: "Summarising" },
  { value: "complete", label: "Complete" },
  { value: "failed", label: "Failed" },
];

export default function SearchFilter({
  search,
  onSearchChange,
  statusFilter,
  onStatusChange,
}: SearchFilterProps) {
  return (
    <div className="flex gap-3 mb-4">
      <input
        type="text"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Search meetings..."
        className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      />
      <select
        value={statusFilter}
        onChange={(e) => onStatusChange(e.target.value)}
        className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        {STATUS_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
```

- [ ] **Step 2: Integrate SearchFilter into MeetingList**

Modify `web/src/components/MeetingList.tsx` — add state for search/filter, import SearchFilter. Pass `statusFilter` to the backend via `useMeetings()` (the hook already supports a `status` query param). Title search stays client-side (backend doesn't support title search yet).

Add imports and state at the top of the component:

```tsx
import { useState } from "react";
import SearchFilter from "./SearchFilter";
```

Inside the `MeetingList` component, add:

```tsx
const [search, setSearch] = useState("");
const [statusFilter, setStatusFilter] = useState("");
```

Update the `useMeetings` call to pass the status filter to the backend:

```tsx
const { data, error, isLoading } = useMeetings(1, 20, statusFilter || undefined);
```

Before the `return`, add client-side title filtering:

```tsx
const filtered = data.items.filter((m) => {
  if (search && !m.title.toLowerCase().includes(search.toLowerCase())) return false;
  return true;
});
```

Add `<SearchFilter ... />` above the table, and use `filtered` instead of `data.items` in the map.

- [ ] **Step 3: Verify frontend compiles**

Run: `cd web && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add web/src/components/SearchFilter.tsx web/src/components/MeetingList.tsx
git commit -m "feat: add search and status filter to meeting list"
```

---

## Task 13: Delete Meeting Button

**Files:**
- Create: `web/src/components/DeleteMeetingButton.tsx`
- Modify: `web/src/components/MeetingList.tsx`

- [ ] **Step 1: Create DeleteMeetingButton component**

Create `web/src/components/DeleteMeetingButton.tsx`:

```tsx
"use client";

import { useState } from "react";
import { deleteMeeting } from "@/lib/api";
import { useSWRConfig } from "swr";

interface DeleteMeetingButtonProps {
  meetingId: number;
  meetingTitle: string;
}

export default function DeleteMeetingButton({ meetingId, meetingTitle }: DeleteMeetingButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { mutate } = useSWRConfig();

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteMeeting(meetingId);
      await mutate((key: unknown) => typeof key === "string" && key.startsWith("/api/meetings"));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  };

  if (confirming) {
    return (
      <span className="inline-flex gap-1 text-xs">
        <span className="text-gray-500">Delete?</span>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="text-red-600 hover:text-red-800 font-medium"
        >
          {deleting ? "..." : "Yes"}
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="text-gray-500 hover:text-gray-700"
        >
          No
        </button>
      </span>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      className="text-gray-400 hover:text-red-600 transition-colors text-sm"
      title={`Delete ${meetingTitle}`}
    >
      Delete
    </button>
  );
}
```

- [ ] **Step 2: Add Delete column to MeetingList table**

Modify `web/src/components/MeetingList.tsx` — add a new `<th>` header and `<td>` cell with `<DeleteMeetingButton />` in each row.

Add import:

```tsx
import DeleteMeetingButton from "./DeleteMeetingButton";
```

Add header after Status:

```tsx
<th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
```

Add cell after Status cell:

```tsx
<td className="px-6 py-4">
  <DeleteMeetingButton meetingId={m.id} meetingTitle={m.title} />
</td>
```

- [ ] **Step 3: Verify frontend compiles**

Run: `cd web && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add web/src/components/DeleteMeetingButton.tsx web/src/components/MeetingList.tsx
git commit -m "feat: add delete meeting button with inline confirmation"
```

---

## Task 14: Export Transcript/Summary Menu

**Files:**
- Create: `web/src/components/ExportMenu.tsx`

This component will be used on the meeting detail page. It takes transcript segments and summary text and offers copy/download options.

- [ ] **Step 1: Create ExportMenu component**

Create `web/src/components/ExportMenu.tsx`:

```tsx
"use client";

import { useState, useRef, useEffect } from "react";
import type { TranscriptSegment, SummaryResponse } from "@/types";

interface ExportMenuProps {
  meetingTitle: string;
  segments: TranscriptSegment[] | null;
  summary: SummaryResponse | null;
}

function buildPlainText(title: string, segments: TranscriptSegment[] | null, summary: SummaryResponse | null): string {
  const lines: string[] = [`# ${title}`, ""];

  if (summary?.summary_text) {
    lines.push("## Summary", summary.summary_text, "");
    if (summary.key_points.length > 0) {
      lines.push("## Key Points");
      summary.key_points.forEach((p) => lines.push(`- ${p}`));
      lines.push("");
    }
    if (summary.follow_ups.length > 0) {
      lines.push("## Follow-ups");
      summary.follow_ups.forEach((f) => lines.push(`- ${f}`));
      lines.push("");
    }
  }

  if (segments && segments.length > 0) {
    lines.push("## Transcript", "");
    segments.forEach((seg) => {
      const start = formatTimestamp(seg.start);
      lines.push(`[${start}] ${seg.speaker}: ${seg.text}`);
    });
  }

  return lines.join("\n");
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function downloadFile(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ExportMenu({ meetingTitle, segments, summary }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const text = buildPlainText(meetingTitle, segments, summary);
  const slug = meetingTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="px-3 py-1.5 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50 transition-colors"
      >
        Export
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-48 bg-white border border-gray-200 rounded-md shadow-lg z-10">
          <button
            onClick={() => { navigator.clipboard.writeText(text); setOpen(false); }}
            className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            Copy to clipboard
          </button>
          <button
            onClick={() => { downloadFile(text, `${slug}.txt`); setOpen(false); }}
            className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            Download as .txt
          </button>
          <button
            onClick={() => { downloadFile(text, `${slug}.md`); setOpen(false); }}
            className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            Download as .md
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify frontend compiles**

Run: `cd web && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add web/src/components/ExportMenu.tsx
git commit -m "feat: add ExportMenu component for transcript/summary export"
```

- [ ] **Step 4: Integrate ExportMenu into meeting detail page**

Add the ExportMenu to the meeting detail header in `web/src/app/(protected)/meetings/[[...id]]/MeetingDetailContent.tsx`.

Add import:

```tsx
import ExportMenu from "@/components/ExportMenu";
```

Add the component next to the existing header content (exact placement depends on the header JSX — place it in the top-right action area alongside any existing buttons):

```tsx
<ExportMenu
  meetingTitle={meeting.title}
  segments={meeting.transcript?.segments ?? null}
  summary={meeting.summary ?? null}
/>
```

- [ ] **Step 5: Verify frontend compiles**

Run: `cd web && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 6: Commit**

```bash
git add web/src/components/ExportMenu.tsx web/src/app/\(protected\)/meetings/\[\[...id\]\]/MeetingDetailContent.tsx
git commit -m "feat: add ExportMenu component and integrate into meeting detail page"
```

---

## Task 15: Settings Page

**Files:**
- Create: `web/src/app/(protected)/settings/page.tsx`
- Modify: `web/src/components/Nav.tsx`

- [ ] **Step 1: Read Nav.tsx to understand current navigation**

Run: Read `web/src/components/Nav.tsx` to see how links are structured.

- [ ] **Step 2: Create Settings page**

Create `web/src/app/(protected)/settings/page.tsx`:

```tsx
"use client";

import { useState, useEffect } from "react";
import { getElectronAPIOrNull } from "@/lib/electron-bridge";
import type { AudioDevice } from "@/lib/electron-bridge";

export default function SettingsPage() {
  const api = getElectronAPIOrNull();
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [micName, setMicName] = useState("");
  const [loopbackName, setLoopbackName] = useState("");
  const [backendUrl, setBackendUrl] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!api) return;
    api.getAudioDevices().then(setDevices);
    api.getBackendUrl().then(setBackendUrl);
    setAppVersion(api.getAppVersion());

    // Load saved preferences
    const savedMic = localStorage.getItem("settings:micName") ?? "";
    const savedLoopback = localStorage.getItem("settings:loopbackName") ?? "";
    setMicName(savedMic);
    setLoopbackName(savedLoopback);
  }, [api]);

  const handleSave = () => {
    localStorage.setItem("settings:micName", micName);
    localStorage.setItem("settings:loopbackName", loopbackName);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleSignOut = async () => {
    if (!api) return;
    await api.signOut();
    window.location.reload();
  };

  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Settings</h1>

      {/* Audio Devices — Electron only */}
      {api && (
        <section className="mb-8">
          <h2 className="text-lg font-semibold text-gray-800 mb-3">Audio Devices</h2>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Microphone
              </label>
              <select
                value={micName}
                onChange={(e) => setMicName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
              >
                <option value="">System default</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.name}>{d.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                System Audio (Loopback)
              </label>
              <select
                value={loopbackName}
                onChange={(e) => setLoopbackName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
              >
                <option value="">System default</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.name}>{d.name}</option>
                ))}
              </select>
            </div>
            <button
              onClick={handleSave}
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors"
            >
              {saved ? "Saved!" : "Save"}
            </button>
          </div>
        </section>
      )}

      {/* App Info */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-gray-800 mb-3">About</h2>
        <dl className="space-y-2 text-sm">
          {appVersion && (
            <div className="flex justify-between">
              <dt className="text-gray-500">App Version</dt>
              <dd className="text-gray-900">{appVersion}</dd>
            </div>
          )}
          {backendUrl && (
            <div className="flex justify-between">
              <dt className="text-gray-500">Backend URL</dt>
              <dd className="text-gray-900 font-mono text-xs">{backendUrl}</dd>
            </div>
          )}
        </dl>
      </section>

      {/* Sign Out */}
      <section>
        <button
          onClick={handleSignOut}
          className="px-4 py-2 border border-red-300 text-red-600 text-sm font-medium rounded-md hover:bg-red-50 transition-colors"
        >
          Sign Out
        </button>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Add Settings link to Nav**

Modify `web/src/components/Nav.tsx` — add a link to `/settings` in the navigation.

- [ ] **Step 4: Verify frontend compiles**

Run: `cd web && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add web/src/app/\(protected\)/settings/page.tsx web/src/components/Nav.tsx
git commit -m "feat: add settings page with audio device selection and sign out"
```

---

## Task 16: Tray Simplification

**Files:**
- Modify: `desktop/src/main/tray.ts`

- [ ] **Step 1: Remove "Select Meeting..." from tray menu**

In `desktop/src/main/tray.ts`, remove the `{ label: 'Select Meeting...', click: openMeetingSelector }` entry and its separator from the `rebuildMenu()` function.

Keep `openMeetingSelector()` function and `meetingSelectorWindow` for now (can be removed in a later cleanup), but remove it from the menu.

Updated menu template:

```typescript
tray.setContextMenu(Menu.buildFromTemplate([
  { label: 'Start Recording', enabled: !recording, click: handleStartRecording },
  { label: 'Stop Recording', enabled: recording, click: handleStopRecording },
  { type: 'separator' },
  { label: 'Open App', click: () => _onOpenApp() },
  { type: 'separator' },
  { label: 'Quit', click: () => app.quit() },
]));
```

- [ ] **Step 2: Verify desktop compiles**

Run: `cd desktop && npx tsc -p tsconfig.main.json --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main/tray.ts
git commit -m "refactor: simplify tray menu — remove meeting selector (now in main window)"
```

---

## Task 17: Full Build Verification

- [ ] **Step 1: Run desktop tests**

Run: `cd desktop && npx jest --verbose`
Expected: All tests pass

- [ ] **Step 2: Run backend tests**

Run: `cd backend && python -m pytest -v`
Expected: All tests pass

- [ ] **Step 3: Run frontend type check**

Run: `cd web && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run full desktop build**

Run: `cd desktop && npm run build`
Expected: Build completes without errors

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: resolve build/test issues from UI redesign"
```

---

## Summary

| Task | Description | Files | Test Coverage |
|------|-------------|-------|---------------|
| 1 | Expand electron-bridge.ts + CalendarEvent type | 2 modify | Type check |
| 2 | Preload bridge expansion | 1 modify, 1 test | Jest |
| 3 | Audio device IPC handler | 1 modify, 1 test | Jest |
| 4 | Recording status push | 2 modify | Type check |
| 5 | Backend DELETE endpoint | 1 modify, 1 test | pytest (4 cases) |
| 6 | Frontend deleteMeeting API | 1 modify | Type check |
| 7 | CalendarPanel component | 1 new | Type check |
| 8 | Shared recording hook + format | 2 new | Type check |
| 9 | RecordingControls component | 1 new | Type check |
| 10 | RecordingStatusBar + layout | 1 new, 1 modify | Type check |
| 11 | Dashboard two-column layout | 1 modify | Type check |
| 12 | Search & filter | 1 new, 1 modify | Type check |
| 13 | Delete meeting button | 1 new, 1 modify | Type check |
| 14 | Export menu + integration | 1 new, 1 modify | Type check |
| 15 | Settings page | 1 new, 1 modify | Type check |
| 16 | Tray simplification | 1 modify | Type check |
| 17 | Full build verification | — | All suites |
