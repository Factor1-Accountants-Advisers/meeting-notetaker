# Join-Triggered Recording — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-record a host-owned Teams meeting only when the signed-in user is actually in that meeting's Teams call — never merely because the calendar says it has begun — failing closed with a one-click prompt when the app cannot see a join, and discarding accidental early-join false starts.

**Architecture:** A new pure module `join-watch-core.ts` (no Electron; plain-Node verify harness like `call-signals-core.ts`) tracks host-owned meetings from calendar-sync decisions, arms each at `start − 3 min`, polls that meeting's existing call-watch signal history every 5 s, derives *recorder-in-call* from history, and drives three injected effects: start recording (same `sendAutoStartRequest` the calendar uses today), show a one-time prompt at `start + 2 min`, disarm. A thin `join-watch.ts` runtime supplies real fetch/toast/log/persistence. The stop side (`call-signals-core`) gains a `reason` on `stop()` and an injectable poll interval; `recording-ipc` turns a grace-expiry stop of a join-triggered recording that ended before `start + 2 min` into a *discard* (`deliver: false`) and re-arms the meeting; the renderer honours `deliver: false` by skipping save/upload and deleting the empty backend meeting via a new owner-only `DELETE /meetings/{id}`. `MN_AUTO_START_TRIGGER=calendar` restores today's behaviour and is read from the supervisor's two-layer `backend.env`.

**Tech Stack:** Electron main (TypeScript, electron-vite), React renderer, FastAPI backend (Python 3.12, unittest/pytest), esbuild-bundled plain-Node verify harnesses (`node:assert/strict`), Windows toasts via `toast-xml.ts` protocol activations.

**Spec:** `docs/superpowers/specs/2026-08-18-join-triggered-recording-design.md` (J1–J7, F1–F4). Two refinements made while planning, folded into Task 0: (a) `call_ended` disarms only when it arrives **at or after scheduled start** — a pre-meeting camera-check that Teams ends at −20 must not disarm the real meeting; before start it simply means "not in call"; (b) arming is **timer-driven from every sync's decisions** (start − 3 min exactly), not from the 5-min poll grid's `autoRecordEligible` flip — the same input the registrar uses, a more faithful "calendar schedules".

**Branch:** `feature/join-triggered-recording` (already created off `main`; spec is committed there). Work in the main checkout `C:\Projects\meeting-notetaker-2`. Every task ends with `npm run typecheck` green and a commit. Run commands from the repo root in Git Bash.

**Verification commands used throughout:**
- `npm run typecheck` (both TS projects)
- `npm run verify:join-watch` (created in Task 1)
- `npm run verify:call-signals`, `npm run verify:call-watch-registrar` (must stay green)
- Backend: `PYTHONPATH=backend backend/.venv/Scripts/python.exe -m pytest backend/tests -q`
- `git diff --check` before every commit (CRLF trap: write files with LF; on Windows Python use `newline=''`)

---

## File structure

| File | Responsibility |
|---|---|
| `src/main/join-watch-core.ts` (new) | Pure: `deriveCallPresence`, `decideFalseStart`, `readAutoStartTrigger`, and `createJoinWatchEngine` (per-meeting lifecycle, timers, polling, effects by injection). No Electron/MSAL/log/network imports. |
| `src/main/join-watch.ts` (new) | Runtime: real transport (`createCallWatchTransport`), electron-log, toast, persistence of "prompted" keys under userData, module singleton, `configureJoinWatch` / `handleJoinWatchSyncDecisions` / `joinWatchPromptAccepted` / `joinWatchRecordingDiscarded`. |
| `scripts/verify-join-watch.ts` (new) | Plain-Node harness over the pure core; asserts the bundle has no `require("electron")`. |
| `src/main/call-signals-core.ts` | `CallSignalActions.stop(reason)`; poll interval injectable (already `pollIntervalMs?` — expose a setter for the live poller). |
| `src/main/call-signals.ts` | Pass a `pollIntervalMs` through `armCallSignals` (5 s when join mode). |
| `src/main/recording-state.ts` | `ActiveRecording.trigger`, `ActiveRecording.startedAtUtc`, `forgetCompleted(key)`. |
| `src/main/recording-ipc.ts` | `sendAutoStopRequest({ reason })` → false-start decision → `deliver` on the IPC payload; pending-discard bookkeeping; `handleRendererRecordingStopped` forgets + notifies join-watch. |
| `src/main/toast-xml.ts` | `buildJoinPromptToastXml(title)`; `record-now` action. |
| `src/main/backend-supervisor.ts` | Expose the parsed credential layers (`getBackendEnvLayers()`). |
| `src/main/index.ts` | Wire join-watch; `handleAutoRecordEligible` starts only in `calendar` mode; `record-now` toast handler; pass `stop(reason)`. |
| `src/preload/index.ts` | `AutoStopRequest.deliver`. |
| `src/renderer/src/App.tsx` | `deliver: false` → stop capture, discard spill, delete backend meeting, no save/upload. |
| `src/renderer/src/lib/api.ts` | `deleteMeeting(id)`. |
| `backend/app/routers/meetings.py` | `DELETE /meetings/{meeting_id}` (owner-only, only while no audio/pipeline). |
| `backend/tests/test_meeting_delete.py` (new) | Tests for the delete route. |
| `package.json`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `backend.env.template`, `docs/rollout-runbook.md` | Script, CI gate, repo-variable passthrough, docs. |

---

### Task 0: Spec refinements

**Files:**
- Modify: `docs/superpowers/specs/2026-08-18-join-triggered-recording-design.md`

- [ ] **Step 1: Amend J2** — replace the bullet `- \`call_ended\` before any start disarms — the meeting is over.` with:

```markdown
- `call_ended` **at or after scheduled start** with no later recorder IN
  disarms — the meeting is over. A `call_ended` *before* scheduled start
  (Teams ending a pre-meeting camera check) only means "not in call": the
  meeting stays armed and the real call's `recorder_rejoined` starts it.
```

- [ ] **Step 2: Amend J1** — after "it **arms** the join watcher for that meeting." add:

```markdown
Arming is timer-driven: the join watcher receives every sync's decisions
(the same unfiltered feed the registrar consumes), tracks host-owned
candidates with their `startUtc`/`endUtc`, and arms each at exactly
`start − 3 min` by its own timer rather than waiting for the 5-min poll grid
to flip `autoRecordEligible`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-08-18-join-triggered-recording-design.md
git commit -m "docs: join-trigger spec — call_ended-before-start and timer-driven arming"
```

---

### Task 1: Pure core — `deriveCallPresence` + harness scaffold

**Files:**
- Create: `src/main/join-watch-core.ts`
- Create: `scripts/verify-join-watch.ts`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Add the npm script** — in `package.json` `"scripts"`, after `"verify:call-watch-registrar": ...` add:

```json
    "verify:join-watch": "esbuild scripts/verify-join-watch.ts --bundle --platform=node --format=cjs --outfile=out/verify-join-watch.cjs --log-level=error --external:electron && node out/verify-join-watch.cjs",
```

- [ ] **Step 2: Write the failing harness** — `scripts/verify-join-watch.ts`:

```ts
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deriveCallPresence, type CallPresence } from '../src/main/join-watch-core'
import type { CallSignal } from '../src/main/call-signals-core'

let seqCounter = 0
/** Signals in the exact shape `parseCallSignals` produces; `seq` is
 *  monotonic so ordering matches the store (chronological seq, spec E2). */
function sig(type: CallSignal['type'], receivedUtc: string): CallSignal {
  seqCounter += 1
  return { seq: `${receivedUtc.replace(/[-:.TZ]/g, '')}-${String(seqCounter).padStart(4, '0')}`, type, event_utc: receivedUtc, received_utc: receivedUtc }
}

const T = (min: number): string => new Date(Date.UTC(2026, 7, 20, 10, 0, 0) + min * 60_000).toISOString()

// ---- deriveCallPresence -----------------------------------------------------
{
  const none: CallPresence = deriveCallPresence([])
  assert.deepEqual(none, { inCall: false, endedAtOrAfterStart: false, lastSignalUtc: null })

  const early = deriveCallPresence([sig('recorder_rejoined', T(-30))])
  assert.equal(early.inCall, true, 'early joiner still in')

  const leftAgain = deriveCallPresence([sig('recorder_rejoined', T(-30)), sig('recorder_left', T(-10))])
  assert.equal(leftAgain.inCall, false)

  const rejoin = deriveCallPresence([sig('recorder_rejoined', T(-30)), sig('recorder_left', T(-10)), sig('recorder_rejoined', T(15))])
  assert.equal(rejoin.inCall, true)

  // Pre-start call_ended (camera check) → not in call, NOT "ended".
  const preEnd = deriveCallPresence([sig('recorder_rejoined', T(-25)), sig('call_ended', T(-20))], T(0))
  assert.equal(preEnd.inCall, false)
  assert.equal(preEnd.endedAtOrAfterStart, false)

  // Post-start call_ended with no later IN → ended.
  const postEnd = deriveCallPresence([sig('recorder_rejoined', T(0)), sig('call_ended', T(30))], T(0))
  assert.equal(postEnd.inCall, false)
  assert.equal(postEnd.endedAtOrAfterStart, true)

  // Post-start call_ended followed by a fresh IN → back in call, not ended.
  const restarted = deriveCallPresence([sig('recorder_rejoined', T(0)), sig('call_ended', T(30)), sig('recorder_rejoined', T(35))], T(0))
  assert.equal(restarted.inCall, true)
  assert.equal(restarted.endedAtOrAfterStart, false)

  // Out-of-order input is sorted by seq before walking.
  const shuffled = deriveCallPresence([sig('recorder_left', T(-10)), sig('recorder_rejoined', T(-30))].reverse(), T(0))
  assert.equal(shuffled.inCall, false)
}

// ---- bundle purity ---------------------------------------------------------
{
  const bundle = join(process.cwd(), 'out', 'verify-join-watch.cjs')
  if (existsSync(bundle)) {
    const src = readFileSync(bundle, 'utf8')
    assert.ok(!/require\(["']electron["']\)/.test(src), 'join-watch-core must not import electron')
  }
}

console.log('join-watch verification passed')
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm run verify:join-watch`
Expected: esbuild error — `Could not resolve "../src/main/join-watch-core"`.

