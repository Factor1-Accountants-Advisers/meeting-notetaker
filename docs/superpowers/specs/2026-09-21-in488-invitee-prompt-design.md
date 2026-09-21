# IN-488 Invitee Email Prompt — Design

**Date:** 21 September 2026
**Jira:** IN-488 "Idea: email invitees notification" (re-read 21 Sep: still
Draft, under the Slice 2 epic IN-375; its only comment is Joseph's 17 Sep
"Proposed design for the invitee prompt" with the mock-up image).
Related: IN-398 and IN-91 (SharePoint permission hardening), IN-478 (email
idempotency).
**Status:** Design approved by Joseph in chat on 15 Sep 2026 (all five
design sections and the mock-ups). DA approved it as is on 21 Sep 2026 in
the Innovations Teams chat, relayed by Joseph; the approval is not yet on
the Jira ticket. This spec was written on 21 Sep 2026 from the recovered
conversation. Nothing is implemented.
**Sources:** `tmp/in488-design-recovered.md` (verbatim chat turns from 15
and 17 Sep, timestamps UTC, untracked) and the approved mock-ups at
`docs/superpowers/specs/in488-invitee-prompt-mockups.html`.
**Builds on:** organiser-only delivery (v2.0.29, 18 Aug) and the IN-478
email idempotency work. Shares code with the unmerged
`2026-08-18-sharepoint-permission-hardening-design.md`; see Dependencies
and sequencing.

## Why

Since the 18 Aug 2026 mandate (David F via David A) the app delivers to the
recording owner only. `MN_DELIVERY_RECIPIENTS` defaults to `organizer`
(`backend/app/config.py:92`), so invitees get no email and no per-file
SharePoint grant. The mandate followed a Notetaker that auto-recorded a
scheduled meeting while its user was in an unrelated in-person
conversation; that transcript went to the meeting's invitees.

In the 10 Sep 2026 sync DA said IN-488 is "probably worth just to do"
because it "closes the loop" on the notetaker. The ticket, re-read on
21 Sep and matching the conversation's summary, asks for:

- a setting: "email my transcripts to me and all invitees" or "email only
  me";
- a notification when processing finishes, "Email this to everyone?", with
  the invitee list shown (cut off if long, full list on hover), lasting
  about 60 s;
- timeout or No: only the organiser gets it. Yes: invitees get it too.

The sync added three points the ticket does not cover:

- **Not sending is the default.** If the user is distracted or ignores the
  prompt, nothing goes to invitees.
- **A way to send later.** DA: people "just have to manually send it if
  they want to." The ticket has no path for that.
- **Auto-send users may still need a way to stop it.** Benjamin's point was
  that the risk comes from what gets said in the meeting, not from the
  user's preference. Not settled in the sync.

### How delivery works today

All `file:line` references in this spec were checked against `main` at
`998d1e4` (v2.0.39) on 21 Sep 2026. `main` has had no commits since 7 Sep,
so the conversation's line numbers still hold. Where the conversation
described the code inaccurately, that is recorded under Open questions.

- **Delivery is renderer-driven.** `watchProcessing`
  (`src/renderer/src/App.tsx:1005`) polls the pipeline; in its `ready`
  branch (`:1025`) it calls `saveTranscriptToSharePoint` and then
  `emailNotes` (`:1039-1040`), which are `POST /meetings/{id}/sharepoint`
  and `POST /meetings/{id}/email`.
- **Both recipient lists read one global gate.**
  `attendee_fan_out_enabled()` (`backend/app/services/recipient_policy.py:49`)
  is read by `_email_recipients` (`backend/app/routers/meetings.py:972`,
  gate at `:997`) and by `_sharepoint_recipients` (`meetings.py:1013`, gate
  at `:1046`). There is no per-meeting "send to invitees later" endpoint and
  no per-meeting state for it. `delivery_status` tracks the one email, and
  `delivery_recipients` is what a replay reuses (`meetings.py:704-708`).
- **Ad-hoc recordings never email attendees.** `_email_recipients` ignores
  `manual_attendees` (the docstring at `meetings.py:1030-1031` says email
  "has no ad-hoc delivery path"). `_sharepoint_recipients` includes them,
  but only when the gate is open.
- **Toasts live in the main process.** They are built in
  `src/main/toast-xml.ts` and shown from `src/main/recording-ipc.ts` and
  `src/main/join-watch.ts`. Button clicks come back as `notetaker://`
  protocol launches, which the single-instance lock turns into a
  `second-instance` event (`src/main/index.ts:197-246`). The window hides
  to the tray but is never destroyed, so main can hand a decision to the
  renderer the way tray Pause/Stop does.

## Requirement

When a meeting's notes are ready, nothing is delivered to anyone until the
recording owner answers one question: email the transcript to the invitees,
or just to me. No answer within the toast lifetime counts as "just me". A
"just me" or timed-out meeting keeps a durable action to send to the
invitees later, and that later send never emails the organiser a second
time. The existing organiser delivery path and its IN-478 protections stay
as they are.

## Decisions

Times are UTC on 15 Sep 2026 unless stated. "The assistant" is the AI
assistant in the design conversation.

### D1 — Everyone is asked; no "always email invitees" setting in v1

Decided by Joseph, 05:33Z: "for now, we can do C. then I'll confirm with
the team in chat the direction we want to go". The options were A (always
mode sends straight away, no toast), B (always mode shows a toast with a
countdown and a "Don't send" button) and C (no always mode). The assistant
leaned to B. Reasoning recorded for C: it is the simplest, it drops the
settings screen from scope, and Benjamin's objection to auto-send was not
settled in the sync. It was provisional, pending the team, until 21 Sep
2026: DA approved the design as is, and Joseph restated "no always-send in
the first version". It is now final for v1.

### D2 — Ad-hoc recordings prompt too

Decided by Joseph, 05:39Z: "B so that invited people can also get the
transcripts". The assistant had recommended calendar meetings only. For an
ad-hoc recording the invitee list is the attendee-picker selections
(`manual_attendees`). Those come from the central directory, so they are
already internal, but they pass the domain allowlist like everyone else.
This is new behaviour: ad-hoc attendees have never received email.

