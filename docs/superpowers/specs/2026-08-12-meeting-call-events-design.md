# Meeting Call Events — Auto-Pause/Stop Recording Design

**Date:** 12 August 2026
**Jira:** to be created (findings ticket drafted; relates to IN-479, IN-67)
**Status:** Approved in conversation; implementation not started

## Goal

Stop the Notetaker from recording past the real end of a meeting. When the
recording user leaves the meeting, pause the recording, give them a 60-second
grace window (and a prompt) to come back, then stop and upload. When the
meeting call formally ends, stop immediately. This addresses the
over-recording concern raised by Gabby and DF (11 Aug) — recordings that
continue after everyone has left capture unrelated, possibly private audio.

## Authorities

- Teams chat Joseph ↔ David Ahlhaus, 11–12 Aug 2026: problem statement and
  the agreed behaviour — "CallEnded we stop recording immediately and
  rosterUpdated with the recording user leaving the meeting, we pause
  recording and wait maybe 60s, if the user joins again we resume, if we get
  to 60s we stop recording and push through the pipeline", plus the
  Upload/Resume popup idea. Grace-expiry behaviour (auto-stop + normal
  pipeline) confirmed by Joseph 12 Aug.
- Live spike, 12 Aug 2026 (`spikes/meeting-call-events/`, 83 events captured
  against a real ~40-participant meeting): validated the Graph
  `meetingCallEvents` change-notification resource end to end. Findings that
  bind this design are listed under "Spike findings" below.
- IN-67 host-only gate (`src/main/graph/host-gate.ts`): auto-recordings only
  start when the signed-in user is the meeting organizer — so for every
  recording this feature touches, recorder == organizer.
- IN-479: ad-hoc/manual recordings get a duration-based mitigation instead;
  they carry no meeting identity (no `joinWebUrl`) and are out of scope here.
- Microsoft Graph docs: changenotifications-for-onlinemeeting,
  change-notifications-with-resource-data (decryption recipe, cert rules).

## Spike findings (constraints this design builds on)

1. Notification latency 1–2.6 s end to end; occasional outliers under 8 s.
2. A deliberate leave fires `rosterUpdated` with the user's AAD OID and
   `removedState.reason = "Participant has left the meeting call."`.
3. Rejoins fire a join delta. Real quick rejoins were observed (26 s and 1 s)
   → pause+grace is required; a hard stop on leave would destroy recordings.
4. A ~50 s Wi-Fi drop fires **nothing** (Teams server holds the seat) —
   short network blips cannot false-trigger. Longer give-ups surface as
   `removedState.reason = "…entered an inactive state in the roster."`.
5. `callEnded` when everyone simply leaves is UNVERIFIED and per the
   organizer (Karen) anecdotally unreliable — the design must not depend on
   it. The recorder's own leave event covers the primary scenario.
6. Subscription creation succeeds only on Graph **/beta** (v1.0 → 400);
   deletion works on v1.0. Application permission `OnlineMeetings.Read.All`
   only — delegated is not supported. No Teams application access policy was
   required. Organizer-ship of the subscribing app is irrelevant; only
   same-tenant matters.
7. Rich notifications are mandatory (basic ones carry an ID with no fetch
   API) → encryption certificate + publicly reachable webhook required.
8. Real payloads use **PascalCase** keys (`RemovedState`, `DisplayName`)
   although the docs show camelCase → parse case-insensitively.

## Scope

1. storage-api: Graph subscription lifecycle, webhook receiver, per-user
   signal store, three authenticated routes for the desktop.
2. Local backend: thin relay routes (desktop never calls the cloud directly).
3. Desktop main process: a call-signal poller that drives the existing
   pause/resume/stop surfaces, a 60 s grace timer, and a sticky
   Upload/Resume toast.
4. Ops: production app registration, encryption certificate, Function app
   settings; retirement of the spike registration.

Non-goals: manual/ad-hoc recordings (IN-479), phone calls (no joinWebUrl),
push transport (poll is sufficient at these timescales; a push channel can
be added later behind the same signal model), any change to the existing
scheduled auto-stop / extension behaviour (it remains the fallback).

