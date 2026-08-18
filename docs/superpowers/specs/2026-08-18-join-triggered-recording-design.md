# Join-Triggered Recording — Design

**Date:** 18 August 2026
**Jira:** to be created (follow-on to IN-66 auto-start/stop and the
meeting-call-events / call-watch-per-meeting work; relates to IN-67)
**Status:** Design approved in conversation with Joseph (18 Aug); not yet
implemented. Ships as its own release after the SharePoint permission
hardening (v2.0.30) — never bundled with it.
**Amends:** `2026-08-14-call-watch-per-meeting-design.md` and
`2026-08-12-meeting-call-events-design.md` — the call-signal machinery those
specs built for *stopping* a recording now also decides when one *starts*.
The stop-side state machine (D5–D9) is unchanged.

## Why

On 18 Aug 2026 David A relayed a live incident: a user's Notetaker
auto-recorded a scheduled Teams meeting (Meeting A) at its calendar start
time while the user was still in an unrelated **in-person** conversation
with a different client. That conversation was transcribed and emailed to
Meeting A's invitees. One recipient took it badly; Karen and David F are
managing the fallout.

The root cause is the trigger, not the delivery. Today a host-owned Teams
meeting auto-records at `start − 3 min` because the **calendar** says so
(`filter.ts` → `dueForAutoStart` → `handleAutoRecordEligible` →
`sendAutoStartRequest`). Nothing checks whether the user is actually in the
call. The app therefore fails *open*: it records unless something stops it.

The stop side already has the right signal. Since v2.0.28 the desktop
pre-registers a Graph `meetingCallEvents` watch per host-owned meeting at
calendar discovery (E1), and storage-api reduces the recorder's own roster
deltas to `recorder_left` / `recorder_rejoined` / `call_ended`, which the
desktop polls every 10 s and feeds a pause → 60 s grace → auto-stop machine
(field-verified 14 Aug, `notetaker-call-events-midcall-root-cause`).
`recorder_rejoined` fires for **any** roster IN of the recorder, including
the first join — so "the user is now in this call" is already on the wire.

Organiser-only delivery (v2.0.29, `MN_DELIVERY_RECIPIENTS`) limits the blast
radius of a wrong recording; it does not stop the wrong recording. This
design does.

## Requirement

A host-owned Teams meeting is auto-recorded only when the signed-in user is
actually **in that meeting's Teams call**, and never merely because the
calendar says the meeting has begun. When the app cannot see a join it must
fail closed — no silent recording — and offer the user a one-click way to
record if they are in the meeting some other way. The existing stop
behaviour (leave → pause → grace → stop; call end → stop; scheduled end
backstop) is unchanged.

## Non-goals

- Detecting which *device* the user joined from (see follow-up F1).
- Auto-starting when the roster watch is blind (see follow-up F2 —
  presence). Blind cases get the prompt.
- Any change to storage-api, the backend, delivery, or the stop machine.
- Meetings that are not host-owned Teams meetings with a join URL —
  `requireOnlineMeeting: true` and the host gate stand.

## Vocabulary

- **Watch** — the per-meeting Graph subscription + signal store keyed by
  `sha256(joinWebUrl)` (E2). Registered at discovery for the 5 soonest
  host-owned meetings (E3).