### D3 — One send, held until the decision

Decided by Joseph, 05:46Z: "when we were talking with DA I think he was
leaning more toward option B". The assistant had recommended two sends
(organiser immediately, invitees on Yes) because the organiser path is
fleet-deployed and has had three rounds of idempotency fixes. Reasoning
recorded for the hold: it matches DA's "do you want to send it?" wording
and the ticket's "if it times out or No, email only goes to organiser";
everyone lands on the same To: line, so reply-all works and the organiser
can see who received it. Accepted cost: the organiser's own copy is delayed
by up to the toast lifetime when they do not respond, and "send later"
still needs a second-send mechanism.

### D4 — The SharePoint save is held as well

Proposed by the assistant at 06:00Z, reversing its own 05:47Z flow in which
the SharePoint save started immediately. Approved by Joseph with Section 2
at 06:01Z ("yes that is the expected behavior. continue"). Reasoning: the
SharePoint grants are the sharing, and holding both means one decision
leads to one delivery pass (SharePoint, then email). That is exactly the
sequence `retryTranscriptEmail` already runs (`App.tsx:1188`, calls at
`:1224-1225`), so there is no new orchestration and no second upload when
the answer is Yes. The hold is at most the toast lifetime.

### D5 — Not sending is the default; sending later stays possible

From DA in the 10 Sep sync. Confirmed by Joseph at 05:59Z: "as long as we
get the behavior where ... the toast notification times out ... the email
is sent to the organizer and not sent to everyone this is fine". No and
timeout both mean organiser only. The ready card then carries a durable
"Send to N invitees" action (Section 3 and the mock-ups, approved 06:22Z),
which sends a second, invitee-only email and adds the SharePoint grants.

### D6 — The backend owns the decision

The assistant set out three approaches at 05:47Z and recommended the first.
The recovered conversation has no explicit reply choosing it; Section 1,
which is built on it, was approved by Joseph at 05:59Z. Reasoning: it is
the only approach where every path (toast click, in-app button, later
send, retry, restart) reads one source of truth. Rejected:

- **Renderer-only flag** (`include_invitees` in the request bodies). "Send
  later" has nothing durable to key on, the toast-once rule has to be
  persisted separately in main, and a restart mid-hold loses the prompt.
- **Main process owns the flow.** Goes against the architecture where the
  renderer drives all delivery, and duplicates the token and proxy
  plumbing.

### D7 — A separate `invitee_delivery_status`; `delivery_status` untouched

Approved by Joseph at 05:59Z: "so we dont touch the delivery status to the
organizer/notetaker user itself to avoid duplicates". Reasoning: the
organiser send has its own hard-won state machine (IN-478). Startup flips
`emailing` to `unconfirmed` (`backend/app/services/pipeline.py:203`), and
`set_delivery_state` (`pipeline.py:152`) clears `delivery_recipients` on
any transition out of `emailed` (`:171`). If a later invitee-only send
reused that machine, a crash mid-send would erase the record that the
organiser already received theirs, and the next retry would email them
again. Two small machines, each single-purpose.

### D8 — The toast lives in main and fires the safe default on expiry

Joseph drew the comparison at 05:59Z with the paused-recording grace toast
(leave the meeting, recording pauses, a short window to reconnect, then it
stops and processes). The assistant confirmed that pattern at 06:00Z:
`buildRecordingPausedToastXml` (`toast-xml.ts:115`) with a timer in main,
where the safe default fires on expiry. Here the safe default is
"organiser only". Approved with Section 2 at 06:01Z. Lifetime is the app
standard of 2 minutes (`TOAST_LIFETIME_MS`, `toast-xml.ts:186`, agreed
with DA on 19 Aug) rather than the ticket's 60 s. It is one constant.

### D9 — Toast shows a count and three names; the card shows the full list

A platform limit, stated at 05:35Z and in Section 2. A Windows toast is
three short text lines and buttons, with no hover text. The toast shows the
count and the first three names, then "+N more". The full list is on the
in-app card. Windows also does not let an app style one toast button as
primary, so both are grey and the wording carries the emphasis. Mock-ups
approved by Joseph at 06:22Z ("nice looks good").

### D10 — `MN_DELIVERY_RECIPIENTS` becomes a three-value delivery mode

Section 5 (06:26Z) opens with a revision to Section 1, "because the kill
switch is cleaner this way". It supersedes Section 1's rule and one line of
Section 4. Approved by Joseph at 06:37Z ("nice! looks great"). Detail is in
section 1 below.

### D11 — Own branch, own release

Section 5, approved 06:37Z. Branch `feature/invitee-email-prompt` off
`main`, shipped as its own release and not bundled with the still-unmerged
SharePoint hardening.

### Wording added by the mock-ups

The assistant flagged two additions when it delivered the mock-ups
(06:14Z); Joseph approved the mock-ups at 06:22Z:

- "Invitees haven't received it." on the organiser-only ready card. Without
  it the card reads as if delivery is finished and the Send button looks
  like a resend.
- The restart card for a declined meeting reads "Emailed to you on
  Tue 15 Sep, 14:32" instead of listing addresses, because by then the date
  is what helps the user recognise the meeting.

Where Section 3's text and the mock-ups differ, this spec follows the
mock-ups, which came later and were approved.

## 1. Backend: state, recipient rules, endpoints

### New fields on `Meeting` (`backend/app/schemas.py:154`)

- `invitee_decision`: `pending | approved | declined`, default `pending`.
- `invitee_delivery_status`:
  `not_started | sending | sent | unconfirmed | failed`.
- `invitee_recipients`, `invitee_error_message`, `invitee_error_code`.

`delivery_status` is not widened (D7). The decision is stored in the
recorder's local `store.json`, like `delivery_status`. Nothing goes to the
central storage API.

No SharePoint item IDs are stored. The assistant first thought a later
grant would need them (05:35Z, 05:47Z), then confirmed at 05:53Z that the
upload is a `PUT` by path (`GraphSharePointProvider.save_transcript`,
`backend/app/services/sharepoint.py:171`, method at `:179`). Re-posting
`/sharepoint` overwrites the same two files and re-runs the grants.

