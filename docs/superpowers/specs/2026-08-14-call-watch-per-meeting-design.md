# Call Watches Per Meeting, Registered at Discovery — Design

**Date:** 14 August 2026
**Jira:** to be created (follow-on to the meeting-call-events feature; relates to IN-479, IN-67)
**Status:** Approved in conversation (Joseph, 14 Aug); implementation not started
**Amends:** `2026-08-12-meeting-call-events-design.md` — supersedes D2's
one-watch-per-user model and the "arm at recording start" wiring. All other
decisions (D1, D3–D9) stand unchanged.

## Why (root cause, confirmed live)

The shipped feature (v2.0.25 + storage-api main) registers the Graph
subscription when **recording starts**. Live testing 13–14 Aug proved a
binding Graph platform behaviour:

> A `meetingCallEvents` subscription only delivers notifications for a call
> that starts **after** the subscription exists. A subscription created while
> the call is already live creates fine (201), passes webhook validation, and
> then never fires — permanently, for that call.

Evidence (all same tenant, same app registration, same webhook, same
organizer):

- 13 Aug tests 1–2 (watch registered 1.5 / 2.3 min **before** scheduled
  start): full leave→pause→toast→stop flow worked; signal blobs present.
- 13 Aug tests 3–5 and 14 Aug test 6 (watch registered 42 s – 5.8 min
  **after** start, because the 5-min calendar poll grid vs the 3-min
  auto-start lead frequently arms post-start): zero signals ever stored,
  verified via soft-deleted blobs in `stf1nt`/`notetaker`.
- 14 Aug discriminating test: same meeting shape, but participants joined
  only **after** the notetaker was recording (subscription pre-dated the
  call) → the full flow worked.

Consequences of the current design, both fixed by this amendment:

1. Any meeting whose call starts before the watch registers (early joiners,
   poll-grid misses, last-minute scheduling) silently loses leave-detection.
2. Back-to-back organizer chains (multiple meetings, one watch) lose it for
   every meeting after the first — the watch handover always races the next
   meeting's first joiner.

## Requirement

Leave-detection (pause on recorder leave, grace, stop on call end) must work
for **every** auto-recorded meeting, including unlimited back-to-back chains,
regardless of when participants join relative to recording start.

## Design decisions

- **E1 — Watch per meeting, registered at discovery.** The desktop registers
  a call watch for each eligible auto-record meeting **as soon as the
  calendar poller discovers it** (hours ahead if the machine is on), not at
  recording start. Registration is a silent metadata operation: no audio, no
  capture, nothing user-visible.
- **E2 — Store keyed by (user, meeting).** Replaces D2. Blob layout becomes
  `callwatches/{oid}/{join_url_hash}/watch.json` plus
  `callwatches/{oid}/{join_url_hash}/signals/{seq}.json`. `join_url_hash` is
  the existing sha256 hex of the joinWebUrl (already computed and audited
  today). Watch identity remains anchored on `principal.oid` from the
  validated token — the oid path segment is never client-supplied. POST for
  the same (oid, meeting) replaces that watch only; other meetings' watches
  are untouched.
- **E3 — Per-user cap, soonest-first.** At most **5** active watches per
  user. The desktop registers for the soonest eligible meetings first and
  skips the rest until slots free (recording end, cancellation, expiry). The
  cap is a server-side invariant (POST returns 409 `watch_limit` beyond it),
  desktop-side a scheduling policy. Bounds Graph subscription count and blob
  churn against pathological calendars.
- **E4 — Lifecycle follows the calendar.** The poller reconciles watches on
  every pass: register newly discovered eligible meetings (E1/E3); on a
  meeting's start/end time change, re-register (delete + create — the
  subscription's `expirationDateTime` derives from `scheduled_end_utc`); on
  cancellation, delete the watch. Recording end deletes that meeting's
  watch as today. Crash orphans still self-expire per D3 (scheduled end
  + 12 h) — no new server-side timers.
- **E5 — Baseline drain on attach.** When a recording starts, the poller
  attaches to that meeting's existing watch and performs one **baseline
  poll**: all signals already stored are marked seen **without acting**.
  Only signals arriving after the baseline drive the state machine. This
  discards pre-recording activity (e.g. the organizer popping into the call
  early to check a camera, then leaving — that stale `recorder_left` must
  not pause a brand-new recording) without any cross-clock comparison.
  Known and accepted consequence: if the recorder genuinely left before
  recording started and never returns, no leave signal fires and the
  scheduled auto-stop remains the stop path (same as today).
- **E6 — Fleet-compatible contract migration.** The desktop-facing routes
  become per-meeting; the v2.0.25 fleet keeps working during rollout via
  thin legacy aliases (below). Old clients that eventually hit removed
  routes fail closed into D7's fallback (registration failed → dormant →
  scheduled auto-stop), never anything worse.