- [ ] **Step 4: Create the core with `deriveCallPresence`** — `src/main/join-watch-core.ts`:

```ts
/**
 * Join-triggered recording — pure core (spec 2026-08-18 J1–J7).
 *
 * Nothing in this file may import Electron, MSAL, `electron-log`, or reach
 * the network: timers, HTTP, toast, start requests, logging and persistence
 * all arrive by injection, so `scripts/verify-join-watch.ts` can bundle this
 * file alone (and asserts the bundle contains no `require("electron")`).
 *
 * The calendar schedules; the roster signal triggers. This module tracks
 * host-owned meetings from calendar-sync decisions, arms each at
 * `start − AUTO_START_LEAD_MS`, polls that meeting's call-watch signal
 * history, derives *recorder-in-call* from the whole history (a position,
 * not an event — an early joiner still present at −3 min has no fresh
 * signal), and fires start / prompt / disarm.
 *
 * Every "no" is silent and fails closed: no positive signal, no recording.
 */

import type { CallSignal } from './call-signals-core'
import type { GraphEventDecision } from './graph/types'

// ---------------------------------------------------------------------------
// Constants (J7)
// ---------------------------------------------------------------------------

export const JOIN_WATCH_LEAD_MS = 3 * 60_000
export const JOIN_WATCH_PROMPT_OFFSET_MS = 2 * 60_000
export const JOIN_WATCH_PROMPT_LIFETIME_MS = 60_000
export const JOIN_WATCH_POLL_INTERVAL_MS = 5_000
export const JOIN_WATCH_DISARM_AFTER_END_MS = 10 * 60_000
export const FALSE_START_MAX_DURATION_MS = 5 * 60_000
export const FALSE_START_MAX_AFTER_START_MS = 2 * 60_000

// ---------------------------------------------------------------------------
// deriveCallPresence
// ---------------------------------------------------------------------------

export interface CallPresence {
  /** Last recorder signal is `recorder_rejoined` and no `call_ended` follows it. */
  inCall: boolean
  /** A `call_ended` at/after `scheduledStartUtc` with no later recorder IN. */
  endedAtOrAfterStart: boolean
  lastSignalUtc: string | null
}

/**
 * Walk the FULL signal history for a watch (the relay returns every signal
 * of the current watch generation, sorted by seq — verified 18 Aug in
 * storage-api `list_signals`) and compute the recorder's current position.
 *
 * `scheduledStartUtc` decides whether a `call_ended` means "the meeting is
 * over" (at/after start) or merely "not in call right now" (a pre-meeting
 * camera check that Teams ended). Missing/empty history is `inCall: false`
 * — unknown is never in-call.
 */
export function deriveCallPresence(signals: readonly CallSignal[], scheduledStartUtc?: string): CallPresence {
  const startMs = scheduledStartUtc ? Date.parse(scheduledStartUtc) : Number.NaN
  const ordered = [...signals].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))
  let inCall = false
  let endedAtOrAfterStart = false
  let lastSignalUtc: string | null = null
  for (const s of ordered) {
    lastSignalUtc = s.received_utc
    if (s.type === 'recorder_rejoined') {
      inCall = true
      endedAtOrAfterStart = false
    } else if (s.type === 'recorder_left') {
      inCall = false
    } else if (s.type === 'call_ended') {
      inCall = false
      const atMs = Date.parse(s.received_utc)
      endedAtOrAfterStart = Number.isFinite(startMs) && Number.isFinite(atMs) && atMs >= startMs
    }
  }
  return { inCall, endedAtOrAfterStart, lastSignalUtc }
}
```

- [ ] **Step 5: Run the harness**

Run: `npm run verify:join-watch`
Expected: `join-watch verification passed`

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck && git diff --check
git add src/main/join-watch-core.ts scripts/verify-join-watch.ts package.json
git commit -m "feat(join-watch): deriveCallPresence + verify harness scaffold"
```

---

### Task 2: Pure core — `decideFalseStart` and `readAutoStartTrigger`

**Files:**
- Modify: `src/main/join-watch-core.ts`
- Modify: `scripts/verify-join-watch.ts`

- [ ] **Step 1: Failing tests** — append to the harness before the bundle-purity block:

```ts
import { decideFalseStart, readAutoStartTrigger } from '../src/main/join-watch-core'   // add to the import at the top

// ---- decideFalseStart ------------------------------------------------------
{
  const base = { trigger: 'join' as const, scheduledStartUtc: T(0), startedAtUtc: T(-2) }
  // Left at −1, grace expired at 0 → discard.
  assert.equal(decideFalseStart({ ...base, stopReason: 'grace_expired', nowUtc: T(0) }), 'discard')
  // Ended at +3 → deliver (after start + 2).
  assert.equal(decideFalseStart({ ...base, stopReason: 'grace_expired', nowUtc: T(3) }), 'deliver')
  // Ended by call_ended → deliver regardless of time.
  assert.equal(decideFalseStart({ ...base, stopReason: 'call_ended', nowUtc: T(0) }), 'deliver')
  // Prompt- and calendar-triggered are never discarded.
  assert.equal(decideFalseStart({ ...base, trigger: 'prompt', stopReason: 'grace_expired', nowUtc: T(0) }), 'deliver')
  assert.equal(decideFalseStart({ ...base, trigger: 'calendar', stopReason: 'grace_expired', nowUtc: T(0) }), 'deliver')
  // Duration guard: started at −10 (a rescheduled meeting), 8 min long → deliver.
  assert.equal(decideFalseStart({ ...base, startedAtUtc: T(-10), stopReason: 'grace_expired', nowUtc: T(-2) }), 'deliver')
  // Missing startedAt → cannot prove short → deliver.
  assert.equal(decideFalseStart({ ...base, startedAtUtc: undefined, stopReason: 'grace_expired', nowUtc: T(0) }), 'deliver')
}