### Delivery mode (D10)

`MN_DELIVERY_RECIPIENTS` gains a third value and the code default moves:

| Value | Behaviour |
|---|---|
| `ask` | New code default: the prompt flow |
| `organizer` | Organiser only, never prompt. Exactly the v2.0.29+ behaviour, so it is the kill switch |
| `attendees` | Auto-approve, no prompt (the existing escape hatch) |
| anything else | Treated as `organizer`. Fails closed to today's behaviour, not to the prompt |

- `attendee_fan_out_enabled()` becomes `delivery_mode()`.
- `invitees_approved(meeting)` = mode is `attendees`, or mode is `ask` and
  the stored decision is `approved`.
- `prompt_enabled()` = mode is `ask`.

**Amendment, 21 Sep 2026 (Joseph, "B").** As written on 15 Sep,
`invitees_approved` was true for a stored `approved` whatever the mode, so a
"Send to N invitees" click or a Retry on an approved meeting would still
email invitees after the fleet was switched to `organizer`. Joseph ruled
that the kill switch stops all invitee delivery, not only new prompts.
Under `organizer`: no prompt, no send-later action, and a stored `approved`
delivers to the organiser only. The stored decision is kept, so switching
back to `ask` restores it. The example that settled it: Monday "Just me"
leaves a "Send to 5 invitees" button on Home; Tuesday the switch is flipped
after an incident; Wednesday a click on that leftover button must send
nothing.

Section 1 originally defined `invitees_approved` as "decision is approved
or `attendee_fan_out_enabled()`", with only the `attendees` override. The
table above replaces that.

`release.yml` writes the `MN_DELIVERY_RECIPIENTS` line into the bundled
`backend.env` only when the repo variable is non-empty
(`.github/workflows/release.yml:193-195`). The conversation states the
variable is blank today, so the release would pick up `ask` from the code
default. That state is a GitHub setting and was not verified for this spec
(see Open questions).

### Recipient rules (`recipient_policy.py` and `meetings.py`)

- `invitee_candidates(meeting)` returns name and email pairs: Graph
  attendees for calendar meetings, `manual_attendees` for ad-hoc, minus the
  organiser and the recorder, through the existing domain allowlist
  (`filter_deliverable`, `recipient_policy.py:101`). It is computed
  backend-side because the allowlist lives there, and it is the list the
  toast and the card display.
- `_email_recipients` and `_sharepoint_recipients`: the recipients that are
  always included stay as they are; candidates are added only when
  `invitees_approved(meeting)`. The global gate reads are replaced by the
  per-meeting rule. Net behaviour change: ad-hoc attendees become emailable
  (D2).

The conversation words the always-included set as "organiser + recorder
always" for both functions. In today's code that is true of
`_email_recipients`. `_sharepoint_recipients` adds the organiser only,
because the recording owner already has access as the uploading identity
(`meetings.py:1026-1027`). Nothing in the design asks for that to change.

### Endpoints

- `GET /meetings/{id}/invitees` returns
  `{candidates, decision, invitee_delivery_status, invitee_recipients}`.
  `decision` is the effective one: it reports `approved` under the
  `attendees` override.
- `POST /meetings/{id}/invitees/decision` with
  `{approved: bool, source: toast|app|timeout}` returns the Meeting. Owner
  only. Audited as `meeting.invitee_decision`. Transitions:
  - `pending → approved` and `pending → declined`: allowed.
  - `declined → approved`: always allowed. This is "send later".
  - same-value repeats: no-ops.
  - `approved → declined`: 409 once anything has been sent. There is no UI
    for it.
- `POST /meetings/{id}/email` (existing, `email_notes`, `meetings.py:682`)
  gets two paths:
  - **First send** (`delivery_status` is not `emailed`): recipients per the
    rule, one email, exactly today's machinery. If approved, also mark
    `invitee_*` as `sent` with the candidate subset.
  - **Later send** (`delivery_status` is `emailed`, approved, and
    `invitee_delivery_status` is `not_started`, `failed` or `unconfirmed`):
    email the candidates only, driving `invitee_*` with the same durability
    order as the organiser send (snapshot `sending` before the Graph call).
    Empty candidates: replay, as today.
  - `EmailResult` (`schemas.py:336`) gains `sent_now: list[str]` so the UI
    can say who this call reached. `recipients` keeps meaning "everyone who
    has it".
- `POST /meetings/{id}/sharepoint` (existing,
  `save_transcript_to_sharepoint`, `meetings.py:823`): only the recipient
  rule changes. A re-post after a later approval overwrites the files and
  grants the invitees, which is what the retry path already does.
- **Startup reconcile:** `invitee_delivery_status` `sending → unconfirmed`,
  next to the existing `emailing → unconfirmed` flip in
  `reconcile_interrupted_pipelines` (`pipeline.py:186`, flip at `:203`).

**Timeout** is recorded as `declined` with `source: timeout`. In state it is
indistinguishable from "Just me", and "send later" is the same
`declined → approved` transition either way.

**Re-upload or pipeline retry** (a regenerated transcript) resets
`invitee_decision` to `pending` and `invitee_*` to `not_started`, the same
way `set_delivery_state` clears the email replay fields. Today that reset
happens in `kick_pipeline` (`pipeline.py:471`, reset at `:490`). New
content, new question.

## 2. Desktop: toast, relay and the hold

```
pipeline ready (renderer, watchProcessing)
  ├─ blob delivery starts (independent, as today)
  ├─ GET /meetings/{id}/invitees
  │    ├─ effective decision approved, or no candidates ─▶ deliver now, no prompt
  │    └─ otherwise ─▶ IPC delivery:prompt-invitees
  │                     main: toast + chime + 2 min timer
  │                     renderer: pending card (awaiting_invitees)
  ├─ first of: toast button │ card button │ timer expiry
  ├─ POST /meetings/{id}/invitees/decision {approved, source}
  └─ delivery pass: POST /sharepoint, then POST /email ─▶ ready │ email_failed
```

