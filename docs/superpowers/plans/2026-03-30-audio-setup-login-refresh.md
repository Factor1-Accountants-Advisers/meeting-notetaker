# Audio Setup And Sign-In Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make audio setup explicit and first-time-user friendly, block recording until devices are configured, refresh the sign-in page to match the new shell, and route successful uploads directly into the meeting processing/detail view.

**Architecture:** Keep the existing dashboard structure and Electron bridge intact. Introduce a small shared audio-settings utility so the settings page and recording panel use the same source of truth, then update the affected screens to consume that utility and existing navigation/state hooks.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript, Tailwind CSS, SWR, Electron preload bridge, Next ESLint.

---

## File Map

### Existing files to modify

- `web/src/app/(protected)/settings/page.tsx`
  - Convert from generic settings layout into guided audio setup UI.
- `web/src/components/RecordingPanel.tsx`
  - Replace guessed-device fallback with explicit device gate.
- `web/src/app/login/page.tsx`
  - Restyle login surface to match the main shell.
- `web/src/components/UploadModal.tsx`
  - Emit the created meeting ID upward after successful upload.
- `web/src/app/(protected)/page.tsx`
  - Consume upload success callback and open the new meeting detail.

### New files to create

- `web/src/lib/audio-settings.ts`
  - Shared helpers for reading, writing, and validating selected audio devices.

## Implementation Notes

- The current web package has no frontend test runner configured. Do not expand scope by installing Vitest/Jest for this change.
- Use `web/src/lib/audio-settings.ts` to make the recording gate and settings page deterministic and easier to verify.
- Verification for this plan relies on `next lint`, `next build`, and targeted manual UI checks in Electron/web.

---

### Task 1: Add Shared Audio Settings Utility

**Files:**
- Create: `web/src/lib/audio-settings.ts`
- Verify: `web/src/lib/audio-settings.ts`

- [ ] **Step 1: Create the shared audio settings helper**

Add a small utility module:

```ts
const MIC_STORAGE_KEY = "settings:micName";
const LOOPBACK_STORAGE_KEY = "settings:loopbackName";

export interface SavedAudioSettings {
  micName: string;
  loopbackName: string;
}

export function readAudioSettings(): SavedAudioSettings {
  if (typeof window === "undefined") {
    return { micName: "", loopbackName: "" };
  }

  return {
    micName: window.localStorage.getItem(MIC_STORAGE_KEY) ?? "",
    loopbackName: window.localStorage.getItem(LOOPBACK_STORAGE_KEY) ?? "",
  };
}

export function saveAudioSettings(settings: SavedAudioSettings): void {
  window.localStorage.setItem(MIC_STORAGE_KEY, settings.micName);
  window.localStorage.setItem(LOOPBACK_STORAGE_KEY, settings.loopbackName);
}

export function hasCompleteAudioSettings(settings: SavedAudioSettings): boolean {
  return settings.micName.trim() !== "" && settings.loopbackName.trim() !== "";
}
```

- [ ] **Step 2: Run TypeScript-aware lint on the new file**

Run:

```bash
cd web
npx next lint --file src/lib/audio-settings.ts
```

Expected: lint passes with no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/audio-settings.ts
git commit -m "refactor: add shared audio settings helpers"
```

---

### Task 2: Convert Settings Into Guided Audio Setup

**Files:**
- Modify: `web/src/app/(protected)/settings/page.tsx`
- Use: `web/src/lib/audio-settings.ts`
- Verify: `web/src/app/(protected)/settings/page.tsx`

- [ ] **Step 1: Replace direct localStorage access with the shared utility**

Update the page imports and state loading:

```ts
import {
  readAudioSettings,
  saveAudioSettings,
  hasCompleteAudioSettings,
} from "@/lib/audio-settings";
```

Use:

```ts
const savedSettings = readAudioSettings();
setMicName(savedSettings.micName);
setLoopbackName(savedSettings.loopbackName);
```

And save with:

```ts
saveAudioSettings({ micName, loopbackName });
```

- [ ] **Step 2: Redesign the page as a guided setup surface**

Replace the current dark legacy structure with a calmer shell:

```tsx
<div className="mx-auto max-w-3xl">
  <div className="surface-card rounded-[32px] px-8 py-8 shadow-[var(--shadow-panel)]">
    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--text-muted)]">
      Settings
    </p>
    <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[color:var(--text-primary)]">
      Audio Setup
    </h1>
    <p className="mt-3 max-w-2xl text-sm leading-7 text-[color:var(--text-secondary)]">
      Before recording a meeting, choose your microphone and the system audio source that captures Teams audio.
    </p>