// ---- readAutoStartTrigger --------------------------------------------------
{
  assert.equal(readAutoStartTrigger({}, {}), 'join')
  assert.equal(readAutoStartTrigger({}, { MN_AUTO_START_TRIGGER: 'calendar' }), 'calendar')
  assert.equal(readAutoStartTrigger({}, { MN_AUTO_START_TRIGGER: ' Calendar ' }), 'calendar')
  assert.equal(readAutoStartTrigger({}, { MN_AUTO_START_TRIGGER: 'nonsense' }), 'join', 'unknown → join (fail closed)')
  // Layers win over process env (they are the %PROGRAMDATA%/bundled files).
  assert.equal(readAutoStartTrigger({ MN_AUTO_START_TRIGGER: 'join' }, { MN_AUTO_START_TRIGGER: 'calendar' }), 'join')
  assert.equal(readAutoStartTrigger({ MN_AUTO_START_TRIGGER: 'calendar' }, {}), 'calendar')
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run verify:join-watch`
Expected: esbuild error — `No matching export ... for import "decideFalseStart"`.

- [ ] **Step 3: Implement** — append to `join-watch-core.ts`:

```ts
// ---------------------------------------------------------------------------
// decideFalseStart (J4)
// ---------------------------------------------------------------------------

export type RecordingTrigger = 'join' | 'prompt' | 'calendar'
export type AutoStopReason = 'grace_expired' | 'call_ended' | 'scheduled_end' | 'manual'

export interface FalseStartInput {
  trigger: RecordingTrigger | undefined
  stopReason: AutoStopReason
  scheduledStartUtc: string
  startedAtUtc: string | undefined
  nowUtc: string
}

/**
 * A join-triggered recording that the leave flow stopped BEFORE the meeting
 * was really under way is a false start (early join, then left): discard it
 * and let the meeting re-arm. Anchored on scheduled start, not duration
 * alone, so a genuinely short call at its scheduled time still delivers.
 * Prompt- and calendar-triggered recordings are never discarded — a human
 * (or the legacy mode) chose those. Any doubt → deliver.
 */
export function decideFalseStart(input: FalseStartInput): 'discard' | 'deliver' {
  if (input.trigger !== 'join') return 'deliver'
  if (input.stopReason !== 'grace_expired') return 'deliver'
  const startMs = Date.parse(input.scheduledStartUtc)
  const nowMs = Date.parse(input.nowUtc)
  const startedMs = input.startedAtUtc ? Date.parse(input.startedAtUtc) : Number.NaN
  if (![startMs, nowMs, startedMs].every(Number.isFinite)) return 'deliver'
  if (nowMs >= startMs + FALSE_START_MAX_AFTER_START_MS) return 'deliver'
  if (nowMs - startedMs >= FALSE_START_MAX_DURATION_MS) return 'deliver'
  return 'discard'
}

// ---------------------------------------------------------------------------
// readAutoStartTrigger (J6)
// ---------------------------------------------------------------------------

export type AutoStartTrigger = 'join' | 'calendar'

/**
 * `MN_AUTO_START_TRIGGER`. `layers` is the supervisor's parsed two-layer
 * backend.env (bundled, then %PROGRAMDATA% — already merged, PROGRAMDATA
 * wins) and takes precedence over the process env; the code default is
 * `join`; anything unrecognised is `join` (fail closed: never fall back to
 * calendar-time recording by typo).
 */
export function readAutoStartTrigger(
  layers: Record<string, string | undefined>,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): AutoStartTrigger {
  const raw = (layers.MN_AUTO_START_TRIGGER ?? env.MN_AUTO_START_TRIGGER ?? '').trim().toLowerCase()
  return raw === 'calendar' ? 'calendar' : 'join'
}
```

- [ ] **Step 4: Run, typecheck, commit**

Run: `npm run verify:join-watch && npm run typecheck && git diff --check`
Expected: `join-watch verification passed`, no type errors.

```bash
git add src/main/join-watch-core.ts scripts/verify-join-watch.ts
git commit -m "feat(join-watch): decideFalseStart + readAutoStartTrigger"
```

---

### Task 3: Pure core — `createJoinWatchEngine` (lifecycle, timers, polling, effects)

This is the heart. Everything is injected. Read `createCallSignalPoller` in `call-signals-core.ts` first for the house style (never throw, status-only logs, timers via deps).

**Files:**
- Modify: `src/main/join-watch-core.ts`
- Modify: `scripts/verify-join-watch.ts`

- [ ] **Step 1: Failing tests** — append to the harness (before bundle purity). Uses a fake clock, fake timers, and a scripted HTTP.

```ts
import { createJoinWatchEngine, type JoinWatchEngine, type JoinWatchDeps } from '../src/main/join-watch-core'   // add to imports
import type { GraphEventDecision } from '../src/main/graph/types'

/** Production-shaped decision (host-owned online meeting). Fields that
 *  `filter.ts` couples are DERIVED here exactly as production does: a
 *  candidate before start−lead is `not_due_yet` AND `autoRecordEligible:false`. */
function decisionAt(opts: { key: string; startUtc: string; endUtc: string; nowUtc: string; joinWebUrl?: string; organizer?: boolean; title?: string }): GraphEventDecision {
  const nowMs = Date.parse(opts.nowUtc)
  const due = Date.parse(opts.startUtc) - JOIN_WATCH_LEAD_MS <= nowMs
  const organizer = opts.organizer ?? true
  return {
    eventId: `evt-${opts.key}`,
    idempotencyKey: opts.key,
    status: 'candidate',
    reason: !organizer ? 'not_organizer' : due ? 'eligible' : 'not_due_yet',
    autoRecordEligible: organizer && due,
    metadata: {
      title: opts.title ?? `Meeting ${opts.key}`,
      attendees: [],
      meetingId: `m-${opts.key}`,
      joinWebUrl: opts.joinWebUrl ?? `https://teams.microsoft.com/l/meetup-join/${opts.key}`,
      organizerEmail: 'joseph@factor1.com.au',
      scheduledStartUtc: opts.startUtc
    },
    logContext: {
      eventIdHash: `h-${opts.key}`,
      startUtc: opts.startUtc,
      endUtc: opts.endUtc,
      isOrganizer: organizer,
      isCancelled: false,
      isAllDay: false,
      attendeeCount: 2,
      isOnlineMeeting: true
    }
  }
}

interface Fake {
  engine: JoinWatchEngine
  now: () => number
  advance: (ms: number) => void
  http: { history: Record<string, CallSignal[]>; fail: boolean; calls: number }
  started: Array<{ key: string; trigger: string }>
  prompted: string[]
  disarmed: string[]
  recordingActive: { value: boolean }
  promptedStore: Set<string>
}

function makeFake(nowUtc: string, hasWatch: (hash: string) => boolean = () => true): Fake {
  let nowMs = Date.parse(nowUtc)
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let nextId = 1
  const http = { history: {} as Record<string, CallSignal[]>, fail: false, calls: 0 }
  const started: Fake['started'] = []
  const prompted: string[] = []
  const disarmed: string[] = []
  const recordingActive = { value: false }
  const promptedStore = new Set<string>()
  const deps: JoinWatchDeps = {
    hasActiveWatch: hasWatch,
    joinUrlHash: (url) => `hash(${url})`,
    fetchSignals: async (hash) => {
      http.calls += 1
      if (http.fail) return null
      return http.history[hash] ?? []
    },
    isRecordingActive: () => recordingActive.value,
    startRecording: (m, trigger) => { started.push({ key: m.idempotencyKey, trigger }) },
    showPrompt: (m) => { prompted.push(m.idempotencyKey) },
    onDisarm: (m) => { disarmed.push(m.idempotencyKey) },
    promptedKeys: { has: (k) => promptedStore.has(k), add: (k) => { promptedStore.add(k) } },
    timers: {
      setTimeout: (fn, ms) => { const id = nextId++; timers.push({ at: nowMs + ms, fn, id }); return id },
      clearTimeout: (h) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1) }
    },
    now: () => nowMs,
    log: () => {}
  }
  const engine = createJoinWatchEngine(deps)
  const advance = (ms: number): void => {
    const target = nowMs + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const next = timers[0]
      if (!next || next.at > target) break
      timers.shift()
      nowMs = next.at
      next.fn()
    }
    nowMs = target
  }
  return { engine, now: () => nowMs, advance, http, started, prompted, disarmed, recordingActive, promptedStore }
}

// Drain microtasks so async poll ticks settle inside the fake clock.
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const H = (key: string): string => `hash(https://teams.microsoft.com/l/meetup-join/${key})`

// ---- engine scenarios ------------------------------------------------------
await (async () => {
  // 1. Early join, still in at −3 → start at −3.
  {
    const f = makeFake(T(-30))
    f.http.history[H('a')] = [sig('recorder_rejoined', T(-30))]
    f.engine.handleSyncDecisions([decisionAt({ key: 'a', startUtc: T(0), endUtc: T(60), nowUtc: T(-30) })], 'joseph@factor1.com.au')
    f.advance(26 * 60_000); await settle()
    assert.deepEqual(f.started, [], 'nothing before −3')
    f.advance(60_000 + 1); await settle(); f.advance(JOIN_WATCH_POLL_INTERVAL_MS); await settle()
    assert.deepEqual(f.started, [{ key: 'a', trigger: 'join' }], 'starts at −3 when still in')
  }
  // 2. Early join, left at −10, no return → nothing; prompt at +2.
  {
    const f = makeFake(T(-30))
    f.http.history[H('b')] = [sig('recorder_rejoined', T(-30)), sig('recorder_left', T(-10))]
    f.engine.handleSyncDecisions([decisionAt({ key: 'b', startUtc: T(0), endUtc: T(60), nowUtc: T(-30) })], 'joseph@factor1.com.au')
    f.advance(32 * 60_000 + 1); await settle()
    assert.deepEqual(f.started, [])
    assert.deepEqual(f.prompted, ['b'], 'prompt at +2')
    f.advance(30 * 60_000); await settle()
    assert.deepEqual(f.prompted, ['b'], 'prompt fires once')
  }
  // 3. Left at −10, rejoin at +15 → start on the +15 signal.
  {
    const f = makeFake(T(-30))
    f.http.history[H('c')] = [sig('recorder_rejoined', T(-30)), sig('recorder_left', T(-10))]
    f.engine.handleSyncDecisions([decisionAt({ key: 'c', startUtc: T(0), endUtc: T(60), nowUtc: T(-30) })], 'joseph@factor1.com.au')
    f.advance(45 * 60_000); await settle()
    assert.deepEqual(f.started, [])
    f.http.history[H('c')].push(sig('recorder_rejoined', T(15)))
    f.advance(JOIN_WATCH_POLL_INTERVAL_MS + 1); await settle()
    assert.deepEqual(f.started, [{ key: 'c', trigger: 'join' }])
  }
  // 5. call_ended at/after start with no later IN → disarm, no start, no prompt.
  {
    const f = makeFake(T(-5))
    f.http.history[H('e')] = [sig('recorder_rejoined', T(-4)), sig('recorder_left', T(-3)), sig('call_ended', T(1))]
    f.engine.handleSyncDecisions([decisionAt({ key: 'e', startUtc: T(0), endUtc: T(60), nowUtc: T(-5) })], 'joseph@factor1.com.au')
    f.advance(7 * 60_000); await settle()
    assert.deepEqual(f.started, [])
    assert.deepEqual(f.disarmed, ['e'])
    assert.deepEqual(f.prompted, [], 'disarmed before +2 → no prompt')
  }
  // 5b. call_ended BEFORE start (camera check) does not disarm; later IN starts.
  {
    const f = makeFake(T(-30))
    f.http.history[H('e2')] = [sig('recorder_rejoined', T(-25)), sig('call_ended', T(-20))]
    f.engine.handleSyncDecisions([decisionAt({ key: 'e2', startUtc: T(0), endUtc: T(60), nowUtc: T(-30) })], 'joseph@factor1.com.au')
    f.advance(29 * 60_000); await settle()
    assert.deepEqual(f.disarmed, [])
    f.http.history[H('e2')].push(sig('recorder_rejoined', T(-1)))
    f.advance(2 * 60_000); await settle()
    assert.deepEqual(f.started, [{ key: 'e2', trigger: 'join' }])
  }
  // 6. No active watch → never starts by signal; prompt at +2.
  {
    const f = makeFake(T(-5), () => false)
    f.http.history[H('f')] = [sig('recorder_rejoined', T(-4))]
    f.engine.handleSyncDecisions([decisionAt({ key: 'f', startUtc: T(0), endUtc: T(60), nowUtc: T(-5) })], 'joseph@factor1.com.au')
    f.advance(8 * 60_000); await settle()
    assert.deepEqual(f.started, [], 'no watch → no signal start')
    assert.deepEqual(f.prompted, ['f'])
    assert.equal(f.http.calls, 0, 'never polls a meeting without a watch')
    // Record now → start with trigger prompt.
    f.engine.acceptPrompt('f')
    assert.deepEqual(f.started, [{ key: 'f', trigger: 'prompt' }])
  }
  // 7. Prompt suppressed while another recording is live; persisted "prompted" survives a rebuild.
  {
    const f = makeFake(T(-5))
    f.recordingActive.value = true
    f.engine.handleSyncDecisions([decisionAt({ key: 'g', startUtc: T(0), endUtc: T(60), nowUtc: T(-5) })], 'joseph@factor1.com.au')
    f.advance(8 * 60_000); await settle()
    assert.deepEqual(f.prompted, [], 'suppressed while recording')
    // Simulate restart at +3 with the key already prompted in the store.
    const g = makeFake(T(3))
    g.promptedStore.add('g2')
    g.engine.handleSyncDecisions([decisionAt({ key: 'g2', startUtc: T(0), endUtc: T(60), nowUtc: T(3) })], 'joseph@factor1.com.au')
    g.advance(5 * 60_000); await settle()
    assert.deepEqual(g.prompted, [], 'no re-toast after restart')
  }
  // 8. Re-arm after a discarded false start: a later IN starts a fresh recording.
  {
    const f = makeFake(T(-3))
    f.http.history[H('h')] = [sig('recorder_rejoined', T(-2))]
    f.engine.handleSyncDecisions([decisionAt({ key: 'h', startUtc: T(0), endUtc: T(60), nowUtc: T(-3) })], 'joseph@factor1.com.au')
    f.advance(2 * 60_000); await settle()
    assert.deepEqual(f.started, [{ key: 'h', trigger: 'join' }])
    // Recording ran, user left at −1, grace expired, main discarded → tells us.
    f.http.history[H('h')].push(sig('recorder_left', T(-1)))
    f.engine.rearm('h')
    f.advance(6 * 60_000); await settle()
    assert.deepEqual(f.started, [{ key: 'h', trigger: 'join' }], 'not in call → no second start yet')
    f.http.history[H('h')].push(sig('recorder_rejoined', T(5)))
    f.advance(JOIN_WATCH_POLL_INTERVAL_MS + 1); await settle()
    assert.deepEqual(f.started, [{ key: 'h', trigger: 'join' }, { key: 'h', trigger: 'join' }])
  }
  // 12. Two overlapping armed meetings: a join starts THAT one; the other's prompt is suppressed while recording.
  {
    const f = makeFake(T(-3))
    f.http.history[H('x')] = [sig('recorder_rejoined', T(-1))]
    f.http.history[H('y')] = []
    f.engine.handleSyncDecisions([
      decisionAt({ key: 'x', startUtc: T(0), endUtc: T(60), nowUtc: T(-3) }),
      decisionAt({ key: 'y', startUtc: T(0), endUtc: T(60), nowUtc: T(-3) })
    ], 'joseph@factor1.com.au')
    f.advance(2 * 60_000); await settle()
    assert.deepEqual(f.started, [{ key: 'x', trigger: 'join' }])
    f.recordingActive.value = true
    f.advance(4 * 60_000); await settle()
    assert.deepEqual(f.prompted, [], "y's prompt suppressed while x records")
  }
  // 13. Signal fetch failing → unknown → no start; prompt still fires.
  {
    const f = makeFake(T(-3))
    f.http.fail = true
    f.http.history[H('z')] = [sig('recorder_rejoined', T(-2))]
    f.engine.handleSyncDecisions([decisionAt({ key: 'z', startUtc: T(0), endUtc: T(60), nowUtc: T(-3) })], 'joseph@factor1.com.au')
    f.advance(6 * 60_000); await settle()
    assert.deepEqual(f.started, [])
    assert.deepEqual(f.prompted, ['z'])
  }
  // Non-organizer meetings are ignored entirely.
  {
    const f = makeFake(T(-3))
    f.http.history[H('n')] = [sig('recorder_rejoined', T(-2))]
    f.engine.handleSyncDecisions([decisionAt({ key: 'n', startUtc: T(0), endUtc: T(60), nowUtc: T(-3), organizer: false })], 'joseph@factor1.com.au')
    f.advance(6 * 60_000); await settle()
    assert.deepEqual(f.started, []); assert.deepEqual(f.prompted, [])
  }
  // Disarm at end + 10 min; a decision that disappears from a later sync (cancelled) disarms too.
  {
    const f = makeFake(T(-3))
    f.engine.handleSyncDecisions([decisionAt({ key: 'd', startUtc: T(0), endUtc: T(60), nowUtc: T(-3) })], 'joseph@factor1.com.au')
    f.advance(74 * 60_000); await settle()
    assert.deepEqual(f.disarmed, ['d'])
    const g = makeFake(T(-3))
    g.engine.handleSyncDecisions([decisionAt({ key: 'd2', startUtc: T(0), endUtc: T(60), nowUtc: T(-3) })], 'joseph@factor1.com.au')
    g.engine.handleSyncDecisions([], 'joseph@factor1.com.au')
    assert.deepEqual(g.disarmed, ['d2'])
  }
})()
```

Note the harness file's top-level `await` inside an async IIFE — keep the `console.log('join-watch verification passed')` **inside** the IIFE's end (move it) so it prints only after the scenarios settle. Wrap the whole scenario block in `void (async () => { ... console.log(...) })().catch((e) => { console.error(e); process.exit(1) })`.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run verify:join-watch`
Expected: esbuild error — `No matching export ... "createJoinWatchEngine"`.