## Design decisions

- **D1 — Signals, not events.** The storage-api reduces raw Graph payloads
  to at most three signal types scoped to one user: `recorder_left`,
  `recorder_rejoined`, `call_ended`. The desktop never sees Graph payloads,
  other participants' identities, or roster contents. `callStarted` and
  other participants' deltas are discarded at the webhook.
- **D2 — One watch per user, keyed by OID.** Watch identity is
  `principal.oid` from the validated storage token — never client-supplied.
  A new `POST /call-watches` replaces any existing watch for that user.
  State lives in the existing private `notetaker` blob container:
  `callwatches/{oid}/watch.json` plus one write-once blob per signal
  `callwatches/{oid}/signals/{seq}.json` (no append races across Function
  instances; `put_json_if_absent` discipline).
- **D3 — No renewal infrastructure.** Subscription `expirationDateTime` =
  scheduled meeting end + 12 h, clamped to Graph's 3-day max. Watches are
  deleted on recording stop; orphans (crash paths) expire server-side and
  their blobs are lazily cleaned when next touched. The storage-api gains no
  timer/queue triggers.
- **D4 — The webhook is the single sanctioned auth exception.**
  `POST /graph/call-notifications` is mounted outside `/api/v1` without
  `require_user`; `tests/test_auth_dependencies.py` is updated to name it as
  the only allowed exception. It authenticates Graph's way: validationToken
  echo (text/plain), `clientState` equality, and `validationTokens` JWT
  validation (Microsoft issuer for our tenant, audience = our Graph app's
  client id, `azp`/`appid` = `0bf30f3b-4a52-48df-9a82-234910c4a086`) using
  the PyJWT/JWKS machinery already in `app/auth/tokens.py`. It always
  returns 202 quickly; invalid items are dropped and logged.
- **D5 — Desktop control goes through existing surfaces only.** The poller
  calls `sendTrayRecordingControl('pause'|'resume')` and
  `sendAutoStopRequest()` (`src/main/recording-ipc.ts`); the renderer's
  capture code is untouched. All stop paths converge on the renderer's
  single-flight `finishActiveRecording` (3 Aug incident fix), so racing
  stops coalesce safely.
- **D6 — Auto-resume only undoes its own pause.** The poller records
  whether the current pause was signal-initiated; `recorder_rejoined`
  auto-resumes only that pause. A manual pause is never resumed by the
  system. A manual resume during grace cancels the grace timer (explicit
  user intent wins).
- **D7 — Fail open to today's behaviour.** Registration failure (one retry
  at +30 s), poll failures, Graph outages, feature flags off — in every
  case the recording proceeds exactly as today, with the scheduled
  auto-stop timer and T-5 min Extend toast unchanged. This feature only
  ever adds an earlier stop.
- **D8 — Kill switches both ends.** `NSA_CALL_WATCHES_ENABLED` (storage-api;
  watch routes return 503 `feature_disabled`, the webhook keeps returning
  202 so Graph does not disable the subscription) and
  `MN_CALL_SIGNALS_ENABLED` (desktop; poller stays dormant). Same pattern
  as `MN_STORAGE_API_ENABLED`.
- **D9 — "Inactive state" is treated as `recorder_left`.** The spike showed
  short drops fire nothing; anything that arrives means Teams gave up on the
  participant. Pause+grace is the right response either way, and the rejoin
  path auto-recovers.

## Component design

### storage-api (`notetaker-storage-api`)

New router `app/routers/call_watches.py` (mounted under `/api/v1` with the
standard guard) and `app/routers/graph_webhook.py` (the D4 exception), plus
`app/services/graph_subscriptions.py` (Graph client-credentials token via
stdlib urllib, subscription create on /beta, delete on v1.0) and
`app/services/call_notifications.py` (JWT validation, decrypt, PascalCase-
insensitive parse, signal reduction).