- **Recorder** — the signed-in user (the watch owner's oid).
- **Recorder-in-call** — *derived* state: for a watch's full signal history,
  the most recent recorder signal is `recorder_rejoined` and no `call_ended`
  follows it. It is a position, not an event; an early joiner who is still
  in the call is recorder-in-call with no fresh signal at all.
- **Arm window** — `[start − 3 min, end + 10 min]` for a meeting.
- **Trigger** — what caused a recording to start: `join`, `prompt`, or
  `calendar` (legacy mode). Recorded on the active recording for logs and the
  false-start rule; not shown to users.

## Design decisions

### J1 — The calendar schedules; the roster signal triggers

`handleAutoRecordEligible` no longer starts a recording. When a meeting
becomes eligible on the existing time basis (`start − 3 min`, host gate
passed, not already recorded) it **arms** the join watcher for that meeting.
Arming is timer-driven: the join watcher receives every sync's decisions
(the same unfiltered feed the registrar consumes), tracks host-owned
candidates with their `startUtc`/`endUtc`, and arms each at exactly
`start − 3 min` by its own timer rather than waiting for the 5-min poll grid
to flip `autoRecordEligible`.
Recording starts when the meeting is armed **and** recorder-in-call is true.
That is immediate for an early joiner who is still present at −3 min, and
on the next `recorder_rejoined` for anyone who joins later — 5 min or 40 min
after start makes no difference.

Start is the same `sendAutoStartRequest` the calendar issues today (source
`auto`), tagged `trigger: 'join'`. The renderer, capture, upload, delivery,
attach poller, and stop machine are unchanged.

### J2 — Lifecycle per meeting

```
discovered ──(start − 3 min, host gate)──▶ armed ──(recorder-in-call)──▶ recording ──▶ existing stop machine
                                             │
                                             ├──(start + 2 min, nothing recording)──▶ prompted (once)
                                             │
                                             └──(call_ended before any start | end + 10 min | cancelled)──▶ disarmed
```

- Arming is silent: no capture, nothing user-visible.
- `call_ended` **at or after scheduled start** with no later recorder IN
  disarms — the meeting is over. A `call_ended` *before* scheduled start
  (Teams ending a pre-meeting camera check) only means "not in call": the
  meeting stays armed and the real call's `recorder_rejoined` starts it.
- A meeting with **no active watch** (beyond the 5-cap, created too late,
  relay unavailable) still arms, but can only start via the prompt (J3).
- Once a recording starts for the meeting, the join watcher steps aside;
  the existing attach poller and pause/grace/stop machine own the rest.
- The "already recording something" guard applies at start: a join signal
  never interrupts an active recording (manual or auto). Two overlapping
  armed meetings each carry their own watch; a join starts *that* meeting;
  the other's prompt is suppressed while anything is recording.
- Derived state, not drained events: unlike the attach poller's baseline
  drain (E5), the join watcher reads a watch's full history and computes the
  current position. Missing or unreadable history means *unknown*, and
  unknown is not in-call.

### J3 — The prompt (fail-closed with a human override)

At `start + 2 min`, if the meeting is armed and **nothing** is recording, one
Windows toast:

> **Meeting X has started**
> Recording will begin when you join. — **[Record now]**

- Auto-dismisses after 60 s. Fires **once per meeting**, including across an
  app restart (the join watcher persists only "prompted for meeting X").
- **Record now** → `sendAutoStartRequest`, `trigger: 'prompt'`. A join signal
  arriving afterwards changes nothing — recording is already active.
- Dismissed or ignored → nothing happens; a later join still auto-starts.
- Suppressed while any recording is active, and not shown for meetings that
  left the armed state between −3 and +2 (cancelled, ended, host gate).
- Wording is deliberately plain and desktop-only.

The prompt is what covers the cases the roster cannot see: hybrid meetings
where the user is in the room and never clicks Join, watches that were
registered after the call began (blind — see the 14 Aug root cause), the
5-watch cap, and relay outages. In every one of those the app used to record
silently; now it asks.

### J4 — False-start rule (early join, then left)

Evaluated in main when the **leave-flow grace expires** for a recording with
`trigger: 'join'`:

> discard if `stopReason == recorder_left`
> **and** `now < scheduledStart + 2 min`
> **and** `recordingDuration < 5 min`

- Discard = the auto-stop request carries `deliver: false`; the renderer
  stops capture and drops the spill (existing `discardCompletedSpill`) instead
  of uploading. No email, no SharePoint, no backend meeting.
- The recording state machine then `forgetCompleted(key)`: the meeting is
  **re-armed** and a later join starts a fresh recording. Idempotency ("one
  recording per meeting") still holds for real recordings.
- The grace toast's existing **Upload now** is the human override: it always
  delivers, and the meeting is *not* re-armed.
- Everything else delivers as today: ended at or after `start + 2 min`, or
  ≥ 5 min long, or ended by `call_ended`, scheduled end, or a manual stop.
- `prompt`- and manually-triggered recordings are **never** discarded — a
  human chose those.

The threshold is anchored on *scheduled start*, not duration alone, so a
genuinely short call that ran at its scheduled time is delivered.

### J5 — Poll cadence

While any meeting is armed, the join watcher polls that watch's signals
every **5 s** (`JOIN_WATCH_POLL_INTERVAL_MS`); otherwise it is idle. Worst
case join → recording start ≈ webhook latency (1–3 s) + 5 s ≈ 8 s. The same
5 s tick carries over to the attach poller for the live meeting, so
leave-detection tightens for free. Mutating requests keep the existing 30 s
budget (`CALL_SIGNAL_MUTATION_TIMEOUT_MS`).

### J6 — Kill switch and rollout

`MN_AUTO_START_TRIGGER = join | calendar`, **code default `join`**.

- `calendar` restores today's behaviour byte-for-byte: `handleAutoRecordEligible`
  starts on time, the join watcher is never constructed.
- **Where the setting lives:** in `backend.env`, read by main through the
  supervisor's existing two-layer loader (`loadCredentials`: bundled
  `resources/backend/backend.env`, then
  `%PROGRAMDATA%\Factor1\MeetingNotetaker\backend.env`, which wins).
  Precedence: `%PROGRAMDATA%` > bundled > code default. Deliberately *not*
  `resources/.env.production` (main's other env file): `resources/` is
  replaced on every auto-update, so an override there dies at the next
  release, whereas the `%PROGRAMDATA%` layer survives updates and is the
  documented per-machine path. Fleet-wide flip = repo variable written by
  `release.yml` + release, the same pattern as `MN_DELIVERY_RECIPIENTS`. The
  supervisor already parses both layers into a dict; exposing that dict to
  main's own settings is the only plumbing.
- Ships as **v2.0.31**, after the SharePoint permission hardening (v2.0.30).
  Organiser-only delivery is independent and stays until David F lifts it.
- Release comms must state plainly: hybrid/in-room meetings with a Teams
  link now need one click on the prompt; and phone-join still records the
  desktop (F1) until the device check ships.

### J7 — Named constants

| Constant | Value |
|---|---|
| `AUTO_START_LEAD_MS` (existing) | 3 min |
| `JOIN_WATCH_PROMPT_OFFSET_MS` | 2 min after scheduled start |
| `JOIN_WATCH_PROMPT_LIFETIME_MS` | 60 s |
| `JOIN_WATCH_POLL_INTERVAL_MS` | 5 s (armed) / idle otherwise |
| `JOIN_WATCH_DISARM_AFTER_END_MS` | 10 min |
| `FALSE_START_MAX_DURATION_MS` | 5 min |
| `FALSE_START_MAX_AFTER_START_MS` | 2 min |

## Components

**New — `src/main/join-watch-core.ts`** (pure; no Electron, MSAL, log, or
network imports — same rule as `call-signals-core.ts`, enforced by the verify
harness). Owns J2's lifecycle, the recorder-in-call derivation, the prompt
timer, and the false-start decision. Effects (timers, HTTP, toast, start
request, logging, persistence of "prompted") arrive by injection.

**New — `src/main/join-watch.ts`** — runtime layer: real fetch through the
existing relay client, electron-log, toast via `toast-xml.ts`, the module
singleton, `MN_AUTO_START_TRIGGER` gate.

**Changed:**
- `src/main/index.ts` — `handleAutoRecordEligible` arms instead of starts
  when the trigger is `join`; wires `onSyncCompleted` decisions and
  `registrar.hasActiveWatch` into the join watcher; passes
  `getRecordingStateMachine()` for the "already recording" guard.
- `src/main/recording-state.ts` — `forgetCompleted(key)`; `ActiveRecording`
  gains `trigger`.
- `src/main/recording-ipc.ts` — auto-stop request carries `deliver`.
- `src/preload/index.ts` + `src/renderer/src/App.tsx` — honour
  `deliver: false` on auto-stop (stop + `discardCompletedSpill`, no upload).
- `src/main/call-signals-core.ts` — poll interval becomes injectable so the
  attach poller runs at 5 s while a meeting is live (constant, not behaviour).
- `src/main/backend-supervisor.ts` — exposes the parsed credential layers
  (already loaded for the backend child) so main can read
  `MN_AUTO_START_TRIGGER` from the same two-layer file (J6).

**Reused, untouched:** call-watch registrar (E1–E4), relay routes,
storage-api, the stop machine (D5–D9), capture, upload, delivery, backend.

## Data flow

```
calendar sync (5 min) ──decisions──▶ registrar (watches)        ┐
                      └──eligible──▶ join watcher ◀── hasActiveWatch(hash) ┘
                                          │  5 s: GET /call-watches/{hash}/signals
                                          │  derive recorder-in-call
                                          ├── in-call & armed ─▶ sendAutoStartRequest(trigger: join)
                                          ├── +2 min & idle   ─▶ toast [Record now] ─▶ sendAutoStartRequest(trigger: prompt)
                                          └── call_ended / end+10 / cancelled ─▶ disarm
recording ─▶ attach poller (5 s) ─▶ recorder_left ─▶ pause/grace ─▶ auto-stop
                                                                    └─ J4: deliver:false + forgetCompleted → re-armed
```

## Failure modes — all fail closed

| Situation | Behaviour |
|---|---|
| Watch never registered / beyond cap / created too late | Prompt at +2; no silent start |
| Relay or storage-api down | Poll errors logged; treated as no signal → prompt path |
| Signal history unavailable (app started mid-meeting) | Unknown ≠ in-call → wait for a fresh IN; prompt at +2 |
| Joined from another device (phone) | **Records the desktop** — known gap, F1 |
| App asleep through the window | Nothing recorded; on wake, arms only if still inside the window |
| Two overlapping armed meetings | Own watches; a join starts that meeting; the other's prompt suppressed while recording |
| Join then network drop | No roster OUT (Teams holds the seat) → keeps recording, as today |
| Recurring series | Same join URL; watch persists across occurrences (existing) |
| Manual recording already running | Join signals ignored; prompt suppressed |
| Renderer not ready at start | Existing pending-auto-start / ack-timeout path |

Deliberate regression: hybrid meetings where the user is in the room and
never clicks Join now need one click on the prompt (chosen over silent
recording, Q1).

## Testing

**`scripts/verify-join-watch.ts`** — plain-Node harness over the pure core,
bundling it alone and asserting no `require("electron")`. Fixtures must
**derive** coupled fields exactly as production does (the E1 bug shipped
green for three releases because a fixture hand-set `autoRecordEligible:
true` on a `not_due_yet` decision — a shape `filter.ts` never emits).
Scenarios:

1. Early join, still in at −3 → start at −3.
2. Early join, left at −10, no return → nothing; prompt at +2.
3. Left at −10, rejoin at +15 → start on the +15 signal.
4. Join at +0:30 → start on signal.
5. `call_ended` before any join → disarm, no prompt.
6. No active watch → never starts by signal; prompt at +2; Record now works.
7. Prompt fires once; restart at +3 doesn't re-toast; suppressed while
   another recording is live.
8. False start: start at −2, leave at −1, no return → discard + re-arm;
   rejoin at +5 starts a fresh recording.
9. False-start boundaries: ends at +3 min, or lasts 5 min, or ends by
   `call_ended` → delivered.
10. Manual and prompt-triggered recordings are never discarded.
11. `MN_AUTO_START_TRIGGER=calendar` → today's behaviour exactly;
    `verify:call-watch-registrar` fixtures pass unchanged.
12. Two overlapping armed meetings.
13. Signal history unreadable → unknown → no start.

Backend suite unchanged. `npm run typecheck`, `verify:call-signals`,
`verify:call-watch-registrar` stay green.

**Live matrix (one account suffices — the recorder's own join/leave is the
signal):**

| # | Steps | Expect |
|---|---|---|
| L1 | Join at −1 | Recording within ~8 s; leave → pause/grace/stop as today |
| L2 | Join at −20, stay | Starts at −3 |
| L3 | Join at −20, leave at −10, don't return | Prompt at +2; nothing recorded |
| L4 | Join at −2, leave at −1, rejoin at +5 | First discarded (no email); fresh recording at +5 |
| L5 | Create meeting 2 min before start (watch blind) | Prompt at +2; Record now works |
| L6 | `MN_AUTO_START_TRIGGER=calendar` in `%PROGRAMDATA%` | Old behaviour |
| L7 | Manual recording running through a scheduled start | No auto-start, no prompt |

Ground truth for every run: `tmp/watch-signals.cjs` against the store, as
on 14 Aug.

## Follow-ups (not in this change)

- **F1 — Local device check (required, next).** Before starting on a join
  signal, confirm Teams on *this* machine is in a call — Windows audio
  session enumeration (`IAudioSessionManager2`: is `ms-teams.exe` an active
  render/capture session?) or Teams' own window/call state. Natural home is
  the rolled-back `native/audio-endpoint-monitor` (Rust, tag v2.0.17). The
  case that makes this required: staff joins from the meeting-room phone
  with the laptop left in *another* meeting room → the laptop records
  someone else's meeting. This is the largest remaining leak path once
  join-trigger ships and must be named in the release comms.
- **F2 — Presence as a second signal.** `/me/presence` with
  `InAConferenceCall` / `InACall` (never `InAMeeting`, which is
  calendar-derived) to auto-start when the roster watch is blind instead of
  prompting. Needs `Presence.Read` delegated consent (David A).
- **F3 — storage-api emits `call_started`.** Lets the desktop *know* a watch
  is blind (registered after start) and word the prompt accordingly. Small.
- **F4 — Restore invitee delivery** (`MN_DELIVERY_RECIPIENTS=attendees`) once
  David F is comfortable — independent of this feature.

## Resolved during design review

- **Signal history.** storage-api `list_signals` returns the **full history
  for the watch's current generation**, sorted by `seq` (verified 18 Aug in
  `app/services/call_watches.py`). J2's derivation reads it directly; the
  join watcher keeps no cross-poll state. A watch *replacement* (new
  generation, E4 lifecycle) empties the history → unknown → prompt path,
  the correct fail-closed outcome.
- **Kill-switch location.** Main's `.env.production` lives under `resources/`
  and is overwritten by auto-update; the setting therefore uses the
  supervisor's `backend.env` layers instead (J6).

## Open questions

None blocking. One to confirm during implementation:

- Exact toast action plumbing for a *pre*-recording toast (today's toasts
  are all tied to an active recording); `toast-xml.ts` already carries
  action arguments, so this is expected to be wiring, not design.
