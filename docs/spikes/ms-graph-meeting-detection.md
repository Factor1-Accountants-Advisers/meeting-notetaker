# Spike: Microsoft Graph meeting detection

Date: 2026-06-26
Owner: Joseph Guerrero
Jira: IN-65 — Spike: MS Graph meeting detection — subscription vs. polling
Repo: `/home/josephmiguelguerrero/projects/meeting-notetaker-2`

## Decision

Use delegated Microsoft Graph calendar polling/delta polling from the Electron main process for the Slice 1 MVP.

Do not use Graph webhooks/change notifications for the MVP unless David/Gerd explicitly approve adding a backend notification relay.

Recommended MVP path:

1. Add MSAL/Entra sign-in in Electron main using the existing public-client desktop app registration.
2. Request delegated scopes: `User.Read` and `Calendars.Read` for detection. `Mail.Send` remains needed later for final transcript email.
3. Poll a rolling near-future calendar window using `/me/calendarView` first.
4. Move to `/me/calendarView/delta` once the normaliser/filter behaviour is proven with fixtures.
5. Persist only scheduler-safe state: event IDs, occurrence start/end, delta link when valid, inclusion/exclusion reason, and last poll metadata.
6. Log include/exclude decisions through the Phase 2 logger, without event body, token, full meeting link, transcript, prompt, or client data.
7. Do not start recordings in Phase 4. Phase 4 should only detect eligible meetings and expose/log state.

This keeps the app aligned with the locked architecture: renderer does not call Graph, backend secrets stay out of the desktop, and manual recording remains unaffected while detection is proven.

## Why polling/delta wins for MVP

### Polling/delta advantages

- Fits a local desktop recorder. The app can evaluate upcoming meetings while running and recompute on startup/resume/unlock.
- Avoids needing a public HTTPS webhook endpoint for each local desktop client.
- Easier to debug in development: fixture payloads plus structured logs can explain why each meeting was included or skipped.
- Supports recurring meetings through `calendarView`, which returns single instances, occurrences, and exceptions for a time range.
- Matches current repo state: authentication is still stubbed, and the main process has just been split into modules suitable for `src/main/graph/*` and `src/main/scheduler/*`.

### Webhook disadvantages for MVP

- Graph change notifications deliver to a client endpoint. A local Electron app is not a stable public HTTPS endpoint.
- A webhook approach would require a backend relay with subscription validation, lifecycle handling, renewal, auth, tenant controls, and delivery from cloud to each user desktop.
- That backend relay may be the right future architecture if the app needs near-real-time calendar sync while desktop clients are offline, but it is unnecessary for Slice 1 detection.

## Microsoft Graph evidence checked

Docs checked on 2026-06-26:

- `List calendarView` — `GET /me/calendar/calendarView?startDateTime={start_datetime}&endDateTime={end_datetime}` and `GET /me/calendarView?...` return occurrences, exceptions, and single instances of events in a time range. Least privileged delegated permission includes `Calendars.ReadBasic`; this app needs `Calendars.Read` because detection needs attendee/organiser/online meeting metadata. Source: https://learn.microsoft.com/en-us/graph/api/user-list-calendarview?view=graph-rest-1.0
- `Get incremental changes to events in a calendar view` — `/me/calendarView/delta?startDateTime=...&endDateTime=...` returns `@odata.nextLink` while paging and `@odata.deltaLink` after synchronisation. The token encodes the original time range and query parameters, so follow-up requests should use the returned link. Source: https://learn.microsoft.com/en-us/graph/delta-query-events
- `Change notifications overview` — Graph sends notifications to a specified client endpoint through channels including webhooks. That favours a server endpoint, not an unauthenticated local Electron process. Source: https://learn.microsoft.com/en-us/graph/change-notifications-overview
- `Microsoft Graph throttling guidance` — Graph can return HTTP `429 Too Many Requests` with a `Retry-After` header. The poller must respect `Retry-After` and use backoff with jitter when absent. Source: https://learn.microsoft.com/en-us/graph/throttling
- `Microsoft Graph service-specific throttling limits` — Outlook service limits apply per app ID and mailbox combination, so per-user polling is viable but must avoid tight loops. Source: https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits

## Required scopes and app registration

Current repo docs already specify:

- Supported account type: single tenant Factor1.
- Redirect URI: mobile/desktop public client using `http://localhost`.
- Delegated permissions: `User.Read`, `Calendars.Read`, `Mail.Send`.

For detection implementation:

- Minimum for identity: `User.Read`.
- Minimum for meeting detection: use `Calendars.Read` instead of `Calendars.ReadBasic`, because the scheduler needs organiser, attendee, response, online-meeting, and visibility metadata.
- `Mail.Send` should not be used in detection code; keep it for the later finalisation/email phase.
- Desktop must never include a client secret. MSAL desktop is a public-client flow.

## Event fields to normalise

Create an internal `GraphCalendarEvent` / `DetectedMeetingCandidate` shape instead of letting raw Graph payloads leak across the app.

Minimum raw fields to request/normalise:

- `id`
- `iCalUId` if available
- `subject`
- `start.dateTime`, `start.timeZone`
- `end.dateTime`, `end.timeZone`
- `isCancelled`
- `isAllDay`
- `showAs`
- `sensitivity`
- `isOrganizer`
- `organizer.emailAddress.name`
- `organizer.emailAddress.address`
- `attendees[].emailAddress.name`
- `attendees[].emailAddress.address`
- `attendees[].status.response`
- `isOnlineMeeting`
- `onlineMeetingProvider`
- `onlineMeeting.joinUrl`
- `webLink` only if needed for diagnostics; do not log it raw.

Do not request or persist event body for MVP detection. Body text can contain client-sensitive material and is not needed for host-only auto-recording.

## Include/exclude rules

The poller should produce an explicit decision for every event in the active window.

Include candidate meetings when all of these are true:

- event is not cancelled;
- event is not all-day;
- current time is within the scheduler lookahead/start/stop policy;
- user has not declined;
- event has usable start and end instants;
- event appears recordable under product rules;
- for future auto-recording, signed-in user is organiser (`isOrganizer === true`).

Usually exclude and log a reason when:

- `isCancelled === true` → `cancelled`
- `isAllDay === true` → `all_day`
- `showAs === "free"` → `free_time`
- response is declined → `declined`
- `sensitivity === "private"` → `private_event_pending_policy`
- missing or invalid start/end → `invalid_time_range`
- end is before now and outside grace → `already_ended`
- no online meeting metadata and auto-recording policy is online-only → `not_online_meeting`
- `isOrganizer !== true` for auto-record candidates → `not_organizer`

Manual recording must remain available regardless of these exclusions.

## Host-only semantics

For Slice 1 auto-recording, use Graph `isOrganizer === true` as the primary host gate.

Do not infer organiser status from:

- subject/body text;
- Teams/Zoom URL ownership;
- attendee order;
- display name matching;
- mailbox alias guessing.

Open caveat for David/Gerd: Graph `isOrganizer` may not capture delegated organiser/co-organiser business expectations. If Factor1 needs delegated assistants or co-organisers to auto-record, that is a separate product decision and should be added explicitly after MVP detection.

## Timezone and recurrence strategy

Use `calendarView` because it expands recurring series into instances/exceptions inside the requested time range.

Rules:

- Store scheduling state as absolute UTC instants.
- Preserve original Graph timezone fields for diagnostics.
- Prefer asking Graph for a consistent timezone via a `Prefer: outlook.timezone="UTC"` header if it simplifies parsing.
- Never append `Z` to a Graph timestamp blindly.
- Include fixture coverage for AU/PH/UTC, daylight-saving boundaries, and timestamps that already include offsets.
- Use event id + occurrence start as the idempotency key for recurring meetings.

## Polling cadence and recovery

Initial safe defaults for Phase 4 implementation:

- On app ready/sign-in: immediate sync.
- Normal foreground/background poll: every 5 minutes.
- Near meeting start window: recompute timers locally from the last synced event set; do not tight-poll Graph.
- Lookahead window: now minus small grace to now plus 24 hours for MVP; extend to 5 days only for passive UI if needed.
- On resume/unlock/network recovery/token refresh: immediate sync with jitter.
- On 401/interaction-required: mark auth stale and pause Graph polling until sign-in refresh succeeds.
- On 429: respect `Retry-After`. If absent, exponential backoff with jitter.
- On repeated failures: keep manual recording enabled and show passive status only; no modal spam.

## Persistence

Persist scheduler state in a small desktop-side store, not in renderer localStorage.

Suggested state:

- last successful sync timestamp;
- active window start/end;
- `@odata.deltaLink` for that exact window when using delta;
- known event instances keyed by event id + occurrence start;
- include/exclude decision and reason;
- backoff state;
- handled recording idempotency keys once Phase 6 starts.

Do not persist raw tokens, event bodies, full join URLs, or client-sensitive free-text.

## Logging and privacy

Allowed logs:

- event decision reason;
- hashed or truncated event id;
- start/end instants;
- online provider enum;
- booleans such as `isOrganizer`, `isCancelled`, `isAllDay`;
- attendee count;
- response status;
- poll result counts;
- throttling/backoff metadata.

Forbidden logs:

- access tokens or refresh tokens;
- client secrets;
- full join URLs;
- event body/description;
- full transcript or prompt content;
- raw email lists unless explicitly needed for a local dev-only diagnostic and redacted before commit.

## Proposed Phase 4 module plan

Add these modules under `src/main/graph/`:

- `client.ts` — thin Graph fetch wrapper with delegated token supplier, `Retry-After` handling, and safe error objects.
- `types.ts` — raw/minimal Graph DTOs and normalised event types.
- `time.ts` — timezone-safe conversion to UTC instants.
- `normalise.ts` — raw Graph event to internal candidate.
- `filter.ts` — include/exclude decision engine with reason codes.
- `poller.ts` — sync loop, delta-link handling, startup/resume hooks.
- `store.ts` — small persisted scheduler state.

Add later under `src/main/scheduler/`:

- `state-machine.ts` — manual/auto conflict state.
- `timers.ts` — local start/stop timers from already detected candidates.

Do not add auto-start/auto-stop in Phase 4.

## Fixture test plan for Phase 4

Because the repo does not currently have a dedicated Electron main test runner, start with small fixture-driven scripts or pure TypeScript modules that can be typechecked and exercised without importing Electron entrypoints.

Required fixtures:

1. cancelled Teams meeting → excluded `cancelled`;
2. all-day event → excluded `all_day`;
3. free focus block → excluded `free_time`;
4. declined meeting → excluded `declined`;
5. private online meeting → excluded or flagged `private_event_pending_policy` until product policy is approved;
6. non-organiser online meeting → detected for UI but not auto-record eligible, reason `not_organizer`;
7. organiser Teams meeting → eligible candidate;
8. recurring meeting occurrence and exception → stable idempotency key includes occurrence start;
9. PH/AU/UTC timezone samples → correct UTC instants;
10. 429 response with `Retry-After` → backs off and does not loop.

## Live payload sample

Not captured in this spike. Current repo state still has stub auth (`localStorage mn.user`) and no live MSAL/Graph token wiring.

Once tenant/client IDs are available and MSAL is wired, capture a redacted sample from `/me/calendarView` with:

- token removed;
- subject replaced with placeholders;
- email addresses replaced with domains/roles or hashes;
- join URLs removed;
- body omitted.

## Recommendation for David/Benjamin review

Approve Electron main-process delegated polling/delta polling for Slice 1.

Build Phase 4 as detection-only with fixture-backed filters and structured logs. Revisit backend webhooks only if Factor1 later requires calendar detection while the desktop app is offline or needs server-side fleet orchestration.
