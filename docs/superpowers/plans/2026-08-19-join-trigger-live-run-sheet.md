# Join-triggered recording — Task 14 live run sheet (L1–L9)

Companion to `2026-08-18-join-triggered-recording.md` § Task 14. Every log
line below is the literal string the code emits (verified against
`src/main/join-watch-core.ts`, `join-watch.ts`, `call-signals-core.ts`,
`recording-ipc.ts`, `index.ts` at branch head). Timings are relative to the
meeting's **scheduled start** (`−1` = one minute before, `+2` = two after).

Constants that drive the timings (`join-watch-core.ts`): arm at **−3 min**;
poll every **5 s**; prompt at **start +2 min**, toast lives **60 s**; leave
grace **60 s** (`CALL_SIGNAL_GRACE_MS`); false start = join-triggered AND
stopped by grace expiry AND stop time `< start + 2 min` AND recording
`< 5 min`; window closes at **end +10 min**; graph sync every **5 min**.

---

## 0. Build from the worktree (~10 min, once)

The branch changed the **backend** too (`DELETE /meetings/{id}` for the
false-start discard), so the bundle MUST be frozen from this worktree —
reusing `C:\Projects\meeting-notetaker-2\backend\dist` would leave the
discard path deleting against a 405 and L4/L9 would leave stray Drafts.

```powershell
cd C:\Projects\meeting-notetaker-2\.worktrees\join-triggered-recording

# ffmpeg is git-ignored; the spec bundles it only if present here
New-Item -ItemType Directory -Force backend\third_party\ffmpeg | Out-Null
Copy-Item ..\..\backend\third_party\ffmpeg\ffmpeg.exe backend\third_party\ffmpeg\ffmpeg.exe

# freeze with the main checkout's venv (backend deps unchanged on the branch)
Push-Location backend
& C:\Projects\meeting-notetaker-2\backend\.venv\Scripts\python.exe -m PyInstaller meeting-notetaker-backend.spec
Pop-Location

# keys: package:dir does NOT run prepackage.cjs, so stage backend.env by hand
Copy-Item ..\..\backend.env backend\dist\notetaker-backend\backend.env

npm run package:dir     # cargo helper + electron-vite build + electron-builder --dir
# → dist\win-unpacked\Meeting Notetaker.exe
```

## 1. Quit the installed app — really

The branch is still versioned **2.0.29**, same as the installed app. The
supervisor **adopts** a same-version backend it finds on 8787
(`[supervisor] same-version backend on 8787 — adopting`), which would be the
OLD backend without the DELETE route. So: tray → Quit, then prove it:

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue   # must print nothing
Get-Process 'Meeting Notetaker','notetaker-backend' -ErrorAction SilentlyContinue   # must print nothing
```

## 2. Launch with an isolated profile + tail the log

```powershell
$profile = "$env:LOCALAPPDATA\Temp\mn-join-trigger-profile"
Start-Process ".\dist\win-unpacked\Meeting Notetaker.exe" -ArgumentList "--user-data-dir=$profile"
# sign in (fresh profile). Log:
Get-Content -Wait -Tail 40 "$profile\logs\main.log" |
  Select-String 'join-watch|call-signals|call-watch-registrar|auto-start trigger|auto-record|\[recording\] (sending auto-stop|false start|paused|discard)|\[renderer\].*(discard|false-start)|screen unlocked'
```

Startup must show, in order: `[app] auto-start trigger { mode: 'join' }`,
`[join-watch] configured`. Then prove the NEW backend is the one on 8787:

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" -X DELETE http://127.0.0.1:8787/api/v1/meetings/00000000-0000-0000-0000-000000000000 -H "X-MN-User: x"
# 404 = new route present (a non-UUID id gives 422, also new).  405 = you adopted the old backend → back to step 1.
```

**Force a calendar sync any time:** lock + unlock the screen (Win+L) →
`[app] screen unlocked` → sync. (Also on startup and sign-in.) Use this after
creating each test meeting instead of waiting for the 5-min tick.