- [ ] **Step 3: Implement the engine** — append to `join-watch-core.ts`:

```ts
// ---------------------------------------------------------------------------
// Engine (J1–J3, J5)
// ---------------------------------------------------------------------------

export interface JoinWatchMeeting {
  /** `decision.idempotencyKey ?? decision.eventId` — the recording key. */
  idempotencyKey: string
  eventId: string
  joinWebUrl: string
  joinUrlHash: string
  startUtc: string
  endUtc: string
  title: string
  metadata: unknown
}

export type JoinWatchPhase = 'tracked' | 'armed' | 'recording' | 'disarmed'

export interface JoinWatchTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type JoinWatchLog = (level: 'info' | 'warn', message: string, context?: Record<string, unknown>) => void

export interface JoinWatchDeps {
  hasActiveWatch: (joinUrlHash: string) => boolean
  joinUrlHash: (joinWebUrl: string) => string
  /** Full signal history for a watch, or null on any transport failure. */
  fetchSignals: (joinUrlHash: string) => Promise<CallSignal[] | null>
  /** True while ANY recording is active or a start is pending. */
  isRecordingActive: () => boolean
  startRecording: (meeting: JoinWatchMeeting, trigger: 'join' | 'prompt') => void
  showPrompt: (meeting: JoinWatchMeeting) => void
  onDisarm: (meeting: JoinWatchMeeting) => void
  /** Persisted "prompted for meeting X" (survives restart). */
  promptedKeys: { has: (key: string) => boolean; add: (key: string) => void }
  timers: JoinWatchTimers
  now: () => number
  log: JoinWatchLog
  leadMs?: number
  promptOffsetMs?: number
  pollIntervalMs?: number
  disarmAfterEndMs?: number
  /** Ownership check for a decision (the registrar's `evaluateHostOwnership`).
   *  Defaults to `logContext.isOrganizer && status === 'candidate'`. */
  isHostOwned?: (decision: GraphEventDecision, signedInEmail?: string) => boolean
}

export interface JoinWatchEngine {
  /** Reconcile after a calendar sync (the same unfiltered decisions the
   *  registrar receives). Adds/updates tracked meetings, drops vanished ones. */
  handleSyncDecisions(decisions: readonly GraphEventDecision[], signedInEmail?: string): void
  /** The user clicked Record now on the prompt for `key`. */
  acceptPrompt(key: string): void
  /** Main discarded a false start for `key`: go back to armed and keep polling. */
  rearm(key: string): void
  /** A recording for `key` started (by us or otherwise): stop polling it. */
  noteRecordingStarted(key: string): void
  getPhase(key: string): JoinWatchPhase | undefined
  dispose(): void
}

interface Tracked {
  meeting: JoinWatchMeeting
  phase: JoinWatchPhase
  armTimer: unknown
  promptTimer: unknown
  disarmTimer: unknown
  pollTimer: unknown
  polling: boolean
}

export function createJoinWatchEngine(deps: JoinWatchDeps): JoinWatchEngine {
  const leadMs = deps.leadMs ?? JOIN_WATCH_LEAD_MS
  const promptOffsetMs = deps.promptOffsetMs ?? JOIN_WATCH_PROMPT_OFFSET_MS
  const pollIntervalMs = deps.pollIntervalMs ?? JOIN_WATCH_POLL_INTERVAL_MS
  const disarmAfterEndMs = deps.disarmAfterEndMs ?? JOIN_WATCH_DISARM_AFTER_END_MS
  const isHostOwned =
    deps.isHostOwned ?? ((d: GraphEventDecision) => d.status === 'candidate' && d.logContext.isOrganizer)

  const tracked = new Map<string, Tracked>()
  let disposed = false

  const clear = (t: Tracked, which: 'armTimer' | 'promptTimer' | 'disarmTimer' | 'pollTimer'): void => {
    if (t[which] === null || t[which] === undefined) return
    deps.timers.clearTimeout(t[which])
    t[which] = null
  }

  const safe = (label: string, fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      deps.log('warn', '[join-watch] effect threw', { effect: label, message: err instanceof Error ? err.message : String(err) })
    }
  }

  const disarm = (t: Tracked, reason: string): void => {
    if (t.phase === 'disarmed') return
    clear(t, 'armTimer'); clear(t, 'promptTimer'); clear(t, 'disarmTimer'); clear(t, 'pollTimer')
    t.phase = 'disarmed'
    deps.log('info', '[join-watch] disarmed', { key: t.meeting.idempotencyKey, reason })
    safe('onDisarm', () => deps.onDisarm(t.meeting))
    tracked.delete(t.meeting.idempotencyKey)
  }

  const start = (t: Tracked, trigger: 'join' | 'prompt'): void => {
    if (t.phase !== 'armed') return
    if (deps.isRecordingActive()) {
      deps.log('info', '[join-watch] start deferred: a recording is active', { key: t.meeting.idempotencyKey })
      return
    }
    t.phase = 'recording'
    clear(t, 'pollTimer'); clear(t, 'promptTimer')
    deps.log('info', '[join-watch] starting recording', { key: t.meeting.idempotencyKey, trigger })
    safe('startRecording', () => deps.startRecording(t.meeting, trigger))
  }

  const schedulePoll = (t: Tracked): void => {
    clear(t, 'pollTimer')
    if (t.phase !== 'armed') return
    t.pollTimer = deps.timers.setTimeout(() => {
      t.pollTimer = null
      void pollOnce(t)
    }, pollIntervalMs)
  }

  const pollOnce = async (t: Tracked): Promise<void> => {
    if (disposed || t.phase !== 'armed' || t.polling) return
    t.polling = true
    try {
      const signals = await deps.fetchSignals(t.meeting.joinUrlHash)
      if (t.phase !== 'armed') return
      if (signals === null) {
        deps.log('warn', '[join-watch] signal fetch failed', { key: t.meeting.idempotencyKey })
        return
      }
      const presence = deriveCallPresence(signals, t.meeting.startUtc)
      if (presence.endedAtOrAfterStart) {
        disarm(t, 'call_ended')
        return
      }
      if (presence.inCall) start(t, 'join')
    } finally {
      t.polling = false
      if (t.phase === 'armed') schedulePoll(t)
    }
  }

  const arm = (t: Tracked): void => {
    if (t.phase !== 'tracked') return
    t.phase = 'armed'
    deps.log('info', '[join-watch] armed', { key: t.meeting.idempotencyKey, hasWatch: deps.hasActiveWatch(t.meeting.joinUrlHash) })
    // Prompt timer (J3): once, at start + offset, if still armed and idle.
    const promptAt = Date.parse(t.meeting.startUtc) + promptOffsetMs
    const untilPrompt = Math.max(0, promptAt - deps.now())
    if (!deps.promptedKeys.has(t.meeting.idempotencyKey)) {
      t.promptTimer = deps.timers.setTimeout(() => {
        t.promptTimer = null
        if (t.phase !== 'armed') return
        if (deps.isRecordingActive()) {
          deps.log('info', '[join-watch] prompt suppressed: recording active', { key: t.meeting.idempotencyKey })
          return
        }
        if (deps.promptedKeys.has(t.meeting.idempotencyKey)) return
        deps.promptedKeys.add(t.meeting.idempotencyKey)
        deps.log('info', '[join-watch] prompting', { key: t.meeting.idempotencyKey })
        safe('showPrompt', () => deps.showPrompt(t.meeting))
      }, untilPrompt)
    }
    // Poll only when a watch exists; otherwise the prompt is the only path.
    if (deps.hasActiveWatch(t.meeting.joinUrlHash)) void pollOnce(t)
    else deps.log('info', '[join-watch] no active watch: prompt-only', { key: t.meeting.idempotencyKey })
  }

  const track = (meeting: JoinWatchMeeting): void => {
    const existing = tracked.get(meeting.idempotencyKey)
    if (existing) {
      // Reschedule (E4-style): times changed → re-track from scratch.
      if (existing.meeting.startUtc === meeting.startUtc && existing.meeting.endUtc === meeting.endUtc) {
        existing.meeting = meeting
        return
      }
      disarm(existing, 'rescheduled')
    }
    const t: Tracked = { meeting, phase: 'tracked', armTimer: null, promptTimer: null, disarmTimer: null, pollTimer: null, polling: false }
    tracked.set(meeting.idempotencyKey, t)
    const startMs = Date.parse(meeting.startUtc)
    const endMs = Date.parse(meeting.endUtc)
    const nowMs = deps.now()
    const disarmAt = endMs + disarmAfterEndMs
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || disarmAt <= nowMs) {
      tracked.delete(meeting.idempotencyKey)
      return
    }
    t.disarmTimer = deps.timers.setTimeout(() => { t.disarmTimer = null; disarm(t, 'window_closed') }, disarmAt - nowMs)
    const armAt = startMs - leadMs
    if (armAt <= nowMs) arm(t)
    else t.armTimer = deps.timers.setTimeout(() => { t.armTimer = null; arm(t) }, armAt - nowMs)
  }

  return {
    handleSyncDecisions(decisions, signedInEmail) {
      if (disposed) return
      const seen = new Set<string>()
      for (const d of decisions) {
        if (!isHostOwned(d, signedInEmail)) continue
        const { startUtc, endUtc } = d.logContext
        const joinWebUrl = d.metadata?.joinWebUrl
        if (!startUtc || !endUtc || !joinWebUrl) continue
        const key = d.idempotencyKey ?? d.eventId
        seen.add(key)
        track({
          idempotencyKey: key,
          eventId: d.eventId,
          joinWebUrl,
          joinUrlHash: deps.joinUrlHash(joinWebUrl),
          startUtc,
          endUtc,
          title: d.metadata?.title?.trim() || 'Teams meeting',
          metadata: d.metadata
        })
      }
      for (const [key, t] of [...tracked]) {
        if (!seen.has(key) && t.phase !== 'recording') disarm(t, 'vanished')
      }
    },
    acceptPrompt(key) {
      const t = tracked.get(key)
      if (!t) return
      start(t, 'prompt')
    },
    rearm(key) {
      const t = tracked.get(key)
      if (!t || t.phase !== 'recording') return
      t.phase = 'armed'
      deps.log('info', '[join-watch] re-armed after discarded false start', { key })
      if (deps.hasActiveWatch(t.meeting.joinUrlHash)) void pollOnce(t)
    },
    noteRecordingStarted(key) {
      const t = tracked.get(key)
      if (!t || t.phase === 'recording') return
      t.phase = 'recording'
      clear(t, 'pollTimer'); clear(t, 'promptTimer')
    },
    getPhase: (key) => tracked.get(key)?.phase,
    dispose() {
      disposed = true
      for (const t of tracked.values()) { clear(t, 'armTimer'); clear(t, 'promptTimer'); clear(t, 'disarmTimer'); clear(t, 'pollTimer') }
      tracked.clear()
    }
  }
}
```