```

Use one primary setup card inside with two large selectors and helper text:

```tsx
<section className="mt-8 rounded-[28px] border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] p-6">
  <div className="space-y-6">
    <div>
      <label className="mb-2 block text-sm font-semibold text-[color:var(--text-primary)]">
        Microphone
      </label>
      <p className="mb-3 text-sm text-[color:var(--text-secondary)]">
        Choose the microphone that captures your voice during the meeting.
      </p>
```

And:

```tsx
    <div>
      <label className="mb-2 block text-sm font-semibold text-[color:var(--text-primary)]">
        System Audio
      </label>
      <p className="mb-3 text-sm text-[color:var(--text-secondary)]">
        Choose the audio source that captures Teams or your computer audio.
      </p>
```

Keep `About` and `Sign Out` below as secondary sections with softer styling.

- [ ] **Step 3: Add an explicit completeness indicator**

Show a small success or warning block above the save button:

```tsx
{hasCompleteAudioSettings({ micName, loopbackName }) ? (
  <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
    Audio setup is complete. You can start recording from the dashboard.
  </div>
) : (
  <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
    Choose both a microphone and system audio source before recording.
  </div>
)}
```

- [ ] **Step 4: Run lint for the settings page**

Run:

```bash
cd web
npx next lint --file 'src/app/(protected)/settings/page.tsx' --file src/lib/audio-settings.ts
```

Expected: lint passes with no errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/'(protected)'/settings/page.tsx web/src/lib/audio-settings.ts
git commit -m "feat: redesign settings as guided audio setup"
```

---

### Task 3: Gate Recording Until Devices Are Configured

**Files:**
- Modify: `web/src/components/RecordingPanel.tsx`
- Use: `web/src/lib/audio-settings.ts`
- Verify: `web/src/components/RecordingPanel.tsx`

- [ ] **Step 1: Replace guessed-device fallback with shared settings read**

Import:

```ts
import { readAudioSettings, hasCompleteAudioSettings } from "@/lib/audio-settings";
```

In the component body, compute:

```ts
const audioSettings = readAudioSettings();
const audioReady = hasCompleteAudioSettings(audioSettings);
```

In `handleStart`, remove:

```ts
const devices = await electron.getAudioDevices();
const micName = localStorage.getItem("settings:micName") || devices?.[0]?.name || "default";
const loopbackName = localStorage.getItem("settings:loopbackName") || devices?.[1]?.name || "default";
```

Use:

```ts
if (!audioReady) {
  setError("Before recording, choose your microphone and system audio in Settings.");
  return;
}

await electron.startRecording({
  micName: audioSettings.micName,
  loopbackName: audioSettings.loopbackName,
  outputPath: "",
  metadata: buildMetadata(),
});
```

- [ ] **Step 2: Add the blocked setup state UI**

In the non-recording panel render, above the main button, add:

```tsx
{!audioReady && (
  <div className="mb-4 rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4">
    <p className="text-sm font-medium text-[color:var(--text-primary)]">
      Before recording, choose your microphone and system audio.
    </p>
    <p className="mt-1 text-xs leading-6 text-[color:var(--text-secondary)]">
      This only needs to be set once on this device.
    </p>
    <button
      type="button"
      onClick={() => router.push("/settings")}
      className="mt-3 inline-flex h-10 items-center rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] px-4 text-sm font-medium text-[color:var(--text-primary)] transition hover:border-[color:var(--border-strong)]"
    >
      Set up audio devices
    </button>
  </div>
)}
```

Add:

```ts
import { useRouter } from "next/navigation";
const router = useRouter();
```

- [ ] **Step 3: Disable the record action until setup is complete**

Update the button state:

```tsx
<button
  onClick={handleStart}
  disabled={!canStart || !audioReady}
  className="... disabled:cursor-not-allowed disabled:opacity-50"
>
  <CircleDot className="w-4 h-4" />
  Start Recording
</button>
```

- [ ] **Step 4: Run lint for the recording flow**

Run:

```bash
cd web
npx next lint --file src/components/RecordingPanel.tsx --file src/lib/audio-settings.ts
```