**Ground-truth probe** (second terminal, from the MAIN checkout — it reads
the installed app's MSAL cache in `%APPDATA%\meeting-notetaker`, which is
still valid after quitting; runs 20 min, restart when it exits):

```powershell
cd C:\Projects\meeting-notetaker-2
.\node_modules\.bin\electron.cmd tmp\watch-signals.cjs
```

It prints every `recorder_rejoined` / `recorder_left` / `call_ended` the
relay stored, per meeting, the instant it lands. It enumerates meetings
(±3 h) ONCE at startup — after creating a test meeting, restart it
(Ctrl+C; if launched via the wrapper window it restarts itself in 5 s). If you join and it prints
nothing within ~10 s, the watch isn't there — check `hasWatch` below before
blaming the trigger.

**Meetings:** you must be the organiser, Teams meeting (has a join URL),
created inside the 24 h lookahead, and — for any row that expects auto-start
from a join — created ≥ 5 min before your first join **and synced** (see
above), so the registrar has a watch. The line that tells you which case
you're actually in fires at −3:

- `[join-watch] armed { via: 'timer', hasWatch: true }` → join path is live.
- `[join-watch] armed { … hasWatch: false }` then
  `[join-watch] no active watch: prompt-only` → you are in L5 territory, not
  L1/L2 — sync earlier next time.

Keys in the log are idempotency keys, not titles — run one meeting at a time
and use `[join-watch] tracking { armInMs, disarmInMs }` to tell them apart.

**Sole-participant caveat (read before L4/L9).** When you are the only one
in a Teams call and leave, Teams ends the call ~80 s later (14 Aug data:
`recorder_left` → `call_ended` 82 s apart). Two consequences:
1. `call_ended` stops the recording with reason `call_ended`, which **always
   delivers**. Grace expiry (`grace_expired`, ~65 s after the leave at a 5 s
   poll) normally wins by ~15 s, but if the probe shows `call_ended` before
   the auto-stop line, the delivery is per-spec, not a bug — rerun with a
   second participant holding the call open (your phone; doubles as the F1
   device check).
2. A `call_ended` at/after scheduled start **disarms** the watcher (J2:
   "meeting over"), so a rejoin after that never auto-starts. That is why
   L4's timings below differ from the plan's original −2/−1/+5.

---

## 3. The rows

Evidence columns: **log** = `main.log` lines in order; **probe** = signals
you should see; **backend** = the app's Meetings list, or
`curl.exe -s http://127.0.0.1:8787/api/v1/meetings -H "X-MN-User: <your signed-in email>"`.

### L1 — join late, stay, then leave (happy path)
Meeting 30 min long, created ≥ 10 min out, synced.
1. Don't join before −1. Expect at −3: `armed … hasWatch: true`.
2. Join at −1.
3. Leave at ≈ +3 (after `start + 2 min`, so it must deliver).

| log | `[join-watch] starting recording { trigger: 'join' }` ≤ 8 s after join → `[join-watch] recording noted; stepping aside` → `[call-signals] arming call-signal poller` → `[call-signals] attached to pre-registered call watch` → `[call-signals] baseline drained { drained: N, live: 0 }` → after leave: `[recording] paused notification requested` (≤ 5 s) → +60 s `[recording] sending auto-stop to renderer { reason: 'grace_expired', deliver: true }` |
|---|---|
| probe | `recorder_rejoined` at −1, `recorder_left` at +3 (then `call_ended` ~80 s later) |
| backend | ONE meeting, processed and delivered — organiser-only email to you (v2.0.29 rule), SharePoint as usual |
| fail if | no `starting recording` within 15 s of the probe's `recorder_rejoined`; or `deliver: false` |

### L2 — already in the call when the window opens
Meeting created ≥ 30 min out, synced.
1. Join at −20, stay.
2. At −3: `[join-watch] armed { via: 'timer', hasWatch: true }` and, on the
   **first poll** (same second), `[join-watch] starting recording { trigger: 'join' }`.