- [ ] **Step 4: Run the harness; iterate until every scenario passes**

Run: `npm run verify:join-watch`
Expected: `join-watch verification passed`. If scenario 1 fails on timing, check `advance()` ordering — the arm timer at −3 fires `arm()` → immediate `pollOnce` (async) → `settle()` is required before asserting.

- [ ] **Step 5: Typecheck, commit**

```bash
npm run typecheck && git diff --check
git add src/main/join-watch-core.ts scripts/verify-join-watch.ts
git commit -m "feat(join-watch): engine — arm at start−3, poll history, start/prompt/disarm"
```

---

### Task 4: `call-signals-core` — `stop(reason)` and injectable poll interval

**Files:**
- Modify: `src/main/call-signals-core.ts:70-85` (actions), the two `actions.stop()` call sites in the machine, `createCallSignalPoller` deps
- Modify: `scripts/verify-call-signals.ts` (its fake actions must accept the new arg)

- [ ] **Step 1: Failing check** — in `scripts/verify-call-signals.ts`, find the fake `stop` action recorder (search `stop:`) and change its assertion to record the reason; add near the grace-expiry test:

```ts
// grace expiry must report why it stopped (join-trigger false-start rule reads this)
assert.deepEqual(stopReasons.at(-1), 'grace_expired')
```
and after a `call_ended` ingest test: `assert.deepEqual(stopReasons.at(-1), 'call_ended')`. (`const stopReasons: string[] = []`; the fake `stop: (reason) => { stopReasons.push(reason) }`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm run verify:call-signals`
Expected: TS/esbuild complaint that `stop` takes no argument, or assertion `undefined !== 'grace_expired'`.

- [ ] **Step 3: Implement** — in `call-signals-core.ts`:

```ts
export type CallSignalStopReason = 'grace_expired' | 'call_ended'

export interface CallSignalActions {
  pause(): void
  resume(): void
  /** -> sendAutoStopRequest({ reason }). `reason` lets the join-trigger
   *  false-start rule (J4) tell a grace-expiry stop from a call-ended stop. */
  stop(reason: CallSignalStopReason): void
  ...
```
Update the machine: the grace-timer expiry path calls `actions.stop('grace_expired')`; the `call_ended` transition calls `actions.stop('call_ended')`. Both sites are inside `createCallSignalMachine` — search for `.stop()`.

- [ ] **Step 4: Run both harnesses + typecheck**

Run: `npm run verify:call-signals && npm run typecheck`
Expected: pass. (`index.ts` `stop: () => sendAutoStopRequest()` still typechecks — a zero-arg function is assignable; Task 7 wires the reason through.)

- [ ] **Step 5: Commit**

```bash
git add src/main/call-signals-core.ts scripts/verify-call-signals.ts
git commit -m "feat(call-signals): stop(reason) — grace_expired vs call_ended"
```

---

### Task 5: `recording-state` — `trigger`, `startedAtUtc`, `forgetCompleted`

**Files:**
- Modify: `src/main/recording-state.ts`
- Test: `scripts/verify-recording-controls.ts` (existing harness — check `package.json` `verify:recording-controls`; add assertions there)

- [ ] **Step 1: Failing test** — in the recording-controls harness add:

```ts
{
  const sm = createRecordingStateMachine()
  sm.startAutoRecording({ eventId: 'e', idempotencyKey: 'k', startTimeUtc: 'x', endTimeUtc: 'y', source: 'auto', trigger: 'join' })
  sm.stopRecording(); sm.completeProcessing()
  assert.equal(sm.canStartAutoRecording('k'), false, 'completed key blocks')
  sm.forgetCompleted('k')
  assert.equal(sm.canStartAutoRecording('k'), true, 'forgetCompleted re-arms')
}
```

- [ ] **Step 2: Run to verify it fails** — `npm run verify:recording-controls` → `forgetCompleted is not a function` (or TS error on `trigger`).

- [ ] **Step 3: Implement**

```ts
export interface ActiveRecording {
  eventId: string
  idempotencyKey: string
  startTimeUtc: string
  endTimeUtc: string
  source: 'auto' | 'manual'
  /** What started it (join-trigger spec): join signal, the prompt, or the
   *  legacy calendar timer. Absent for manual. */
  trigger?: 'join' | 'prompt' | 'calendar'
  /** Set when the renderer acks the start; feeds the false-start rule. */
  startedAtUtc?: string
  metadata?: unknown
}

export interface RecordingStateMachine {
  ...
  /** Drop a completed key so the meeting can auto-record again (a discarded
   *  false start, J4). No-op if the key is unknown. */
  forgetCompleted(idempotencyKey: string): void
}
```
and in `createRecordingStateMachine`: `forgetCompleted(key) { completedKeys.delete(key) }`.

- [ ] **Step 4: Run + typecheck + commit**

```bash
npm run verify:recording-controls && npm run typecheck && git diff --check
git add src/main/recording-state.ts scripts/verify-recording-controls.ts
git commit -m "feat(recording-state): trigger, startedAtUtc, forgetCompleted"
```

---

### Task 6: Backend — `DELETE /meetings/{meeting_id}` (owner-only, pre-audio)

A discarded false start must not leave an empty Draft: the renderer created the backend meeting before capture. This is the only backend change.

**Files:**
- Modify: `backend/app/routers/meetings.py`
- Create: `backend/tests/test_meeting_delete.py`

- [ ] **Step 1: Failing tests** — `backend/tests/test_meeting_delete.py`:

```python
"""Owner may delete a meeting that never received audio (join-trigger J4:
a discarded false start must not leave an empty Draft behind)."""

import unittest
from uuid import uuid4

from fastapi import HTTPException

from app import store
from app.routers import meetings as meetings_router
from app.schemas import MeetingSource, PipelineStatus


class MeetingDeleteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        created = await meetings_router.create_meeting(
            meetings_router.MeetingCreate(title="False start", source=MeetingSource.online),
            actor="joseph@factor1.com.au",
        )
        self.meeting_id = created.id

    async def test_owner_deletes_untouched_meeting(self):
        await meetings_router.delete_meeting(self.meeting_id, actor="joseph@factor1.com.au")
        self.assertNotIn(self.meeting_id, store.MEETINGS)
        audit = [a for a in store.AUDIT_LOG if a.action == "meeting.delete"]
        self.assertTrue(audit, "delete must be audited")

    async def test_non_owner_is_forbidden(self):
        with self.assertRaises(HTTPException) as ctx:
            await meetings_router.delete_meeting(self.meeting_id, actor="someone@factor1.com.au")
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn(self.meeting_id, store.MEETINGS)

    async def test_meeting_with_audio_or_pipeline_is_refused(self):
        m = store.MEETINGS[self.meeting_id]
        store.MEETINGS[self.meeting_id] = m.model_copy(update={"pipeline_status": PipelineStatus.queued})
        with self.assertRaises(HTTPException) as ctx:
            await meetings_router.delete_meeting(self.meeting_id, actor="joseph@factor1.com.au")
        self.assertEqual(ctx.exception.status_code, 409)

    async def test_unknown_meeting_is_404(self):
        with self.assertRaises(HTTPException) as ctx:
            await meetings_router.delete_meeting(uuid4(), actor="joseph@factor1.com.au")
        self.assertEqual(ctx.exception.status_code, 404)
```

Adjust the setup to the real create helper: open `backend/app/routers/meetings.py` and reuse whatever `create_meeting`'s request model is called (search `@router.post("", ` near line 100) and how other tests create meetings (`backend/tests/test_delivery_reliability.py` `setUp` is a good template — copy its meeting-creation lines instead of guessing).

- [ ] **Step 2: Run to verify it fails**

Run: `PYTHONPATH=backend backend/.venv/Scripts/python.exe -m pytest backend/tests/test_meeting_delete.py -q`
Expected: `AttributeError: module 'app.routers.meetings' has no attribute 'delete_meeting'`.

- [ ] **Step 3: Implement** — in `backend/app/routers/meetings.py`, after the `POST ""` create route:

```python
@router.delete("/{meeting_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_meeting(meeting_id: UUID, actor: str = Actor) -> Response:
    """Delete a meeting that never received audio.

    Exists for the desktop's join-trigger false-start rule (spec J4): the
    renderer creates the meeting before capture starts, so a discarded
    recording would otherwise leave an empty Draft. Owner-only, and refused
    (409) once anything has been uploaded or processed — this is a tidy-up,
    not a data-deletion feature.
    """
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")
    require(meeting_id, actor, AccessRole.owner)
    # `pending_audio` is the created-but-nothing-uploaded state; anything else
    # means audio landed (queued/processing/ready/failed) and this tidy-up
    # must refuse. audio_path_for() is the on-disk marker for the same thing.
    if meeting.pipeline_status is not PipelineStatus.pending_audio or audio_path_for(meeting_id, "audio/webm").exists():
        raise HTTPException(status.HTTP_409_CONFLICT, "Meeting already has audio or processing; cannot delete")
    before = meeting.model_dump_json()
    del store.MEETINGS[meeting_id]
    store.add_audit(actor, "meeting.delete", str(meeting_id), before=before, after=None, meeting_id=meeting_id)
    store.save_snapshot()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
```

`PipelineStatus.pending_audio` and `audio_path_for` (already imported at the top of the router) are verified against the codebase; `store.add_audit(actor, action, target, before=None, after=None, meeting_id=None)` takes JSON strings for before/after. Import `Response` from `fastapi` if not already.

- [ ] **Step 4: Run the new tests, then the full suite**

Run: `PYTHONPATH=backend backend/.venv/Scripts/python.exe -m pytest backend/tests/test_meeting_delete.py -q` → 4 passed
Run: `PYTHONPATH=backend backend/.venv/Scripts/python.exe -m pytest backend/tests -q` → all passed (was 407)

- [ ] **Step 5: Renderer API** — `src/renderer/src/lib/api.ts`, next to `createMeeting`:

```ts
/** Owner-only tidy-up of a meeting that never received audio (join-trigger
 *  false start). 204 on success; null on any error — callers must not block on it. */
export async function deleteMeeting(meetingId: string): Promise<boolean> {
  const res = await call<null>('DELETE', `/meetings/${meetingId}`)
  return res !== null
}
```
Check how `call<T>` treats 204 (search `status === 204` in `api.ts`); if it returns `null` on 204, return `true` when the request did not throw instead.

- [ ] **Step 6: Commit**

```bash
git add backend/app/routers/meetings.py backend/tests/test_meeting_delete.py src/renderer/src/lib/api.ts
git commit -m "feat(backend): owner-only DELETE /meetings/{id} for untouched meetings"
```

---

### Task 7: `recording-ipc` — reason on auto-stop, false-start decision, `deliver`, re-arm hook

**Files:**
- Modify: `src/main/recording-ipc.ts:199-223` (`sendAutoStopRequest`), `:232-252` (`handleRendererRecordingStarted`), `:277-296` (`handleRendererRecordingStopped`), the scheduled-end auto-stop call at `:380`
- Modify: `src/preload/index.ts:35-38`
- Modify: `src/main/index.ts:132` (`stop:` action)

- [ ] **Step 1: Types** — `src/preload/index.ts`:

```ts
export interface AutoStopRequest {
  eventId: string
  idempotencyKey: string
  /** false = discard (join-trigger false start, spec J4): stop capture,
   *  drop the spill, delete the empty backend meeting, no upload. */
  deliver: boolean
}
```

- [ ] **Step 2: `recording-ipc.ts`** — add imports and a hook:

```ts
import { decideFalseStart, type AutoStopReason } from './join-watch-core'

/** Join-watch hook: called after a false start was discarded so the meeting
 *  can re-arm. Set by index.ts; null when the join trigger is off. */
let onRecordingDiscarded: ((idempotencyKey: string) => void) | null = null
export function configureRecordingDiscardHook(hook: ((key: string) => void) | null): void {
  onRecordingDiscarded = hook
}
/** Key of the recording we asked the renderer to discard; consumed on stop. */
let pendingDiscardKey: string | null = null
```

Change `sendAutoStopRequest`:

```ts
export function sendAutoStopRequest(opts: { reason: AutoStopReason } = { reason: 'scheduled_end' }): void {
  ...
  const decision = decideFalseStart({
    trigger: active.trigger,
    stopReason: opts.reason,
    scheduledStartUtc: active.startTimeUtc,
    startedAtUtc: active.startedAtUtc,
    nowUtc: new Date().toISOString()
  })
  const deliver = decision === 'deliver'
  if (!deliver) pendingDiscardKey = active.idempotencyKey
  logger().info('[recording] sending auto-stop to renderer', {
    eventId: active.eventId, idempotencyKey: active.idempotencyKey, reason: opts.reason, deliver
  })
  mainWindow.webContents.send('recording:auto-stop-request', {
    eventId: active.eventId, idempotencyKey: active.idempotencyKey, deliver
  })
}
```
The scheduled-end timer call at line ~380 becomes `sendAutoStopRequest({ reason: 'scheduled_end' })`.

In `handleRendererRecordingStarted`, when promoting `pendingAutoStart` to active, set `startedAtUtc: new Date().toISOString()` on the recording passed to `sm.startAutoRecording`.

In `handleRendererRecordingStopped`, after `const finished = sm.stopRecording()`:

```ts
  if (finished && pendingDiscardKey === finished.idempotencyKey) {
    pendingDiscardKey = null
    sm.forgetCompleted(finished.idempotencyKey)
    logger().info('[recording] false start discarded; meeting re-armed', { idempotencyKey: finished.idempotencyKey })
    try { onRecordingDiscarded?.(finished.idempotencyKey) } catch { /* hook is best-effort */ }
  } else {
    pendingDiscardKey = null
  }
```
Also clear `pendingDiscardKey = null` in `handleRendererRecordingError`.

- [ ] **Step 3: `index.ts`** — the call-signals action: `stop: (reason) => sendAutoStopRequest({ reason })`.

- [ ] **Step 4: Typecheck + existing harnesses**

Run: `npm run typecheck && npm run verify:call-signals && npm run verify:recording-controls`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/main/recording-ipc.ts src/preload/index.ts src/main/index.ts
git commit -m "feat(recording): auto-stop carries reason + deliver; discard re-arms the meeting"
```

---

### Task 8: Renderer — honour `deliver: false`

**Files:**
- Modify: `src/renderer/src/App.tsx:458-635` (auto-start handler / `finishActiveRecording` / `controls`)

- [ ] **Step 1: Thread the flag** — `finishActiveRecording` gains a parameter and the auto-stop subscription passes it:

```ts
const finishActiveRecording = async (opts: { deliver: boolean } = { deliver: true }): Promise<void> => {
```
and
```ts
const unsubStop = window.api.onAutoStopRequest((data) => void stopFlight.invoke({ deliver: data.deliver !== false }))
```
`createSingleFlight` (`src/renderer/src/lib/singleFlight.ts`) takes a zero-arg `run` — do not change it. Hold the option in a ref: `const stopOptsRef = useRef({ deliver: true })`; the subscription sets `stopOptsRef.current = { deliver: data.deliver !== false }` then calls `stopFlight.invoke()`; `finishActiveRecording` reads `stopOptsRef.current` and resets it to `{ deliver: true }` on entry. Tray/manual stops leave the ref at its default, so they always deliver.

- [ ] **Step 2: Discard branch** — inside `finishActiveRecording`, right after `const result = await capture.stop(...)` and the debug log, before the local-save block:

```ts
        if (!opts.deliver) {
          // Join-trigger false start (spec J4): the recording ended before the
          // meeting was really under way. Nothing is kept — no local save, no
          // upload, no email — and the empty backend meeting is removed so it
          // never shows as a Draft. Main has already re-armed the meeting.
          window.api.debugLog('recording discarded as false start', { meetingId, durationSeconds })
          capture.discardCompletedSpill()
          if (meetingId) await deleteMeeting(meetingId)
          recordingRef.current = null
          setRecording(null)
          autoGraphMetadataRef.current = null
          setCaptureStatus(null)
          setAutoRecordingState('idle')
          window.api.notifyRecordingStopped()
          return
        }
```
Import `deleteMeeting` from `./lib/api`.

- [ ] **Step 3: Typecheck (web) and build**

Run: `npm run typecheck && npm run build`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat(renderer): discard path for auto-stop deliver:false"
```

---

### Task 9: Toast — join prompt + `record-now` action

**Files:**
- Modify: `src/main/toast-xml.ts`
- Modify: `scripts/verify-toast-xml.ts` (existing harness — `npm run verify:toast-xml`)

- [ ] **Step 1: Failing test** — in the toast harness:

```ts
{
  const xml = buildJoinPromptToastXml('Weekly 1:1 with Kristel')
  assert.match(xml, /Meeting Weekly 1:1 with Kristel has started/)
  assert.match(xml, /Recording will begin when you join/)
  assert.match(xml, /arguments="notetaker:\/\/record-now"/)
  assert.match(xml, /scenario="reminder"/, 'sticky so our own 60 s close() governs lifetime')
  assert.equal(toastActionFromArgv(['notetaker://record-now']), 'record-now')
}
```

- [ ] **Step 2: Run to fail** — `npm run verify:toast-xml` → export missing.

- [ ] **Step 3: Implement** — add `'record-now'` to `ToastAction`; in `toastActionFromArgv` add `if (arg === toastUri('record-now')) return 'record-now'`; add:

```ts
/**
 * Join-trigger prompt (spec J3): shown once at start + 2 min when the
 * meeting is armed and nothing is recording. `scenario="reminder"` keeps it
 * on screen; the runtime closes it after JOIN_WATCH_PROMPT_LIFETIME_MS.
 */
export function buildJoinPromptToastXml(title: string): string {
  return (
    `<toast scenario="reminder" activationType="protocol" launch="${toastUri('open')}">` +
    '<visual><binding template="ToastGeneric">' +
    `<text>Meeting ${xmlEscape(title)} has started</text>` +
    '<text>Recording will begin when you join.</text>' +
    '</binding></visual>' +
    '<audio silent="true"/>' +
    '<actions>' +
    `<action content="Record now" activationType="protocol" arguments="${toastUri('record-now')}"/>` +
    '</actions>' +
    '</toast>'
  )
}
```

- [ ] **Step 4: Run + commit**

```bash
npm run verify:toast-xml && npm run typecheck
git add src/main/toast-xml.ts scripts/verify-toast-xml.ts
git commit -m "feat(toast): join prompt toast + record-now action"
```

---

### Task 10: `backend-supervisor` — expose env layers

**Files:**
- Modify: `src/main/backend-supervisor.ts:429-470` (`loadCredentials`)

- [ ] **Step 1: Implement** — keep the last loaded layers in a module variable and export a getter:

```ts
let lastLoadedLayers: Record<string, string> = {}
/** The merged two-layer backend.env (bundled, then %PROGRAMDATA%; PROGRAMDATA
 *  wins) as last loaded for the backend child. Main-process settings that
 *  must survive auto-update read from here (join-trigger spec J6). Empty in
 *  dev, where no supervisor runs. */
export function getBackendEnvLayers(): Record<string, string> {
  return { ...lastLoadedLayers }
}
```
and at the end of `loadCredentials`, before `return result`: `lastLoadedLayers = { ...result }`.

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/main/backend-supervisor.ts
git commit -m "feat(supervisor): expose merged backend.env layers to main"
```

---

### Task 11: `join-watch.ts` runtime + `index.ts` wiring

**Files:**
- Create: `src/main/join-watch.ts`
- Modify: `src/main/index.ts` (imports; `handleAutoRecordEligible`; runtime wiring after registrar; `record-now` toast handler; discard hook)

- [ ] **Step 1: Runtime module** — `src/main/join-watch.ts`:

```ts
/**
 * Join-triggered recording — runtime half. Supplies the real transport
 * (the same relay client the registrar and attach poller use), electron-log,
 * the prompt toast, and persistence of "prompted" keys, then hands the pure
 * engine to index.ts. Everything user-facing or network-facing lives here;
 * `join-watch-core.ts` stays harness-testable.
 */
import { app, Notification } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCallWatchTransport, joinUrlHash, parseCallSignals, isCallSignalsPayload } from './call-signals'
import { evaluateHostOwnership } from './graph/host-gate'
import {
  JOIN_WATCH_PROMPT_LIFETIME_MS,
  createJoinWatchEngine,
  type JoinWatchEngine,
  type JoinWatchMeeting
} from './join-watch-core'
import { logger } from './logger'
import { getRecordingStateMachine, hasPendingAutoStart, sendAutoStartRequest } from './recording-ipc'
import { buildJoinPromptToastXml } from './toast-xml'

export * from './join-watch-core'

let engine: JoinWatchEngine | null = null
let promptToast: Notification | null = null
let promptToastTimer: NodeJS.Timeout | null = null
let promptedMeeting: JoinWatchMeeting | null = null

function promptedKeysStore(path: string): { has: (k: string) => boolean; add: (k: string) => void } {
  let keys = new Set<string>()
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { prompted?: string[] }
      keys = new Set(Array.isArray(raw.prompted) ? raw.prompted : [])
    }
  } catch { keys = new Set() }
  const persist = (): void => {
    try {
      // Cap the file: keep the most recent 200 keys.
      const list = [...keys].slice(-200)
      keys = new Set(list)
      writeFileSync(path, JSON.stringify({ prompted: list }), 'utf8')
    } catch (err) {
      logger().warn('[join-watch] failed to persist prompted keys', { message: err instanceof Error ? err.message : String(err) })
    }
  }
  return { has: (k) => keys.has(k), add: (k) => { keys.add(k); persist() } }
}

function closePrompt(): void {
  if (promptToastTimer) { clearTimeout(promptToastTimer); promptToastTimer = null }
  try { promptToast?.close() } catch { /* already gone */ }
  promptToast = null
}

function showPrompt(meeting: JoinWatchMeeting): void {
  closePrompt()
  promptedMeeting = meeting
  try {
    promptToast = new Notification({ toastXml: buildJoinPromptToastXml(meeting.title) })
    promptToast.show()
  } catch (err) {
    logger().warn('[join-watch] prompt toast failed', { message: err instanceof Error ? err.message : String(err) })
    promptToast = null
    return
  }
  promptToastTimer = setTimeout(closePrompt, JOIN_WATCH_PROMPT_LIFETIME_MS)
}

/** Build the engine and start listening. Call once, after the registrar exists. */
export function configureJoinWatch(opts: { hasActiveWatch: (hash: string) => boolean }): void {
  disposeJoinWatch()
  const transport = createCallWatchTransport()
  const store = promptedKeysStore(join(app.getPath('userData'), 'join-watch.json'))
  engine = createJoinWatchEngine({
    hasActiveWatch: opts.hasActiveWatch,
    joinUrlHash,
    fetchSignals: async (hash) => {
      const t = transport ?? createCallWatchTransport()
      if (!t) return null
      try {
        const res = await t.http(`${t.apiBase}/api/v1/call-watch/${hash}/signals`, {
          method: 'GET',
          headers: await t.identityHeaders()
        })
        if (!res.ok) return null
        const payload = await res.json()
        return isCallSignalsPayload(payload) ? parseCallSignals(payload) : null
      } catch {
        return null
      }
    },
    isRecordingActive: () => getRecordingStateMachine().getState() !== 'idle' || hasPendingAutoStart(),
    startRecording: (m, trigger) => {
      closePrompt()
      sendAutoStartRequest({
        eventId: m.eventId,
        idempotencyKey: m.idempotencyKey,
        startTimeUtc: m.startUtc,
        endTimeUtc: m.endUtc,
        source: 'auto',
        trigger,
        metadata: m.metadata
      })
    },
    showPrompt,
    onDisarm: (m) => { if (promptedMeeting?.idempotencyKey === m.idempotencyKey) closePrompt() },
    promptedKeys: store,
    timers: { setTimeout, clearTimeout },
    now: () => Date.now(),
    log: (level, message, context) => (level === 'warn' ? logger().warn(message, context ?? {}) : logger().info(message, context ?? {})),
    isHostOwned: (d, email) => evaluateHostOwnership(d, email).allowed
  })
  logger().info('[join-watch] configured')
}

export function handleJoinWatchSyncDecisions(decisions: Parameters<JoinWatchEngine['handleSyncDecisions']>[0], signedInEmail?: string): void {
  engine?.handleSyncDecisions(decisions, signedInEmail)
}
export function joinWatchPromptAccepted(): void {
  const m = promptedMeeting
  closePrompt()
  if (m) engine?.acceptPrompt(m.idempotencyKey)
}
export function joinWatchRecordingDiscarded(key: string): void { engine?.rearm(key) }
export function joinWatchRecordingStarted(key: string): void { engine?.noteRecordingStarted(key) }
export function disposeJoinWatch(): void { closePrompt(); engine?.dispose(); engine = null }
```

Confirm `isCallSignalsPayload` and `parseCallSignals` are exported by `call-signals.ts` (it re-exports the core — they are). Confirm `evaluateHostOwnership` returns `{ allowed }` (it returns `HostGateResult`).

- [ ] **Step 2: `index.ts` wiring**

Imports:
```ts
import { getBackendEnvLayers } from './backend-supervisor'
import { configureRecordingDiscardHook } from './recording-ipc'
import {
  configureJoinWatch, disposeJoinWatch, handleJoinWatchSyncDecisions,
  joinWatchPromptAccepted, joinWatchRecordingDiscarded, joinWatchRecordingStarted, readAutoStartTrigger
} from './join-watch'
```

Trigger mode, computed once after `await backendStartup` (layers are loaded by then):
```ts
  const autoStartTrigger = readAutoStartTrigger(getBackendEnvLayers(), process.env)
  logger().info('[app] auto-start trigger', { mode: autoStartTrigger })
```

`handleAutoRecordEligible`: at the top of the per-decision loop, before `sendAutoStartRequest`, guard:
```ts
      if (autoStartTrigger === 'join') {
        // Join-trigger mode (spec J1): the calendar only schedules. The join
        // watcher — fed by onSyncCompleted below — arms at start−3 and starts
        // on the recorder's roster IN. Nothing to do here.
        continue
      }
```
(Keep the IN-469 `nextAutoRecordStartUtcMs` bookkeeping above the loop untouched — it still drives the updater's "no update near a meeting" logic.) Under `calendar` mode, tag the request `trigger: 'calendar'`.

After the registrar block (`callWatchRegistrar = registrar` … the `startGraphDetectionRuntime` options), extend `onSyncCompleted`:
```ts
    onSyncCompleted: async (decisions) => {
      await registrar.handleSyncDecisions(decisions, getCurrentUserEmail())
      if (autoStartTrigger === 'join') handleJoinWatchSyncDecisions(decisions, getCurrentUserEmail())
    },
```
and, before the runtime starts:
```ts
  if (autoStartTrigger === 'join') {
    configureJoinWatch({ hasActiveWatch: (hash) => registrar.hasActiveWatch(hash) })
    configureRecordingDiscardHook(joinWatchRecordingDiscarded)
  }
```
Where the renderer acks a start (`handleRendererRecordingStarted` is in recording-ipc; call from there is cleaner — add in recording-ipc a second hook `onRecordingStartedHook(key)` mirroring the discard hook, and wire it in index.ts to `joinWatchRecordingStarted`). This lets a *manual* recording of the same meeting stop the join watcher polling.

Toast handler in the second-instance/argv branch (near `toastAction === 'upload-now'`):
```ts
  if (toastAction === 'record-now') {
    logger().info('[app] record-now requested from join prompt')
    joinWatchPromptAccepted()
    return
  }
```
On quit (near `registrar` flush): `disposeJoinWatch()`.

- [ ] **Step 3: Typecheck + all harnesses**

Run: `npm run typecheck && npm run verify:join-watch && npm run verify:call-signals && npm run verify:call-watch-registrar && npm run verify:toast-xml && npm run verify:recording-controls`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/main/join-watch.ts src/main/index.ts src/main/recording-ipc.ts
git commit -m "feat: wire join-triggered recording (MN_AUTO_START_TRIGGER=join default)"
```

---

### Task 12: 5 s attach poll while a meeting is live

**Files:**
- Modify: `src/main/call-signals.ts:187-236` (`armCallSignals`)

- [ ] **Step 1: Implement** — `armCallSignals` already builds the poller with deps; add `pollIntervalMs` from an optional runtime dep, defaulting to `JOIN_WATCH_POLL_INTERVAL_MS` when the join trigger is on. Simplest: `CallSignalRuntimeDeps.pollIntervalMs?: number`, passed through to `createCallSignalPoller({ ..., pollIntervalMs: deps.pollIntervalMs })`; in `index.ts` `configureCallSignals({ actions, pollIntervalMs: 5_000 })`. Log line already prints `pollIntervalMs` — make it print the effective value.

- [ ] **Step 2: Harness** — `verify:call-signals` has a poll-cadence assertion using `CALL_SIGNAL_POLL_INTERVAL_MS`; it passes an explicit `pollIntervalMs` in its deps already (check) — if not, no change needed.

- [ ] **Step 3: Typecheck, harness, commit**

```bash
npm run typecheck && npm run verify:call-signals
git add src/main/call-signals.ts src/main/index.ts
git commit -m "feat(call-signals): 5 s attach poll while a meeting is live"
```

---

### Task 13: CI gate, release passthrough, env template, runbook

**Files:**
- Modify: `.github/workflows/ci.yml:20-26`, `.github/workflows/release.yml` (credentials step), `backend.env.template`, `docs/rollout-runbook.md`

- [ ] **Step 1: CI** — add `npm run verify:join-watch` to the fixtures block in `ci.yml`.

- [ ] **Step 2: release.yml** — next to `MN_DELIVERY_RECIPIENTS`, add `MN_AUTO_START_TRIGGER: ${{ vars.MN_AUTO_START_TRIGGER }}` to the step env and:
```powershell
          if ($env:MN_AUTO_START_TRIGGER) {
            $lines += "MN_AUTO_START_TRIGGER=$env:MN_AUTO_START_TRIGGER"
            Write-Host "Auto-start trigger: $env:MN_AUTO_START_TRIGGER"
          } else {
            Write-Host "Auto-start trigger: join (code default)"
          }
```

- [ ] **Step 3: `backend.env.template`** — after the `MN_DELIVERY_RECIPIENTS` block:
```
# Auto-record trigger (18 Aug 2026 join-trigger spec): "join" (default) starts
# a scheduled Teams meeting's recording only when you are in its Teams call
# (prompt at start+2 min if not); "calendar" restores the old start-time
# trigger. Read by the desktop app from this file, so a %PROGRAMDATA%
# override survives auto-update.
# MN_AUTO_START_TRIGGER=join
```

- [ ] **Step 4: Runbook** — `docs/rollout-runbook.md`, new section "Auto-record trigger": what changed, the prompt, the false-start rule in one line each, the kill switch (`MN_AUTO_START_TRIGGER=calendar` in `%PROGRAMDATA%\Factor1\MeetingNotetaker\backend.env`, restart app), and the F1 caveat wording for comms: *"joining from your phone with your laptop open elsewhere still records the laptop"*.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml backend.env.template docs/rollout-runbook.md
git commit -m "chore: join-trigger CI gate, release passthrough, env template, runbook"
```

---

### Task 14: Live verification (Joseph, single account) — no code

Build: freeze backend (unchanged code but do it for a clean bundle), `npm run build`, `npm run package:dir`, quit the installed app (holds 8787), run `dist\win-unpacked\Meeting Notetaker.exe` with an isolated userData (as Codex did on 18 Aug). Watch signals with `tmp/watch-signals.cjs`.

| # | Steps | Expect | Evidence |
|---|---|---|---|
| L1 | Schedule a Teams meeting (you organiser) 5 min out; join at −1 | recording within ~8 s of join; leave → pause/grace/stop as today | main.log `[join-watch] starting recording trigger=join`; ACL/emails as usual |
| L2 | Join at −20, stay | starts at −3 | log `armed` at −3 then `starting recording` within a poll |
| L3 | Join at −20, leave at −10, don't return | prompt at +2, nothing recorded | toast; log `prompting`; no meeting created |
| L4 | Join at −2 (recording starts), leave at −1, don't return; rejoin at +5 | first discarded (no email, no Draft), fresh recording at +5 | log `false start discarded; meeting re-armed`; backend has ONE meeting |
| L5 | Create meeting 2 min before start (watch blind) | prompt at +2; Record now works | log `no active watch: prompt-only`; toast; recording starts on click |
| L6 | `MN_AUTO_START_TRIGGER=calendar` in `%PROGRAMDATA%` file, restart | old behaviour (starts at −3 without join) | log `auto-start trigger mode=calendar` |
| L7 | Manual recording running across a scheduled start | no auto-start, no prompt | log `prompt suppressed: recording active` |

Record results in `docs/jira-progress.md` under a new IN- ticket (create it: "Join-triggered auto-record").

- [ ] All seven pass → open PR `feature/join-triggered-recording` → `main`; release as v2.0.31 after the SharePoint hardening (v2.0.30) per the spec's J6.

---

## Notes for the implementer

- **Never** write to a spec'd file with Python text mode on Windows without `newline=''` — it CRLFs the whole file (see git history for the 18 Aug lesson).
- The engine's poll is `async`; in the harness always `await settle()` after `advance()` before asserting.
- `sendAutoStartRequest` already refuses when the state machine says no (`canStartAutoRecording`) or a start is pending — the engine's `isRecordingActive` is a *pre*-check for logging and prompt suppression, not the guard.
- If `createSingleFlight` (renderer) doesn't take arguments, don't refactor it — hold the `{ deliver }` in a ref set immediately before `invoke()`.
- The registrar's `hasActiveWatch(hash)` is truthful from process start (state is read synchronously); the join watcher may be configured right after the registrar.
- Do not touch storage-api. Do not touch the stop machine's transitions.