The Graph subscription resource is keyed **directly on the join URL** — no
onlineMeeting-id lookup exists or is needed:
`communications/onlineMeetings(joinWebUrl='{url-encoded joinWebUrl}')/meetingCallEvents`,
`changeType: updated`, created on /beta. Transcribe the exact request shape
from the spike's `spikes/meeting-call-events/subscribe.py` (`create()`).

Routes:

- `POST /api/v1/call-watches` (require_scoped_user)
  body `{join_web_url: str, scheduled_end_utc: str}` →
  `{watch_id, subscription_expires_utc}`. Replaces any existing watch for
  the caller's OID. Graph failure → 502 `graph_error` (desktop treats as
  registration failure, D7).
- `GET /api/v1/call-watches/current/signals` (require_scoped_user) →
  `{signals: [{seq, type, event_utc, received_utc}]}` — **all** signals for
  the current watch (a handful per meeting, bounded by D2's replace
  semantics). No server-side cursor: the desktop dedupes by `seq` against
  its seen-set, which sidesteps any cross-instance clock-skew ordering
  hazard in `seq` generation.
- `DELETE /api/v1/call-watches/current` (require_scoped_user) → 204; deletes
  the Graph subscription (best effort) and blobs.
- `POST /graph/call-notifications` — D4 webhook.

New settings (env `NSA_`, applied out-of-band — bicep does not manage app
settings): `graph_client_id`, `graph_client_secret`, `graph_enc_cert_pem`
(public, also sent base64-DER in subscription requests),
`graph_enc_key_pem` (private), `graph_client_state`, `graph_cert_id`,
`call_watches_enabled`. New dependency: `cryptography`.

Signal blob content: `{seq, type, event_utc, received_utc}` where `seq` is a
zero-padded monotonic string derived from `received_utc` + notification id
(lexically sortable, collision-safe). Logging carries OIDs/hashes only —
never join URLs, titles, or emails (same rule as `hostGateLogContext`).

### Local backend (`meeting-notetaker-2/backend`)

Three relay routes in a new `app/routers/call_watch.py`, following the
`X-MN-Storage-Token` header → `RestStorageApiClient` pattern of
`routers/meetings.py:420` / `people.py`. `StubStorageApiClient` gains no-op
counterparts (register→ok, signals→empty, delete→ok) so stub/dev mode is
unaffected. The desktop-facing paths are added to `isStorageRoute()` in
`src/main/api-request-policy.ts` so storage identity headers ride along.

### Desktop main (`meeting-notetaker-2/src/main`)

New module `call-signals.ts` exporting `armCallSignals(recording)` /
`disarmCallSignals()`, wired into `handleRendererRecordingStarted` (arm only
when `source === 'auto'` and `metadata.joinWebUrl` is set) and
`handleRendererRecordingStopped` / `handleRendererRecordingError` (disarm +
DELETE watch, best effort).

Poller: every 10 s, GET signals through the local backend (same fetch +
`storageIdentityHeaders` + `getStorageApiAccessToken` pattern as
`api-proxy.ts`, honoring `isStorageApiEnabled`), deduping by `seq` against
an in-memory seen-set that resets when the poller re-arms. State machine:

- `recorder_left` (and not already in grace): if not paused →
  `sendTrayRecordingControl('pause')`, mark pause signal-initiated. Start
  60 s grace timer **anchored on desktop receipt time** (not `event_utc`) —
  deterministic locally; the effective window from the actual leave is
  60 s + delivery latency (~2 s) + up to one poll interval (10 s), which is
  acceptable and documented for the live-smoke expectations. Show sticky
  toast (below) + chime.
- `recorder_rejoined` during grace: cancel grace; if pause was
  signal-initiated → `sendTrayRecordingControl('resume')`; close toast.
- `call_ended`: cancel grace, `sendAutoStopRequest()`.
- Grace expiry: `sendAutoStopRequest()`.
- Duplicate/stale signals: ignored by state checks (idempotent).