3. Leave whenever after +2 → delivers as L1.

| probe | `recorder_rejoined` at −20 already in history when the poll starts |
|---|---|
| fail if | `armed` at −3 but no `starting recording` within 10 s |

### L3 → L8 chained on ONE meeting — early leave, prompt, late join refused
Meeting **15 min** long, created ≥ 30 min out, synced.
1. Join at −20, leave at −10, don't return. Probe: `recorder_rejoined`,
   `recorder_left`, then `call_ended` ≈ −8:40 — **before start**, so the
   watcher treats it as "not in call" and stays armed (J2).
2. −3: `armed … hasWatch: true`; polls run; nothing starts.
3. **+2:** toast "Start recording?" — `[join-watch] prompting` then
   `[join-watch] prompt toast requested`. **Do not click it**; it auto-dismisses
   at +3.
4. **L8:** wait to **end +2** (= +17), join the call, stay ~30 s.
   `[join-watch] start refused: past scheduled end { key, trigger: 'join' }` —
   exactly **once** (throttled per streak). No toast, no recording.
5. end +10 (= +25): `[join-watch] disarmed { reason: 'window_closed' }`.

| backend | NO meeting created for this event, before or after step 4 |
|---|---|
| fail if | anything records at any point; a second toast; refusal line repeats every 5 s |

### L4 — false start, discard, re-arm, real join
Meeting 30 min, created ≥ 10 min out, synced. Two ways to run it:

**(a) with a second participant** (phone joined from −5 and stays; recommended,
this is the scenario J4 was written for):
1. Join at −2 → `starting recording { trigger: 'join' }`.
2. Leave at −1 → `paused notification requested` (≤ 5 s) → +60 s
   `sending auto-stop to renderer { reason: 'grace_expired', deliver: false }`
   (≈ +0:05; `deliver: false` because stop < start + 2 min and duration < 5 min)
   → `[renderer] { message: 'recording discarded as false start' }` →
   `[recording] false start discarded; meeting re-armed` →
   `[join-watch] re-armed after discarded false start` →
   `[join-watch] armed { via: 'rearm', hasWatch: true }` (first poll one interval later).