### The hold lives in the renderer's `watchProcessing`

The `ready` branch (`App.tsx:1025`) today calls
`saveTranscriptToSharePoint` and then `emailNotes` the moment the pipeline
is ready. New sequence at `ready`:

1. Blob delivery kicks off as today (independent).
2. `GET /meetings/{id}/invitees`. If `decision` is already `approved`
   (fleet override) or `candidates` is empty, deliver immediately: today's
   behaviour, no prompt.
3. Otherwise ask main to show the prompt and wait for a decision from any of
   three sources: the toast button, the in-app card button, or the timeout.
4. On a decision: `POST /invitees/decision {approved, source}`, then the
   normal delivery pass (SharePoint, then email), then the existing ready or
   failed notice messages.

### Main process: new module `src/main/invitee-prompt.ts`

Kept out of `recording-ipc.ts`, which is already large (817 lines). Same
shape as the join-watch prompt (`src/main/join-watch.ts`, `showPrompt` and
`closePrompt`).

- IPC `delivery:prompt-invitees {meetingId, title, candidates}` builds and
  shows the toast, plays the chime through the existing `notification:chime`
  cue, and starts a `TOAST_LIFETIME_MS` timer. State is a map
  `meetingId → {notification, timer}`, so two meetings finishing close
  together (an ad-hoc upload and a scheduled one) can each have a prompt up.
- Decision out:
  `webContents.send('delivery:invitee-decision', {meetingId, approved, source})`,
  the same relay the tray Pause/Stop uses (`sendTrayRecordingControl`,
  `recording-ipc.ts:209`). Timer expiry sends
  `{approved: false, source: 'timeout'}`.
- IPC `delivery:close-invitee-prompt {meetingId}` from the renderer when the
  user answers in-app, so main closes the toast and cancels the timer.
  Otherwise the timeout would fire "declined" while the user is looking at
  the card.

### The toast (`toast-xml.ts`, new `buildInviteePromptToastXml`)

`scenario="reminder"` like the other toasts, silent audio. Wording from the
mock-ups:

```
Notes ready: Innovations sync
Email the transcript to 5 invitees?
David Ahlhaus, Priya Nair, Sam Whitfield +2 more
[Email invitees]  [Just me]
```

Three text lines is the Windows limit, so: the first three names, then
"+N more". Names other than David Ahlhaus are examples. Lifetime is
`TOAST_LIFETIME_MS` (2 min).

### Button routing carries the meeting ID

Today's actions are bare URIs such as `notetaker://record-now`
(`toastUri`, `toast-xml.ts:29`), which works because only one join prompt
can be up. For this prompt the URIs are:

- `notetaker://invitees-approve?meeting=<uuid>`
- `notetaker://invitees-decline?meeting=<uuid>`

`toastActionFromArgv` (`toast-xml.ts:41`) learns to parse the query and
still accepts the old bare URIs. The `second-instance` handler in
`index.ts` (`:197-246`) gains two branches, with no focus steal, the same
as extend and record-now. A click on a toast whose timer has already fired
is ignored by meeting ID, so a stale click cannot send anything.

### Restart during the hold

The renderer's watcher is gone, so nothing fires. At startup, next to the
unuploaded-recordings resurfacing (`App.tsx:374-406`, the scan at
`:375-398`), any meeting with `pipeline_status = ready`,
`delivery_status = not_started`, `invitee_decision = pending` and non-empty
candidates gets an in-app prompt card. There is no toast and no timer on
this path; the user decides when they open the app. Today a restart in that
window loses the delivery silently, so this is a small improvement and not
a regression.

### Toast body click

The body click is the existing `open` action and shows the window. Windows
dismisses the toast, but main's timer keeps running, so if the user then
walks away the organiser-only send still happens. Answering on the card
cancels it.

## 3. In-app cards and wording

Everything lives on the Home screen as cards, because the app has no
meeting list or detail view. The views are home, recording, settings and
voiceprint-admin (`App.tsx:51`). The cards are the `PostCaptureNotice`
component in `src/renderer/src/screens/HomeScreen.tsx` (`:345`).

Names, addresses, counts and dates below are the mock-ups' examples.

### 3.1 Pending card (live flow)

New post-capture state `awaiting_invitees`, with the candidate list
attached. Shown while the toast is up, so the user can answer in either
place.

```
✉  Innovations sync
   Notes are ready. Email the transcript to 5 invitees?
   David Ahlhaus, Priya Nair, Sam Whitfield, Alex Morgan, Jordan Lee
   [Email invitees]  [Just me]
```

- The full invitee list, already filtered to allowed company domains.
- No Dismiss in this state: the timeout resolves it.
- Answering here closes the toast and cancels main's timer.
- The pending state does not count as "active" for the shell status bar.
  Only `processing` and `emailing` do (`App.tsx:1600-1604`), so the top bar
  does not say "processing" while waiting for an answer.

Any answer moves the card to `emailing`, then to today's `ready` or
`email_failed` outcome:

| Answer | `emailing` message |
|---|---|
| Email invitees | Saving to SharePoint and emailing to you and 5 invitees… |
| Just me, or no answer in 2 min | Saving to SharePoint and emailing to you… |

### 3.2 Ready card

After **Email invitees**, the ready message lists every address that
received it, as it does today, with Dismiss:

> Transcript saved to SharePoint and emailed to {all addresses}.

After **Just me** or a timeout, the ready card gains an action. Today's
ready card has none (`actionLabel` is null for `ready`,
`HomeScreen.tsx:369-376`). The message is one string, wrapped here:

```
✓  Innovations sync
   Transcript saved to SharePoint and emailed to {organiser address}.
   Invitees haven't received it.
   [Send to 5 invitees]  Dismiss
```

### 3.3 Send later

Clicking **Send to 5 invitees** records `approved` with `source: app` and
runs the same delivery pass: the SharePoint re-post (overwrite plus grants),
then the email, which the backend routes to the later-send path. The
backend knows the organiser already has their copy, so only the invitees
are emailed.