Expected: lint passes with no errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/RecordingPanel.tsx web/src/lib/audio-settings.ts
git commit -m "feat: require audio setup before recording"
```

---

### Task 4: Open Meeting Detail After Manual Upload

**Files:**
- Modify: `web/src/components/UploadModal.tsx`
- Modify: `web/src/app/(protected)/page.tsx`
- Verify: `web/src/components/UploadModal.tsx`
- Verify: `web/src/app/(protected)/page.tsx`

- [ ] **Step 1: Add an upload success callback to the modal**

Update props:

```ts
export default function UploadModal({
  onClose,
  onUploaded,
}: {
  onClose: () => void;
  onUploaded?: (meetingId: number) => void;
}) {
```

After successful upload:

```ts
const result = await uploadMeeting({
  file,
  title: title.trim(),
  attendees,
  scheduledTime: scheduledTime || undefined,
});

await mutate((key: unknown) => typeof key === "string" && key.startsWith("/api/meetings"));
onUploaded?.(result.meeting_id);
onClose();
```

- [ ] **Step 2: Wire the dashboard to open the created meeting**

In `web/src/app/(protected)/page.tsx`, change the modal render to:

```tsx
{showUpload && (
  <UploadModal
    onClose={() => setShowUpload(false)}
    onUploaded={(meetingId) => {
      setShowUpload(false);
      setShowRecordingPanel(false);
      setSelectedCalendarEvent(null);
      setDetailMeetingId(meetingId);
    }}
  />
)}
```

This reuses the existing detail-panel path and status polling.

- [ ] **Step 3: Run lint for the upload handoff**

Run:

```bash
cd web
npx next lint --file src/components/UploadModal.tsx --file 'src/app/(protected)/page.tsx'
```

Expected: lint passes with no errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/UploadModal.tsx web/src/app/'(protected)'/page.tsx
git commit -m "feat: open uploaded meetings in detail view"
```

---

### Task 5: Refresh The Sign-In Page

**Files:**
- Modify: `web/src/app/login/page.tsx`
- Verify: `web/src/app/login/page.tsx`

- [ ] **Step 1: Replace the legacy dark full-screen login with the shared shell**

Restructure the page around one centered card:

```tsx
<div className="min-h-screen bg-[color:var(--app-bg)] px-6 py-10">
  <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-5xl items-center justify-center">
    <div className="surface-card w-full max-w-xl rounded-[36px] px-8 py-10 text-center shadow-[var(--shadow-panel)]">
```

Content:

```tsx
      <div className="mx-auto mb-6 inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)]">
        <PenTool className="h-6 w-6 text-[color:var(--text-primary)]" />
      </div>
      <h1 className="text-4xl font-semibold tracking-tight text-[color:var(--text-primary)]">
        Note Taker
      </h1>
      <p className="mx-auto mt-4 max-w-md text-sm leading-7 text-[color:var(--text-secondary)]">
        Sign in with your organisation account to open your meetings, record audio, and review notes.
      </p>
```

Use a rounded primary button that matches the dashboard CTA language.

- [ ] **Step 2: Keep the device-code help text but soften the presentation**

Render it only while signing in:

```tsx
{signingIn && (
  <p className="mt-4 text-sm leading-6 text-[color:var(--text-secondary)]">
    A device code prompt will appear separately. Follow the sign-in steps, then return to Note Taker.
  </p>
)}
```

- [ ] **Step 3: Run lint for login**

Run:

```bash
cd web
npx next lint --file src/app/login/page.tsx
```

Expected: lint passes with no errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/app/login/page.tsx
git commit -m "feat: refresh login page to match app shell"
```

---

### Task 6: Full Verification

**Files:**
- Verify only: `web/src/app/(protected)/settings/page.tsx`
- Verify only: `web/src/components/RecordingPanel.tsx`
- Verify only: `web/src/components/UploadModal.tsx`
- Verify only: `web/src/app/(protected)/page.tsx`
- Verify only: `web/src/app/login/page.tsx`
- Verify only: `web/src/lib/audio-settings.ts`

- [ ] **Step 1: Run full frontend lint**

Run:

```bash
cd web
npm run lint
```

Expected: lint passes.

- [ ] **Step 2: Run production build**

Run:

```bash
cd web
npm run build
```

Expected: build completes successfully. Existing unrelated Next export warnings are acceptable if they predate this work.

- [ ] **Step 3: Manual Electron verification**

Run the desktop app and verify:

```bash
cd desktop
npm run dev
```

Manual checks:

- open `/settings` and confirm both audio selectors are visible and save correctly
- return to dashboard with missing device settings and confirm recording is blocked
- click `Set up audio devices` and confirm it navigates to settings
- save both devices and confirm recording becomes available
- use the upload modal and confirm a successful upload opens the right-side meeting detail/progress view
- confirm the sign-in page uses the new visual shell when signed out

- [ ] **Step 4: Commit final verification-safe changes**

```bash
git add web/src/app/'(protected)'/settings/page.tsx web/src/components/RecordingPanel.tsx web/src/components/UploadModal.tsx web/src/app/'(protected)'/page.tsx web/src/app/login/page.tsx web/src/lib/audio-settings.ts
git commit -m "feat: improve audio setup and login experience"
```

---

## Self-Review

- Spec coverage: all approved items are mapped to tasks:
  - settings redesign -> Task 2
  - recording blocked until setup complete -> Task 3
  - direct settings CTA from blocked state -> Task 3
  - sign-in refresh -> Task 5
  - upload success opens meeting detail -> Task 4
- Placeholder scan: no `TBD` or deferred steps remain.
- Type consistency: shared audio settings shape is defined once in `audio-settings.ts` and reused by settings and recording flows.