Toast (new builder in `toast-xml.ts`, `scenario="reminder"`, protocol
activation like `buildEndingSoonToastXml`): body "Looks like you left the
meeting — recording paused." Buttons: **Upload now**
(`notetaker://upload-now` → `sendAutoStopRequest()`) and **Keep recording**
(`notetaker://resume-recording` → resume + cancel grace). Two new members in
the `ToastAction` union, `toastActionFromArgv`, and the `second-instance`
switch in `index.ts`. Stale clicks (recording already stopped) are no-ops
via state-machine checks, same as `mn-extend`.

Renderer: no required changes. The paused state already renders in
`RecordingScreen` and the tray label via `recording:paused-changed`.

## Failure handling

Per D7, every failure path leaves today's behaviour intact. Specifics:

- Registration: one retry at +30 s, then dormant for this recording.
- Poll: failures are log-only; next tick continues. Desktop offline ⇒ its
  meeting audio is dead anyway; on reconnect the poller catches up from its
  cursor and acts on whatever it finds.
- Webhook: item-level validation failures are dropped (still 202 overall).
  Unknown/undecryptable payloads are logged with correlation ids, never
  stored.
- Blob storage down: watch routes return the existing 503 mapping
  (`StorageUnavailable`); desktop treats as poll/registration failure.
- Crash orphans: subscription self-expires; watch blobs lazily replaced or
  cleaned on next contact from the same user.

## Testing

- **storage-api (pytest):** decrypt round-trip using an encrypt-like-Graph
  fixture generator (port of the spike's `selftest.py`); handshake echo
  content-type; clientState and JWT rejections; PascalCase and camelCase
  payloads; signal reduction to the watch owner only; watch replace
  semantics; signal listing (return-all + client seen-set dedupe, no
  server cursor); auth-invariant test updated for the single webhook
  exception; feature-flag 503s on watch routes (webhook still 202s dark).
- **Local backend (pytest):** relay forwards token/headers; stub no-ops.
- **Desktop (verify scripts):** the repo's convention is esbuild-bundled
  `verify:*` Node harnesses in `scripts/` (no vitest). A new
  `verify:call-signals` script exercises the poller state machine as a pure
  unit (signal sequences → control calls), grace timing, rejoin/manual-
  resume cancellation, signal-initiated-pause-only auto-resume, duplicate
  signal idempotency; the existing `verify:toast-xml` gains the new verbs
  and toast shape.
- **Live smoke before ship:** repeat the spike runbook once against the
  deployed webhook with a real test meeting on a packaged build: leave →
  pause+toast; rejoin → resume; leave + wait 60 s → auto-stop + pipeline;
  organizer end → immediate stop.

## Rollout

1. storage-api first (webhook + routes live, unused by old clients).
2. Desktop release via the normal Intune/FIC ritual; old clients simply
   never register watches.
3. Flags default on once the live smoke passes.

## Ops prerequisites (manual, before storage-api deploy)

1. **Production app registration** "Notetaker Meeting Events" (single
   tenant): application permission `OnlineMeetings.Read.All`, admin consent,
   client secret (rotation per org standard). Joseph performs this with a
   guided walkthrough (same shape as the spike registration on 12 Aug).
2. **Production encryption certificate** (self-signed RSA-2048 acceptable
   per Graph docs); public+private PEM into app settings.
3. **Function app settings** applied via portal/`az` (bicep is RBAC-only).
4. **Retire the spike**: delete the Entra app registration "Notetaker
   Meeting Call Events (Spike)" (client id
   `b817c14a-d200-4e24-806c-58f2c6c1d465`) — Entra → App registrations →
   the app → Delete (this revokes its secret and consent with it); delete
   `spikes/meeting-call-events/.env` and the local cert/key files once the
   test fixtures are ported. The spike folder's README and `events.jsonl`
   stay as evidence.

## Open items

- Exact secret/cert rotation cadence for the prod registration (align with
  DV's key-rotation standard).
- Whether `call_ended` should also fire a toast ("Recording uploaded —
  meeting ended") — cosmetic, decide during implementation.
- Graph /beta stability: revisit if Microsoft promotes the subscription
  resource to v1.0 (the create call is isolated in
  `graph_subscriptions.py`).