| State | Card |
|---|---|
| sending | Sending the transcript to 5 invitees… |
| sent | Sent to {addresses reached by this send}. Dismiss |
| failed | Failed: Outlook sign-in. "Sign in to Outlook, then retry. Nothing was sent to invitees; your own copy was already delivered." **Retry email**, Dismiss |

Retry is the existing **Retry email**, which re-runs the pass. The backend
state makes the retry idempotent: the organiser is never re-emailed.
Section 3's text had the success message as "Sent to 5 invitees."; the
mock-ups list the addresses, which also matches `sent_now` and the rule in
3.5.

### 3.4 Startup resurfacing

On launch, next to the unuploaded-recordings list, the renderer fetches
meetings from the last 7 days and builds cards, above the New meeting
card, for:

- `ready` and `invitee_decision = pending` and undelivered: the pending
  card, with the buttons from 3.1, no timer, no toast.
- `invitee_decision = declined` and `invitee_delivery_status` is not
  `sent`: the send-later card with Dismiss:

```
✓  Innovations sync
   Emailed to you on Tue 15 Sep, 14:32. Invitees haven't received it.
   [Send to 5 invitees]  Dismiss
```

Dismissal is remembered in the renderer's `localStorage` as a set of
meeting IDs, alongside the existing `USER_KEY` (`App.tsx:40`), and not in
the backend: dismissing a card is a UI preference, not delivery state. It
is per machine. This is what makes "later" genuinely later. Without it the
send-later option would vanish the moment the card was dismissed or the
app restarted.

### 3.5 Message wording

Wording stays close to today's. The `ready` message keeps listing the
actual email addresses. That is deliberate since 7 Aug: the user sees
exactly who got it. The SharePoint grant warning
(`sharepoint_grant_warning`) still appends when some invitees could not be
granted.

### 3.6 When the question is skipped

- **No eligible invitees.** A recording with nobody else on the invite, or
  only external addresses (which the allowlist removes), delivers to the
  organiser straight away, as today.
- **Fleet override.** Under `MN_DELIVERY_RECIPIENTS=attendees` every
  meeting is treated as "Email invitees" with no prompt.
- **Kill switch.** Under `organizer` there is no prompt and delivery is
  organiser only. The mock-ups predate this value (they were drawn before
  Section 5) and do not show it.

## 4. Error handling and edge cases

### Sending failures

All of these reuse today's paths. The decision is already recorded before
delivery starts, so every retry runs with the same recipient list.

- **Not signed in to Outlook or SharePoint:** `email_failed` card with
  Retry, which signs in and re-runs the pass, exactly as now
  (`retryTranscriptEmail`).
- **No partial emails.** Graph `sendMail` is atomic per message, and both
  the first send and the later invitee send are single messages. The only
  partial outcome is SharePoint grants, which are already per-recipient,
  with failures collected into `sharepoint_grant_warning` (Option A,
  IN-398; `grant_view` in `sharepoint.py`). Unchanged.
- **Unconfirmed sends (IN-478).** First send: the existing
  `emailing → unconfirmed` handling applies to the whole message; if it was
  approved, `invitee_delivery_status` is set to `unconfirmed` alongside so
  the state stays consistent. Later send: only `invitee_delivery_status`
  goes `unconfirmed`; the card shows the check-your-inbox warning; Retry
  re-sends to invitees only. `delivery_status` never leaves `emailed`, so
  the organiser cannot get a duplicate.
- **Backend unreachable mid-pass:** `email_failed` with Retry, as now. The
  decision survived, because it was snapshotted on its own request.

### Decisions and races

- **First answer wins.** The renderer keeps a per-meeting "decided" flag;
  the toast, the card and the timeout all go through it. Backend
  transitions are as listed in section 1.
- **Timeout landing while the user is clicking** (an answer at 1:59): the
  renderer posts the decision before starting delivery and ignores the
  timeout message once decided. If the timeout reaches the backend after an
  approve, it is rejected and ignored.
- **Stale toast click** (a toast that lingered in Action Center after the
  timer fired): main finds no entry for that meeting ID and ignores it with
  a log line. The card is the way to send later.
- **Two meetings finishing close together:** each has its own toast and
  timer in main. The renderer's post-capture notice is a single slot today,
  so the second meeting's card replaces the first's. The first's toast
  still resolves it, and the restart resurfacing catches anything missed.
  Known limitation, not new, noted for a follow-up.

### Restarts and versions

- **App restart during the hold:** pending card on launch, no timer
  (section 2).
- **Backend restart during the hold:** `invitee_decision = pending` is in
  `store.json`; the renderer's watcher continues; nothing changes.
- **New desktop, old backend still running.** If `GET /invitees` returns
  404, the renderer treats that as "no prompt support" and delivers
  immediately, which on that backend means organiser-only under the global
  gate. Fails safe, never to fan-out. The conversation's premise for this
  case has drifted; see Open questions.
- **Re-upload or pipeline retry:** resets the decision and the invitee
  delivery state (section 1).

### Scope guards

- External invitees are removed by the allowlist before counting, so they
  never appear in the toast or the card. The existing `recipient_blocked`
  warning still logs each one. If everyone is external: no prompt,
  organiser-only delivery.
- Candidates never include the organiser or the recorder, so "5 invitees"
  is always other people.
- The prompt is not suppressed while another recording is running, unlike
  the join prompt. It is a delivery question, not a recording one.
- Delivery mode `attendees`: no prompt, everyone gets it. Unrecognised
  values are treated as `organizer` (D10). Section 4 of the conversation
  said unrecognised values "fail closed to the prompt flow"; Section 5's
  revision came later and explicitly says the opposite, so it wins.

### Observability

Main logs `[invitee-prompt] shown / answered {source} / timeout /
stale-click`. The backend logs
`invitee_decision meeting=… decision=… source=…` and audits
`meeting.invitee_decision`. Both ride into the Report Problem bundle.

## 5. Testing and rollout

### Backend tests (`backend/tests/`)

- New `test_invitee_candidates.py`: calendar vs ad-hoc source, organiser
  and recorder excluded, allowlist applied, dedupe, names carried through.