3. **+2:** the prompt fires (you're not in the call and nothing is recording)
   — `prompting` + toast. **Ignore it.**
4. Rejoin at +5 → `starting recording { trigger: 'join' }` again (a fresh key
   is not needed — `forgetCompleted` cleared it). Stay past +7, then leave →
   delivers.

**(b) single account** — same, but shift so the phantom `call_ended` lands
before scheduled start: join at **−3:00** (right after `armed`), leave at
**−2:30**, discard lands ≈ −1:25, `call_ended` ≈ −1:08 (pre-start = harmless),
rejoin at **+1**. Everything else identical (the +2 prompt is then suppressed:
`prompt suppressed: a recording is active`).

| probe | (a): `rejoined −2`, `left −1`, `rejoined +5`, no `call_ended` until the very end. (b): `rejoined`, `left`, `call_ended` all before 0:00, then `rejoined +1` |
|---|---|
| backend | exactly ONE meeting for this event (the second recording); no Draft from the first — if you see `[renderer] … false-start meeting delete failed; empty draft may remain` the DELETE route is missing → step 1 |
| fail if | first stop says `deliver: true`; no `re-armed` line; rejoin doesn't start; two meetings |

### L5 — created too late for a watch (prompt-only)
1. Create the meeting **2 min before start**, then **lock+unlock** to sync
   now (otherwise the watcher learns of it at the next 5-min tick and the
   prompt slides to that moment — `max(start+2, now)`).
2. Log at sync: `[join-watch] tracking` → `armed { via: 'sync', hasWatch: false }`
   → `[join-watch] no active watch: prompt-only`. Don't join.
3. **+2:** `prompting` + toast → **click Record now** →
   `[join-watch] starting recording { trigger: 'prompt' }` → recording starts
   with no call at all. Stop it manually after a minute → delivers (prompt
   starts are never discarded).

| caveat | the registrar registers the watch a few seconds after that same sync, but the watcher only notices at the NEXT sync (`[join-watch] watch appeared after arming; polling`). So do NOT lock/unlock again before +2 — a second sync would turn this row into L1. If that line shows anyway, note it and rerun |
|---|---|
| fail if | no toast by +2 (after a confirmed sync); Record now does nothing (`record-now with no prompted meeting; ignored` = the toast had already expired) |

### L7 — manual recording across a scheduled start
Meeting created ≥ 10 min out, synced.
1. Start a **manual** recording at −4, keep it running through +3.
2. −3: `armed … hasWatch: true` (arming is unconditional).
3. Join at −1 → `[join-watch] start refused: a recording is active` (once).
4. +2: `[join-watch] prompt suppressed: a recording is active`, no toast.
5. Stop the manual recording, leave. Nothing auto-recorded; the key was NOT
   consumed by the suppressed prompt (a restart inside the window would ask).

### L9 — leave in the seconds after the join (baseline-seq fix, Task 15 item 2)
Meeting 30 min, synced; keep a **second participant** in the call so the
call doesn't end (single-account works too if you join no later than −1).
1. Join at −1 and **leave the instant Teams shows you in** (≤ 5 s).
2. `starting recording { trigger: 'join' }` → `arming call-signal poller` →
   `[call-signals] baseline drained { drained: N, live: 1 }` — the leave that
   landed between the watcher's decision and the poller's first read was
   ingested, not swallowed → `paused notification requested` → +60 s
   `sending auto-stop … { reason: 'grace_expired', deliver: false }` →
   `false start discarded; meeting re-armed` → `re-armed after discarded false start`.
3. +2: prompt (ignore, or `Record now` if you want L5's path again). Single-
   account run instead: Teams' `call_ended` lands ≈ +0:20 (after start), so
   ~20 s after the discard you get `[join-watch] disarmed { reason: 'call_ended' }`
   and no prompt — expected (J2), not a fail.

| probe | `recorder_rejoined` and `recorder_left` seconds apart |
|---|---|
| backend | no meeting for this event |
| note | if `live: 0` and the pause still comes on a later poll, the leave arrived after the baseline — outcome identical, evidence weaker; retry leaving faster |

### L6 — kill switch (run LAST; needs a restart and undo)
```powershell
New-Item -ItemType Directory -Force "$env:ProgramData\Factor1\MeetingNotetaker" | Out-Null
Set-Content "$env:ProgramData\Factor1\MeetingNotetaker\backend.env" "MN_AUTO_START_TRIGGER=calendar"
# quit the test app, relaunch with the same --user-data-dir
```
1. Startup: `[app] auto-start trigger { mode: 'calendar' }`; **no**
   `[join-watch] configured`.
2. Meeting synced, don't join: at −3 `[app] auto-record triggered { idempotencyKey, startUtc, endUtc }`
   and the recording starts without a call. Stop manually.
3. **Undo:** delete that file (the installed 2.0.29 ignores it, but the next
   branch build would come up in calendar mode) and relaunch to see
   `mode: 'join'` again.

---

## 4. Record + close out

- Results → `docs/jira-progress.md` under a new IN- ticket
  ("Join-triggered auto-record"), one line per row: pass/fail, the timestamps
  of the key log lines, probe evidence.
- Keep the profile folder (`$profile\logs\main.log`) until the PR is merged.
- All nine pass → PR `feature/join-triggered-recording` → `main`; ship as
  **v2.0.31** after SharePoint hardening (v2.0.30), never bundled (spec J6).
- Anything that fails: paste the log window around it (± 2 min) and the
  probe lines; the harness `npm run verify:join-watch` has scenarios s1–s15
  that reproduce every transition above with fake timers.