## Component changes

### storage-api (`notetaker-storage-api`)

Store (`app/services/call_watches.py`): keyed by `(oid, join_url_hash)` per
E2. `find_watch_by_subscription` scans the new layout (webhook logic is
otherwise unchanged — it already resolves notifications by subscription id).
`delete_prefix` semantics (deepest-first, HNS) unchanged.

Routes (`app/routers/call_watches.py`, all `require_scoped_user`, all still
behind `NSA_CALL_WATCHES_ENABLED` + notification-url checks):

- `POST /api/v1/call-watches` — body unchanged
  (`{join_web_url, scheduled_end_utc}`); now creates/replaces the watch for
  **that meeting** only. 409 `watch_limit` past the E3 cap.
- `GET /api/v1/call-watches/{join_url_hash}/signals` — that meeting's
  signals. Hash, not raw URL, so join URLs stay out of paths/logs.
- `DELETE /api/v1/call-watches/{join_url_hash}` — delete that watch +
  subscription (best effort).
- **Legacy aliases (one release):** `GET /call-watches/current/signals`
  returns the union of the caller's watches' signals;
  `DELETE /call-watches/current` deletes all the caller's watches. Both are
  correct for a v2.0.25 client (one meeting at a time) and are removed once
  the fleet is past the transition.

Contract: bump `docs/rest-contract-v1.md` (mirrored to the desktop repo) with
the new routes and the deprecation note.

### Local backend (`meeting-notetaker-2/backend`)

`app/routers/call_watch.py` relays gain the per-meeting GET/DELETE (path
segment passthrough); `StubStorageApiClient` no-ops updated to match.
`isStorageRoute()` already prefix-matches `/api/v1/call-watch`.

### Desktop main (`meeting-notetaker-2/src/main`)

New: a **watch registrar** driven by the calendar poller (`graph/runtime.ts`
sync results): after each sync, reconcile per E1/E3/E4 against a small
persisted map (meeting → registered watch + scheduled_end) so restarts don't
re-register needlessly. Registration/deletion reuse the existing
`call-signals` HTTP/identity plumbing and 30 s mutation budget.

Changed: `armCallSignals(recording)` no longer registers; it **attaches** —
looks up the meeting's watch (registering on the spot only as a fallback if
the registrar never managed to, which preserves today's behaviour as the
floor), performs the E5 baseline drain, then polls that meeting's signals
route every 10 s exactly as today. `disarmCallSignals()` keeps deleting the
watch on recording stop. The state machine (`call-signals-core.ts`) is
**unchanged**.

Kill switches unchanged (D8): `MN_CALL_SIGNALS_ENABLED` gates the registrar
and the poller together.

### Privacy note (for the published statement)

With watches parked before meetings, recorder-scoped join/leave signals may
be stored (not acted on) for periods when no recording exists. Same D1
minimization applies — only the recorder's own left/rejoined/call-ended
signals are ever stored; other participants are discarded at the webhook.
One sentence in the privacy statement covers it.

## Acceptance scenarios

1. **Back-to-back chain (David F morning).** Meetings 9:00–9:30 (runs to
   9:35), 9:30–10:00 (host joins 9:40), 10:00–10:30 (host joins 10:10) —
   all organized by the recorder, attendees joining at each scheduled start.
   Each meeting's watch exists before its first joiner; leaving any meeting
   pauses within seconds; each recording's stop is the earlier of
   leave-grace/call-end/scheduled end. No handover races.
2. **Early joiners.** Meeting at 8:30; attendees join 8:25; host joins 8:35.
   Watch was registered at discovery (well before 8:25) → host's later leave
   still pauses/stops correctly.
3. **Camera check (E5).** Host joins the call 10 min early, leaves after
   1 min; recording starts on schedule. The stale `recorder_left` is drained
   at attach; the recording is not paused. Host's real leave later that
   meeting still works.
4. **Reschedule.** A watched meeting moves +2 h; the registrar re-registers;
   leaving the rescheduled meeting still stops the recording.
5. **Fleet compatibility.** A v2.0.25 client against the new storage-api
   registers, polls `current/signals`, and stops on leave for a single
   meeting exactly as before.

## Non-goals

Unchanged from the parent spec: manual/ad-hoc recordings (IN-479), push
transport, and any change to scheduled auto-stop / the Extend button
(overruns remain governed by Extend — Joseph, 14 Aug). Also out of scope:
fixing `func-innov-nt-storage-prod` App Insights ingestion (dead since at
least 13 Aug; strongly recommended ops task — every webhook drop reason is
currently invisible, which is why this root cause took blob archaeology to
find).