- New `test_invitee_decision.py`: every transition in section 4, owner-only
  access, the audit entry carries the source, persisted on its own request,
  reset on re-upload.
- Extend `test_email_recipients.py`, `test_sharepoint_recipients.py` and
  `test_organizer_only_delivery.py`: the three modes by decision states,
  manual attendees emailable once approved, `ask` as the default.
- Extend `test_email_idempotency.py` and `test_delivery_reliability.py`:
  the first send under approval marks `invitee_*` as `sent`; the later send
  goes to invitees only and never re-emails the organiser (the
  `FailingEmailProvider` and `UnconfirmedEmailProvider` fakes already exist
  in `test_delivery_reliability.py`); startup reconcile
  `sending → unconfirmed`.
- `GET /invitees` contract: candidates, and the effective decision under
  each mode.
- The conftest pin `MN_DELIVERY_RECIPIENTS=attendees`
  (`backend/tests/conftest.py:49`) for the historical suite stays as is.

### Desktop harnesses (`npm run verify:*`, plain Node)

- `verify:toast-xml` (existing): pin `buildInviteePromptToastXml`: reminder
  scenario, three lines, "+N more" truncation at three names, XML-escaped
  names and titles, both URIs carrying `?meeting=`; `toastActionFromArgv`
  parsing the query and still accepting the old bare URIs.
- New `verify:invitee-prompt` on a pure `invitee-prompt-core.ts` (injected
  clock, same shape as `join-watch-core.ts`): show, answer, timeout leads
  to declined, an in-app answer cancels the timer, a stale click is
  ignored, two meetings are independent.
- New `verify:invitee-cards` on a pure renderer lib `lib/inviteePrompt.ts`
  (same pattern as `lib/deliveryNotice.ts` and `verify:email-notice`): card
  copy from counts and names, the restart filter (7 days, dismissed set,
  state predicates), the 404-means-no-prompt fallback.
- Typecheck both projects, `npm run build`, ruff on the backend.

### Live checks

Joseph as organiser and DA as invitee, from a test build with its own
`--user-data-dir` profile, as on the v2.0.30 run sheet
(`docs/superpowers/plans/2026-08-19-join-trigger-live-run-sheet.md`), with
the installed app fully quit first so the supervisor does not adopt the old
backend.

| # | Scenario | Pass looks like |
|---|---|---|
| L1 | Calendar meeting, **Email invitees** on the toast | One email to both; transcript in DA's "Shared with me" |
| L2 | **Just me** on the card, then **Send to invitees** | Joseph gets one email only; DA gets one later; nothing duplicated |
| L3 | Ignore the prompt | Organiser-only email at about 2:00; the card offers Send |
| L4 | Ad-hoc recording with DA picked as attendee | Prompt appears; Yes emails DA (the first time ad-hoc email exists) |
| L5 | Quit the app during the hold, relaunch | Pending card, no toast; deciding delivers |
| L6 | Solo ad-hoc, nobody picked | No prompt, immediate delivery |
| L7 | `MN_DELIVERY_RECIPIENTS=organizer` in the machine layer | No prompt, organiser-only |
| L8 | Signed out of Outlook, answer Yes | Failed card, Retry signs in, sent once |

### Rollout and kill switch

- Branch `feature/invitee-email-prompt` off `main`, its own release (the
  next version after 2.0.39 at the time of the design). Not bundled with
  the still-unmerged SharePoint hardening.
- The release picks up `ask` from the code default when the repo variable
  is blank. **Kill switch:** DF can revert the fleet with one repo-variable
  change (`MN_DELIVERY_RECIPIENTS=organizer`) plus a release, or revert a
  single machine through the
  `%PROGRAMDATA%\Factor1\MeetingNotetaker\backend.env` layer with no
  release. That is the same layer the join-trigger kill switch uses.
- Release plan in the `docs/v2.0.30-release-plan.md` format, evidence in
  `docs/jira-progress.md`, and a runbook entry
  (`docs/rollout-runbook.md`) for the new `ask` value.
- Before the tag: the signing FIC subject has to be patched to the exact
  tag first (the v2.0.31 trap).
- DA's team note is one line: "You'll now be asked before invitees get the
  transcript. No answer within two minutes means only you get it; you can
  send it to them later from the app."
- First week in the field: grep `[invitee-prompt]` in problem-report logs.
  If timeouts dominate, the toast is being missed and 2 min is too short,
  or the card is not being seen. Both are cheap to adjust.

## Components

**New:**

- `src/main/invitee-prompt.ts`: runtime layer (toast, timer map, IPC).
- `src/main/invitee-prompt-core.ts`: pure core with an injected clock, for
  the harness.
- `src/renderer/src/lib/inviteePrompt.ts`: pure card copy, restart filter
  and the 404 fallback.
- `scripts/` harnesses for `verify:invitee-prompt` and
  `verify:invitee-cards`.
- `backend/tests/test_invitee_candidates.py`,
  `backend/tests/test_invitee_decision.py`.

**Changed:**

- `backend/app/schemas.py`: `Meeting` fields; `EmailResult.sent_now`.
- `backend/app/services/recipient_policy.py` and
  `backend/app/routers/meetings.py`: `delivery_mode`, `invitees_approved`,
  `prompt_enabled`, `invitee_candidates`; the two recipient functions; the
  two new endpoints; the two paths in `email_notes`.
- `backend/app/config.py`: the `delivery_recipients` default moves from
  `organizer` to `ask`.
- `backend/app/services/pipeline.py`: startup reconcile for
  `invitee_delivery_status`; reset on re-upload.
- `src/main/toast-xml.ts`: `buildInviteePromptToastXml`; query parsing in
  `toastActionFromArgv`.
- `src/main/index.ts`: two `second-instance` branches; wiring for the new
  module.
- `src/renderer/src/App.tsx`: the hold in `watchProcessing`, the
  `awaiting_invitees` state, startup resurfacing, the dismissed set.
- `src/renderer/src/screens/HomeScreen.tsx`: the pending card, and the
  `Send to N invitees` action on the ready card.
