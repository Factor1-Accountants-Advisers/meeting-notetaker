# Design: Speaker Label Rename + Audio Waveform & Transcript Sync

**Date:** 2026-04-08  
**Status:** Approved  
**Scope:** Meeting detail view — two independent frontend+backend improvements

---

## Overview

Two quality-of-life features for the meeting detail view:

1. **Speaker Label Rename (#3)** — Inline editing of generic speaker labels (e.g. "Speaker A") in the transcript, persisted to the database, replacing all occurrences for that meeting.
2. **Audio Waveform + Transcript Sync (#4)** — Replace the plain HTML5 `<audio>` element with a Wavesurfer.js waveform, and sync audio playback position to transcript by highlighting and auto-scrolling the active segment.

These features are independent and can be implemented in either order.

---

## Feature #3: Speaker Label Rename

### Context

AssemblyAI diarisation assigns generic labels ("Speaker A", "Speaker B") when it cannot match voices to real names. Users need a way to correct these labels manually after the fact. The rename applies to the whole meeting transcript — "Speaker A" is always the same person within a single meeting.

### User Flow

1. User clicks a speaker name in any transcript segment row.
2. The `<span>` is replaced in-place by an `<input>` pre-filled with the current label, auto-focused with text selected.
3. User types the correct name.
4. **Save:** Press `Enter` or blur the input → PATCH request fires; all occurrences of the old name in the transcript update immediately (optimistic); input reverts to `<span>` showing the new name.
5. **Cancel:** Press `Escape` → input reverts to `<span>` with original name unchanged.
6. If the PATCH fails, the optimistic update is rolled back and the original name is restored.

### Components

#### New: `SpeakerLabel` component
**File:** `web/src/components/SpeakerLabel.tsx`

Props:
```ts
interface SpeakerLabelProps {
  name: string;           // Current speaker label
  colorClass: string;     // Tailwind colour class from SPEAKER_COLORS rotation
  meetingId: number;
  onRenamed: (oldName: string, newName: string) => void; // Callback to update local state
}
```

Behaviour:
- `isEditing` boolean state, defaults `false`
- When not editing: renders `<span className={colorClass}>` with `onClick` → `setIsEditing(true)`
- When editing: renders `<input>` with `defaultValue={name}`, `autoFocus`, `onKeyDown` (Enter → save, Escape → cancel), `onBlur` → save
- Save calls `renameSpeaker(meetingId, oldName, newName)` API helper (see below)

#### Modified: `MeetingDetailContent.tsx`

- Replace the speaker `<span>` in the segment row (line 221) with `<SpeakerLabel>`.
- Add local `speakerAliases: Record<string, string>` state — a map of original → current display name. Initialised from the transcript data.
- `onRenamed` callback updates `speakerAliases` and triggers SWR `mutate` to refresh transcript data from server.

### API

#### New backend endpoint
```
PATCH /api/meetings/{meeting_id}/rename-speaker
Authorization: Bearer <token>
Content-Type: application/json

Body:
{
  "old_name": "Speaker A",
  "new_name": "John Smith"
}

Response 200:
{
  "updated_count": 7
}
```

**Backend logic (`backend/app/routers/meetings.py`):**
1. Fetch `Transcript` for `meeting_id`, verify meeting belongs to current user.
2. Load `segments` JSON array.
3. Iterate segments; for each where `segment["speaker"] == old_name`, set `segment["speaker"] = new_name`.
4. Save updated segments back to the `Transcript` record.
5. Return `{ "updated_count": N }`.

#### New frontend API helper
**File:** `web/src/lib/api.ts` (add to existing file)

```ts
export async function renameSpeaker(
  meetingId: number,
  oldName: string,
  newName: string
): Promise<{ updated_count: number }>
```

Uses the existing `apiFetch` pattern in the codebase.

### Error Handling

- If `new_name` is empty or whitespace after trim → do not fire request; cancel edit.
- If `new_name === old_name` → do not fire request; close edit silently.
- If PATCH returns non-2xx → roll back optimistic update; show brief inline error state on the `SpeakerLabel` (red border for 2s then revert).

### No cross-meeting persistence
The rename is stored in the `segments` JSON for that meeting's `Transcript` record only. There is no global speaker identity store — "Speaker A" in one meeting is independent of "Speaker A" in another.

---

## Feature #4: Audio Waveform + Transcript Sync

### Context

The current `AudioPlayer` wraps a plain `<audio>` element. It exposes a `seekTo(seconds)` handle via `forwardRef` which `MeetingDetailContent` calls when the user clicks a transcript timestamp. The transcript does not react to audio playback — there is no highlighting or auto-scroll when the audio progresses.

### Changes

#### Rewrite: `AudioPlayer.tsx`

Replace the `<audio>` element with Wavesurfer.js. The public interface (`AudioPlayerHandle.seekTo`) stays identical so `MeetingDetailContent` requires no changes to its `audioRef` usage.

**New props:**
```ts
interface AudioPlayerProps {
  src: string | null;
  onTimeUpdate?: (currentTime: number) => void; // NEW — fires on Wavesurfer timeupdate
}
```

**Internals:**
- `containerRef` points to a `<div>` where Wavesurfer mounts.
- `wavesurferRef` holds the WaveSurfer instance.
- On mount: `WaveSurfer.create({ container, url: src, waveColor, progressColor, height, barWidth, barRadius })`. Theme-aware colours via CSS custom properties read at init time.
- On `timeupdate` event: call `onTimeUpdate(wavesurfer.getCurrentTime())`.
- `seekTo(seconds)`: `wavesurfer.seekTo(seconds / wavesurfer.getDuration())`.
- Cleanup: `wavesurfer.destroy()` on unmount.
- Render custom play/pause button (or use Wavesurfer's built-in controls via `interact: true`).

**Waveform colours (theme-compatible):**
- Light mode: `waveColor: var(--border-subtle)`, `progressColor: var(--accent-text)`
- Dark mode: same CSS vars resolve to appropriate dark values automatically

#### Modified: `MeetingDetailContent.tsx`

1. Add `onTimeUpdate` prop pass-through to `<AudioPlayer>`.
2. Add `activeSegmentIndex: number | null` state.
3. `handleTimeUpdate(currentTime: number)`:
   - Binary search `segments` array for the segment where `seg.start <= currentTime < seg.end`.
   - Set `activeSegmentIndex` to found index (or `null` if none).
4. Add `segmentRefs = useRef<(HTMLDivElement | null)[]>([])`.
5. `useEffect` on `activeSegmentIndex`: call `segmentRefs.current[activeSegmentIndex]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })`.
6. Each segment `<div>` gets `ref={el => segmentRefs.current[i] = el}` and a conditional class:
   - Active: `bg-[color:var(--surface-soft)] ring-1 ring-[color:var(--border-subtle)]`
   - Inactive: existing styles unchanged

The "Expand all" toggle still works — when collapsed, only the first 5 segments are rendered, so scroll targets outside the visible set won't exist; the `scrollIntoView` call is a no-op in that case (graceful degradation).

### Dependency

Add to `web/package.json`:
```
"wavesurfer.js": "^7.x"
```

(WaveSurfer v7 is ESM-compatible and works with Next.js App Router without additional config.)

### Error Handling

- If `src` is null: render nothing (same as current behaviour).
- If Wavesurfer fails to decode audio: show a fallback message "Audio could not be loaded" in place of the waveform.
- `onTimeUpdate` is optional — `MeetingDetailContent` passes it but callers that use `AudioPlayer` standalone don't need to.

---

## Files Changed Summary

| File | Change |
|------|--------|
| `web/src/components/SpeakerLabel.tsx` | **New** — inline-editable speaker name component |
| `web/src/components/AudioPlayer.tsx` | **Rewrite** — Wavesurfer.js, adds `onTimeUpdate` prop |
| `web/src/app/(protected)/meetings/[[...id]]/MeetingDetailContent.tsx` | **Modify** — wire `SpeakerLabel`, `onTimeUpdate`, `activeSegmentIndex`, `segmentRefs` |
| `web/src/lib/api.ts` | **Modify** — add `renameSpeaker()` helper |
| `backend/app/routers/meetings.py` | **Modify** — add `PATCH /{id}/rename-speaker` endpoint |
| `web/package.json` | **Modify** — add `wavesurfer.js` dependency |

---

## Out of Scope

- Cross-meeting speaker identity learning
- Improving AssemblyAI diarisation quality (separate initiative)
- Waveform region selection (Phase 2+)
- Mobile-specific waveform optimisation