- The conversation does not mention the preload bridge. The three
  `delivery:*` IPC channels imply additions to `src/preload/index.ts`,
  because the renderer reaches main only through `window.api` (AGENTS.md
  architecture rule).

**Reused, untouched:** the organiser `delivery_status` machine, the
SharePoint provider (`sharepoint.py`), blob delivery, the central storage
API, capture, upload, and the recording state machines.

## Departures from DA's ticket

Listed in the 17 Sep comment draft as "worth your eye":

1. **The timeout is 2 minutes, not 60 seconds.** Same intent. It is the
   app's standard for reminder toasts and one constant to change.
2. **No hover for the long invitee list.** Windows toasts allow three text
   lines and cannot show hover text, so the toast shows the first three
   names plus a count and the full list lives on the in-app card. Both toast
   buttons are the same grey, because Windows does not let an app style one
   as primary.
3. **The per-user "always email invitees" setting is not in this version**
   (D1). It was half of the original idea, so the draft flags it as DA's
   call: in now, or after field feedback.

Additions beyond the ticket:

- Not sending is the default, and a **Send to N invitees** action allows
  sending later without a second copy to the organiser (both from the
  10 Sep sync).
- One email held until the answer, so everyone lands on the same message.
- The same question appears as an in-app card; the first answer wins.
- Ad-hoc recordings are included (D2).
- Restart resurfacing for unanswered and unsent meetings from the last
  7 days.
- The delivery mode values `ask`, `organizer` and `attendees`.

The 15 Sep draft put two questions to the team: the "always email
invitees" setting (no setting; a setting with a "Don't send" cancel window
before auto-sending; or a setting that sends immediately), and the toast
lifetime (60 s or 2 min).

## Dependencies and sequencing

**What exists.** `codex/sharepoint-permission-hardening` is checked out at
`.worktrees/sharepoint-permission-hardening`: 16 commits, all dated 18 Aug,
forked from `main` at `06290bb`. `main` is 77 commits ahead of that point,
so the branch needs a rebase whatever happens here.
`git diff main...codex/sharepoint-permission-hardening --stat` shows 14
files, +1626 and -52.

**What it changes that IN-488 also touches:**

- `backend/app/routers/meetings.py` (+36): `save_transcript_to_sharepoint`
  gains an `X-MN-User-Email` header parameter, a fail-closed check for a
  missing owner email, and a `provider.prepare_owner_folder(...)` preflight
  placed immediately before `recipients = _sharepoint_recipients(meeting)`.
- `backend/tests/test_delivery_reliability.py` (+169): the SharePoint fakes
  gain `prepare_owner_folder`, and direct calls to the route gain
  `user_email=`. IN-488 extends this same file.
- `backend/app/config.py`, `backend.env.template`, `package.json`,
  `.github/workflows/ci.yml`: both changes add lines in these files.

**What it does not touch:** `_email_recipients`, `_sharepoint_recipients`,
`recipient_policy.py`, `grant_view`, `schemas.py`, `pipeline.py`, the
renderer, `toast-xml.ts` or `index.ts`. It rewrites most of
`backend/app/services/sharepoint.py` (+272), which IN-488 does not edit.

**Behavioural overlap.** IN-488's Yes path and its send-later path both go
through `POST /sharepoint`. After hardening, every such call runs the
privacy preflight first and uploads nothing, so grants nothing, when the
owner folder cannot be proven private, the owner email header is missing,
or the management group is not configured. The send-later re-post re-runs
that preflight; the hardening spec says a secured folder passes it
idempotently. The delivery pass does not gate the email on the SharePoint
result (`App.tsx:1039-1040` and `:1224-1225` call both in sequence), so
under hardening a failed preflight on a Yes would still email the
invitees, with the card showing `email_failed` and Retry. That is how the
pass already treats the organiser. IN-488 also turns invitee SharePoint
grants back on for the fleet for the first time since 18 Aug; per the
hardening spec's evidence, those per-file read grants are additive to the
broad access the library still inherits until the owner folders are
secured.

**Assessment (the spec author's, not a decision from the conversation).**
Textually the two changes are cheap to merge in either order, because they
edit different functions. Merging the hardening first looks safer:

- IN-488 is not written yet, so it would be built against the final shape
  of `save_transcript_to_sharepoint` and the test fakes, and nobody pays a
  conflict cost.
- The live checks that prove invitee access (L1, L2, L4) would exercise the
  final grant path once, not once before hardening and again after.
- The new fail-closed preflight would be in place before invitee grants
  come back for the fleet.

The argument against waiting is schedule. As of 19 Aug the hardening was
waiting on IT and DA (join-trigger spec, J6); its current status was not
checked for this spec. The approved rollout (D11) only requires separate
releases, not a merge order. If IN-488 goes first, three precautions keep
the later rebase small: confine the SharePoint change to
`_sharepoint_recipients`; expect any new test that calls the SharePoint
route or fakes the provider to need `user_email=` and
`prepare_owner_folder` when hardening lands; and re-run L1, L2 and L4 after
hardening ships. The order is Joseph's call.

IN-398 (summary and transcript to SharePoint with invitee view access) was
Blocked and assigned to Joseph as of 15 Sep. The conversation notes its
invitee-access part depends on the same branch.

## Out of scope

- A settings toggle for "always email invitees", and any settings screen
  for it (D1).
- A meeting history screen.
- Teams delivery.
- Changes to the central storage API, Teams, or the SharePoint folder
  structure.
- A fix for the single-slot post-capture notice when two meetings finish
  close together (section 4).
- The "clearer recording indicator" idea from the same 10 Sep sync. It is a
  separate item with no ticket.

## Open questions

**State on 21 Sep 2026.** Joseph has decided questions 1, 3, 7 and 9. For
the rest the assistant proposed the defaults below in chat on 21 Sep. Joseph
was shown them and has not objected, but he has not individually approved
them either; the implementation plan uses them unless he says otherwise.

- Q2: `GET /invitees` also reports whether invitee delivery is enabled
  (`prompt_enabled()`); the renderer prompts, and shows send-later, only
  when it is.
- Q4: once `approved` is recorded, a later timeout or decline is rejected
  (409), whether or not the send has finished.
- Q5: `GET /invitees` is owner only; it lists attendee email addresses.
- Q6: singular wording, "Email the transcript to David Ahlhaus?" and
  "Send to 1 invitee".
- Q8, Q16: commit this spec and the mock-ups together on the feature branch;
  leave the mock-ups file name as it is.
- Q10: build the in-progress `emailing` card the approved mock-ups show.
- Q11: keep the existing "Microsoft sign-in" label; the mock-up text was
  illustrative.
- Q12: for the plan to settle; the 404 fallback stays as designed.
- Q13: add the two new harnesses to `ci.yml`.
- Q14: export `playNotificationChime` from `recording-ipc.ts`.
- Q15: no SharePoint link is added to the email; the recap was wrong.

Decisions still open:

1. **Resolved 21 Sep.** DA's green light covered the design as proposed, with
   no changes (Joseph: "yes green light on the innovations chat. as is").
   That settles the two questions the 15 Sep comment draft left for the
   team: there is no "always email invitees" setting in v1 (D1), and the
   toast lifetime stays at the app standard of 2 minutes. Neither long
   comment draft was posted; Joseph's 17 Sep comment on IN-488 is one line
   plus the mock-up image.
2. **How does the renderer learn not to prompt under `organizer` mode?**
   Section 2 skips the prompt only when the effective `decision` is
   `approved` or `candidates` is empty. Section 5 added `organizer` and
   `prompt_enabled()` but did not say what `GET /invitees` reports in that
   mode (effective decision `declined`, empty candidates, or a new field).
3. **Resolved 21 Sep: yes.** Joseph chose that `organizer` mode blocks every
   invitee send, including "Send to N invitees" and a Retry on a stored
   `approved`. See the amendment under Delivery mode (D10). This also
   narrows question 2: whatever `GET /invitees` reports under `organizer`,
   the renderer must neither prompt nor offer send-later.
4. **`approved → declined` before anything has been sent.** Section 1 makes
   it a 409 "once anything has been sent". Section 4 says a timeout that
   reaches the backend after an approve is "rejected". Which holds in the
   window between an approve and the end of the first send?
5. **Which access role does `GET /meetings/{id}/invitees` require?** The
   decision endpoint is owner only. `POST /email` requires editor today and
   `POST /sharepoint` requires owner. The conversation does not say.
6. **Wording when N is 1.** Every example has three or more invitees. What
   do the toast, the cards and the button say for a single invitee?
7. **Resolved 21 Sep.** Joseph: the SharePoint hardening goes first, because
   IN-488 is unwritten and building it on the final shape costs nothing. The
   hardening branch must be rebased and merged into `main` before
   `feature/invitee-email-prompt` is cut. Whether it also ships to the fleet
   before IN-488 is a release decision and is not settled here. See
   Dependencies and sequencing.
8. **Commit the spec and the mock-ups together?** The assistant asked at the
   end of Section 5 whether to commit both on the feature branch or leave
   them uncommitted. Joseph did not answer. The mock-ups file is untracked.
9. **Resolved 21 Sep.** `gh variable list` on
   `Factor1-Accountants-Advisers/meeting-notetaker` shows no
   `MN_DELIVERY_RECIPIENTS` variable, so the release picks up `ask` from the
   code default. The kill switch is to set the variable to `organizer` and
   release. Check again on release day, since it is a setting anyone with
   repo access can change.

Places where the conversation and today's code differ. None was resolved
here:

10. **The `emailing` card.** Section 3 and mock-ups 3a, 3b and 4 draw
    `emailing` as a Home card. Today Home renders no post-capture card for
    `processing` or `emailing` (`HomeScreen.tsx:134-136`, unchanged since
    29 Jul); that text appears only in the shell status bar
    (`App.tsx:1600-1616`). Is a new in-progress card intended, or do the
    new `emailing` messages go in the status bar?
11. **"Failed: Outlook sign-in".** The mock-up's failure card shows that
    label. The existing label for the `azure_signin` category is
    "Microsoft sign-in" (`src/renderer/src/lib/failureDisplay.ts:13`).
    Rename it, or is the mock-up illustrative?
12. **The "new desktop, old backend" premise.** The conversation says the
    supervisor adopts a backend already on 8787 if the app was not fully
    quit before an update. In today's code it adopts only a backend whose
    `/health` reports the same app version (`shouldAdoptExistingBackend`,
    `src/main/backend-health.ts:94`, IN-484) and kills and replaces any
    other (`src/main/backend-supervisor.ts:71-93`). The v2.0.30 run-sheet
    trap is a test build that shares the installed app's version number.
    The supervisor also does not run in dev (`backend-supervisor.ts:52`).
    The 404 fallback is kept as designed. Which cases should it be tested
    against?
13. **CI coverage.** The conversation says the `verify:*` harnesses are
    "all run by CI". `ci.yml` runs a fixed list: `verify:toast-xml` is on
    it, `verify:email-notice` is not. The two new harnesses run in CI only
    if they are added to `.github/workflows/ci.yml`. Is that intended?
14. **The chime.** The design plays it "via the existing
    `notification:chime` cue". The helper that sends it,
    `playNotificationChime` (`recording-ipc.ts:117`), is private to that
    module, and the join-watch prompt that the new module is modelled on
    plays no chime. Export the helper, or send the cue from the new module?
15. **SharePoint links in the email.** The 15 Sep recap that opened the
    conversation said a Yes must grant SharePoint access "or the links in
    their email won't open". Today's email carries no SharePoint link:
    `build_meeting_notes_email_html` (`backend/app/services/email.py:209`)
    renders the summary and ends "The full transcript is attached." The
    design's own reason for the grants (D4, and L1's "Shared with me"
    check) does not depend on links. Is a link in the email expected by
    anyone, or was the recap simply wrong?
16. **File names.** The conversation calls the mock-ups
    `2026-09-15-in488-invitee-prompt-mockups.html`; the file on disk is
    `in488-invitee-prompt-mockups.html`. Its footer points to "the design
    spec that accompanies this file", which is this document. Rename the
    mock-ups to the dated form, or leave them?
