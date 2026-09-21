# IN-488 Invitee Email Prompt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a meeting's notes are ready, hold all delivery until the recording owner answers "Email invitees" or "Just me" (no answer in 2 minutes = just me), and keep a durable "Send to N invitees" action that never emails the organiser twice.

**Architecture:** The backend owns the decision: `Meeting` gains `invitee_decision` plus a **separate** `invitee_delivery_status` machine, so the organiser's IN-478-hardened `delivery_status` machine is never touched. `MN_DELIVERY_RECIPIENTS` becomes a three-value delivery mode (`ask` / `organizer` / `attendees`) and both recipient functions read one rule, `invitees_approved(meeting)`. The renderer keeps driving delivery: at pipeline `ready` it asks `GET /invitees`, holds, and runs one delivery pass (SharePoint, then email) after the first answer from any of three sources: a main-process toast (new pure core `invitee-prompt-core.ts` with an injected clock, plus a thin Electron runtime), the in-app card, or main's timeout.

**Tech Stack:** FastAPI + pydantic (Python 3.12, `unittest` test cases run by **pytest**), Electron main (TypeScript, electron-vite), React renderer, esbuild-bundled plain-Node verify harnesses (`node:assert/strict`), Windows toasts through `toast-xml.ts` protocol activation.

**Spec:** `docs/superpowers/specs/2026-09-21-in488-invitee-prompt-design.md` (decisions D1–D11, the 21 Sep "B" amendment under D10, and the proposed defaults for Q2–Q16). Executors read the spec alongside this plan. Approved mock-ups: `docs/superpowers/specs/in488-invitee-prompt-mockups.html`.

**Refinements made while planning** (each is where the spec was silent or where reading the code changed the answer; Joseph may overturn any of them):

1. **`GET /invitees` takes `?recorder_email=`.** Candidates must exclude the recorder, and the spec does not say how the backend learns who that is. The hardening's `X-MN-User-Email` header is attached only to `POST …/sharepoint`, so this mirrors `POST /email`, which already receives `recorder_email` in its body. The desktop proxy logs paths with the query stripped.
2. **The restart filter is stricter, and in one place wider, than spec §3.4.** Stricter: a `pending` meeting resurfaces only while `delivery_status` is `not_started`, because every pre-IN-488 meeting loads as `pending` and is already `emailed`; anything looser floods Home with a week of cards on the first launch after the update. A send-later card also requires `delivery_status = emailed`, since it reads "Emailed to you on …". Wider: an **`approved`** meeting whose invitee send never completed also resurfaces as send-later. The spec covers only `pending` and `declined`, which would silently lose a send the owner said yes to.
3. **The live ready card offers "Send to N invitees" for `pending` as well as `declined`.** If the answer could not be recorded, or `GET /invitees` failed and delivery went ahead organiser-only, the owner can still send. Still never under the kill switch.
4. **A later send is recognised from the response, not tracked in the renderer.** `sent_now` is everyone on a first send, a strict subset on a later send, empty on a replay; a failed later send shows as `delivery_status` still `emailed` on the re-fetched meeting. This makes Retry and the restart cards correct for free.
5. **One delivery pass (Task 11).** The SharePoint → email → card mapping is duplicated today in `watchProcessing` and `retryTranscriptEmail`. IN-488 adds two more callers, so it is extracted first, as a behaviour-preserving refactor. `verify:email-notice`, which guards it, joins CI alongside the two harnesses Q13 names.
6. **A definitive failure of a first send re-arms the invitee machine to `not_started`** (spec silent). Nobody received anything, and the retry is another first send to everyone.
7. **The later-send failure card** keeps the mock-up's second sentence verbatim ("Nothing was sent to invitees; your own copy was already delivered.") but leads with the backend's actual cause, not a fixed "Sign in to Outlook", which would be wrong for a network failure.
8. **No shared main/renderer module.** Neither tsconfig includes `src/shared` for both sides, so the toast wording lives in `toast-xml.ts` and the card wording in `lib/inviteePrompt.ts`, each pinned by its own harness.
9. **Q12 settled:** the 404 fallback is tested at the pure boundary (`interpretInviteesResponse`: 404, unreachable, 403 and an unrecognised body all mean "deliver now"). The supervisor now replaces a backend of a different version, so the case is rare; the fallback stays because a test build can share the installed version number.
10. The mode × decision matrix for **both** recipient functions lives in `test_organizer_only_delivery.py` (it already tests both), not split across `test_sharepoint_recipients.py`.

**Branch:** `feature/invitee-email-prompt`, **stacked** on `integration/hardening-on-main` (= `main` @ `998d1e4` + a merge of `codex/sharepoint-permission-hardening`, commit `5b4fa6e`). Joseph chose this on 22 Sep 2026 over landing the hardening on `main`: the hardening is fail-closed, and once on `main` the next `v*` hotfix tag would ship it to the fleet. IN-488 is still built on the final shape of the SharePoint route, which was the purpose of his 21 Sep "hardening goes first" ruling. **`main` is untouched and nothing is pushed.** When the hardening lands on `main`: `git rebase --onto main integration/hardening-on-main feature/invitee-email-prompt` (the trees are identical, so it replays cleanly).

**Workspace:** the worktree `C:\Projects\meeting-notetaker-2\.worktrees\invitee-email-prompt` (Git Bash path `/c/Projects/meeting-notetaker-2/.worktrees/invitee-email-prompt`). Run every command from there; never `cd` to the main checkout. The worktree has its own `node_modules` and deliberately **no** `backend/.venv` and **no** `backend/.env`: Python comes from the main checkout's venv by absolute path, and the missing `.env` keeps the backend suite hermetic (baseline here is 460 passed, 0 failed). Do not `pip install` anything into that shared venv.

## Global Constraints

Every task's requirements implicitly include these. Values are copied from the spec.

- **Delivery mode values:** `ask` (new code default, prompt flow) · `organizer` (never prompt, organiser only = the kill switch) · `attendees` (auto-approve, no prompt) · anything else, including blank → `organizer`. It fails closed to today's behaviour, never to the prompt.
- **Kill switch blocks ALL invitee delivery ("B", 21 Sep):** `invitees_approved(meeting)` = mode is `attendees`, **or** (mode is `ask` **and** stored decision is `approved`). Under `organizer`: no prompt, no send-later action, and a stored `approved` (including a Retry) delivers to the organiser only. The stored decision is kept.
- **`delivery_status` is never widened or reused (D7).** No code path in the invitee-only send may call `set_delivery_state`. A failure mid invitee-send must leave `delivery_status = emailed` and `delivery_recipients` intact.
- **Not sending is the default (D5).** Timeout is recorded as `declined` with `source: timeout`.
- **Toast lifetime is `TOAST_LIFETIME_MS`** (2 min, `src/main/toast-xml.ts`). Do not add a new lifetime constant.
- **Toast text:** at most three lines; first three names, then `+N more`. Buttons `Email invitees` / `Just me`. Both are grey; Windows cannot style one as primary.
- **Toast URIs:** `notetaker://invitees-approve?meeting=<uuid>` and `notetaker://invitees-decline?meeting=<uuid>`. The old bare URIs must keep parsing.
- **IPC channels:** `delivery:prompt-invitees`, `delivery:invitee-decision`, `delivery:close-invitee-prompt`.
- **Log/audit strings:** main logs `[invitee-prompt] shown` / `answered` / `timeout` / `stale-click`; backend logs `invitee_decision meeting=… decision=… source=…`; audit action `meeting.invitee_decision`.
- **Singular wording (Q6):** one invitee reads "Email the transcript to David Ahlhaus?" and "Send to 1 invitee".
- **Keep the "Microsoft sign-in" failure label (Q11).** No SharePoint link is added to the email (Q15). No SharePoint item IDs are stored; `backend/app/services/sharepoint.py` is not edited.
- **Backend endpoint rules (AGENTS.md):** every mutating endpoint takes `actor: str = Actor`, calls `require(...)`, and calls `store.add_audit`.
- **Renderer never touches the network:** renderer → `window.api` (preload) → main IPC → FastAPI.
- **UI (AGENTS.md):** sentence case, font weights 400/500 only, flat surfaces, Tailwind tokens `bg-*` / `content-*` / `edge-*`, light and dark both work.
- **The conftest pin stays:** `backend/tests/conftest.py` keeps `MN_DELIVERY_RECIPIENTS=attendees` for the historical suite.
- **Line endings:** the repo is LF with `autocrlf=false`. Use the Edit/Write tools. Never rewrite a file through Python text mode without `newline=''`. Run `git diff --check` and `git diff --stat` before every commit; a whole-file diff on a small edit means CRLF crept in.
- **Out of scope:** an "always email invitees" setting (D1), a meeting history screen, Teams delivery, and a fix for the single-slot post-capture notice when two meetings finish together (spec §4, known limitation).

## Verification commands

Backend commands run from `backend/`. **Use pytest, not the `unittest discover` line in AGENTS.md:** the `MN_DELIVERY_RECIPIENTS=attendees` pin is a pytest autouse fixture in `conftest.py`, so `unittest discover` silently skips it and ~10 recipient tests fail for reasons unrelated to your change.

- One file: `cd backend && /c/Projects/meeting-notetaker-2/backend/.venv/Scripts/python.exe -m pytest tests/<file>.py -q`
- Delivery suite (run after every backend task):
  `cd backend && /c/Projects/meeting-notetaker-2/backend/.venv/Scripts/python.exe -m pytest tests/test_delivery_reliability.py tests/test_email_idempotency.py tests/test_email_recipients.py tests/test_organizer_only_delivery.py tests/test_recipient_domain_allowlist.py tests/test_sharepoint_recipients.py tests/test_invitee_candidates.py tests/test_invitee_decision.py -q`
- Full backend (what CI runs): `cd backend && /c/Projects/meeting-notetaker-2/backend/.venv/Scripts/python.exe -m pytest tests --deselect tests/test_storage_api_meetings.py::StubMeetingDeliveryTests::test_stub_serializes_concurrent_exports_for_one_meeting -q`. On this dev machine a populated `backend/.env` can cause unrelated failures; compare against the Task 0 baseline, not against zero.
- Desktop: `npm run typecheck`, `npm run build`, and the named `npm run verify:*` harness.

`file:line` references below were verified against `main` at `998d1e4` (v2.0.39). The hardening merge shifts `meetings.py` by about +34 lines, so **locate code by symbol name**, and treat line numbers as hints.

---

## File structure

| File | Responsibility |
|---|---|
| `backend/app/schemas.py` | `InviteeDecision`, `InviteeDeliveryStatus`, `InviteeDecisionSource` enums; five `invitee_*` fields on `Meeting`; `InviteeCandidate`, `InviteeDecisionRequest`, `InviteeState`; `EmailResult.sent_now`. |
| `backend/app/config.py` | `delivery_recipients` default `organizer` → `ask`. |
| `backend/app/services/recipient_policy.py` | `delivery_mode()`, `prompt_enabled()`, `invitees_approved(meeting)`, `invitee_candidates(meeting, recorder_email)`. `attendee_fan_out_enabled()` is deleted. |
| `backend/app/services/pipeline.py` | `set_invitee_delivery_state`, `reset_invitee_state`; startup reconcile `sending → unconfirmed`; reset in `kick_pipeline`. |
| `backend/app/routers/meetings.py` | `_email_recipients` / `_sharepoint_recipients` on the new rule; `GET /{id}/invitees`; `POST /{id}/invitees/decision`; first-send and later-send paths in `email_notes`. |
| `backend/tests/test_invitee_candidates.py` (new) | Candidate list rules. |
| `backend/tests/test_invitee_decision.py` (new) | Schema defaults, state helpers, reconcile, reset, both endpoints. |
| `src/main/toast-xml.ts` | `buildInviteePromptToastXml`, `inviteeToastLines`, `inviteeToastUri`, `parseToastArgv`. |
| `src/main/invitee-prompt-core.ts` (new) | Pure engine: per-meeting toast + timer map, first-answer bookkeeping, payload validation. No Electron imports. |
| `src/main/invitee-prompt.ts` (new) | Runtime: real `Notification`, chime, IPC registration, decision relay. |
| `src/main/recording-ipc.ts` | Export `playNotificationChime` (Q14). |
| `src/main/index.ts` | Register the IPC, two `second-instance` branches, dispose on quit. |
| `src/preload/index.ts` | `promptInvitees`, `closeInviteePrompt`, `onInviteeDecision`. |
| `src/renderer/src/lib/inviteePrompt.ts` (new) | Pure: card copy, `shouldPrompt`, `canSendLater`, restart filter, 404 fallback, dismissed-set helpers. Zero imports. |
| `src/renderer/src/lib/deliveryNotice.ts` | `deliveryOutcomeNotice`: the one place a delivery pass's result becomes a card. |
| `src/renderer/src/lib/api.ts` | DTO fields, `fetchInvitees`, `postInviteeDecision`, `fetchMeetingDtos`, `EmailResultDto.sent_now`. |
| `src/renderer/src/App.tsx` | `runDeliveryPass` (replaces two copies), the hold, `awaiting_invitees`, send-later, startup resurfacing, dismissed set. |
| `src/renderer/src/screens/HomeScreen.tsx` | Pending card, `emailing` card (Q10), `Send to N invitees` on the ready card, resurfaced cards. |
| `scripts/verify-invitee-prompt.ts`, `scripts/verify-invitee-cards.ts` (new) | Plain-Node harnesses. `scripts/verify-toast-xml.ts` and `scripts/verify-email-notice.ts` are extended. |
| `package.json`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `backend.env.template`, `docs/rollout-runbook.md`, `docs/jira-progress.md` | Scripts, CI, release log line, template comment, runbook entry, evidence. |

Task order follows the dependency direction, so each layer is testable without the one above it: schema (1) → mode (2) → recipient rule (3) → state helpers (4) → endpoints (5) → email paths (6) → toast XML (7) → prompt core (8) → main wiring (9) → renderer lib (10) → delivery-pass refactor (11) → the hold and cards (12) → resurfacing (13) → CI, docs, hand-off (14).

---

### Task 0: Gate on the hardening merge, cut the branch, record the baseline

> **DONE by the controller on 22 Sep 2026; do not dispatch.** Gate: fails on `main`, passes on the integration base (`prepare_owner_folder`: 1 in the route, 4 in the test fakes). Baseline in the worktree: backend 460 passed, 2 skipped, 0 failed; `npm run typecheck` clean; `verify:toast-xml`, `verify:email-notice`, `verify:sharepoint-privacy` pass. Branch cut from `5b4fa6e`. The steps below are kept as the record of what the gate checks.

**Files:**
- Commit (already on disk, untracked): `docs/superpowers/specs/2026-09-21-in488-invitee-prompt-design.md`, `docs/superpowers/specs/in488-invitee-prompt-mockups.html`, `docs/superpowers/plans/2026-09-21-in488-invitee-prompt.md`

**Interfaces:**
- Consumes: `main` containing the merged `codex/sharepoint-permission-hardening` work.
- Produces: branch `feature/invitee-email-prompt`; a recorded baseline of backend failures to compare later runs against.

- [ ] **Step 1: Confirm the hardening has landed on `main`**

```bash
cd /c/Projects/meeting-notetaker-2
git fetch origin
git switch main
git pull --ff-only
grep -n "prepare_owner_folder" backend/app/routers/meetings.py
grep -c "prepare_owner_folder" backend/tests/test_delivery_reliability.py
```

Expected: the first `grep` prints at least one line (the route runs the privacy preflight) and the second prints a count of 1 or more (the SharePoint test fakes implement it).

Do **not** use `X-MN-User-Email` as the signal: that header already appears in `meetings.py` on a pre-hardening `main` (the audio-upload and retry routes), so it passes either way. `prepare_owner_folder` is the only discriminator.

Evidence recorded 22 Sep 2026, `main` at `998d1e4`: the gate **fails**, the hardening is unmerged. An in-memory `git merge-tree` of `codex/sharepoint-permission-hardening` into `main` conflicts in only two files, `.github/workflows/ci.yml` and `docs/jira-progress.md`, both "each side appended lines"; every code file auto-merges. That merged `backend/` passes CI's full command: 460 passed, 2 skipped.

If either check fails: **STOP. Do not cut the branch.** The hardening is not merged. Joseph ruled on 21 Sep 2026 that it goes first, because this plan's SharePoint test (Task 6, Step 9) is written against the post-hardening signature (`user_email=` on the route, `prepare_owner_folder` on the provider fakes). Report back that landing `codex/sharepoint-permission-hardening` (16 commits, ~77 behind `main`, needs a rebase) is the real next job.

- [ ] **Step 2: Record the baseline**

```bash
cd backend
/c/Projects/meeting-notetaker-2/backend/.venv/Scripts/python.exe -m pytest tests --deselect tests/test_storage_api_meetings.py::StubMeetingDeliveryTests::test_stub_serializes_concurrent_exports_for_one_meeting -q 2>&1 | tail -15
cd ..
npm run typecheck
npm run verify:toast-xml
npm run verify:email-notice
```

Expected: typecheck clean; `Toast XML verification passed`; `Email notice verification passed`. Write the backend pass/fail counts and the names of any failing tests into your task notes. Those names are the baseline: later tasks may not add to them.

- [ ] **Step 3: Cut the branch and commit the design documents (Q8, Q16)**

```bash
git switch -c feature/invitee-email-prompt
git add docs/superpowers/specs/2026-09-21-in488-invitee-prompt-design.md \
        docs/superpowers/specs/in488-invitee-prompt-mockups.html \
        docs/superpowers/plans/2026-09-21-in488-invitee-prompt.md
git status --short
```

Expected: exactly those three files staged. `tmp/`, `build/` and `scripts/list-installer-folder.mjs` stay untracked; do not add them.

```bash
git commit -m "docs(in-488): invitee email prompt spec, mock-ups and plan"
```

---

### Task 1: Invitee state on the `Meeting` model

**Files:**
- Modify: `backend/app/schemas.py` (enums after `SharePointStatus`; fields at the end of `Meeting`; models after `EmailResult`)
- Test: `backend/tests/test_invitee_decision.py` (new)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `InviteeDecision` enum: `pending`, `approved`, `declined`
  - `InviteeDeliveryStatus` enum: `not_started`, `sending`, `sent`, `unconfirmed`, `failed`
  - `InviteeDecisionSource` enum: `toast`, `app`, `timeout`
  - `Meeting.invitee_decision: InviteeDecision`, `Meeting.invitee_delivery_status: InviteeDeliveryStatus`, `Meeting.invitee_recipients: list[str]`, `Meeting.invitee_error_message: str | None`, `Meeting.invitee_error_code: str | None`
  - `InviteeCandidate(name: str | None, email: str)`
  - `InviteeDecisionRequest(approved: bool, source: InviteeDecisionSource)`
  - `InviteeState(candidates: list[InviteeCandidate], decision: InviteeDecision, invitee_delivery_status: InviteeDeliveryStatus, invitee_recipients: list[str], prompt_enabled: bool)`
  - `EmailResult.sent_now: list[str]`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_invitee_decision.py`:

```python
"""IN-488: the recording owner is asked before invitees are emailed.

The decision (pending / approved / declined) and the invitee send's own
delivery state live on the Meeting, deliberately apart from delivery_status:
the organiser's send has a hard-won state machine (IN-478), and a crash in a
later invitee-only send must never erase the record that the organiser
already received theirs.
"""

import unittest
from datetime import datetime, timezone
from uuid import uuid4

from app.schemas import (
    EmailResult,
    InviteeDecision,
    InviteeDeliveryStatus,
    Meeting,
    MeetingSource,
)


class InviteeStateSchemaTests(unittest.TestCase):
    def test_new_meeting_starts_pending_and_not_started(self):
        meeting = Meeting(
            id=uuid4(),
            title="Test",
            source=MeetingSource.online,
            owner_id="joseph",
            created_at=datetime.now(timezone.utc),
        )
        self.assertIs(meeting.invitee_decision, InviteeDecision.pending)
        self.assertIs(meeting.invitee_delivery_status, InviteeDeliveryStatus.not_started)
        self.assertEqual(meeting.invitee_recipients, [])
        self.assertIsNone(meeting.invitee_error_message)
        self.assertIsNone(meeting.invitee_error_code)

    def test_snapshot_written_before_in488_still_loads(self):
        # store.load_snapshot runs Meeting.model_validate over dicts written by
        # older app versions, which carry none of the invitee_* keys. Every
        # fleet machine has such a store.json on the day this ships.
        legacy = {
            "id": str(uuid4()),
            "title": "Recorded on v2.0.39",
            "source": "online",
            "owner_id": "joseph",
            "created_at": "2026-09-01T00:00:00Z",
            "delivery_status": "emailed",
            "delivery_recipients": ["joseph@factor1.com.au"],
        }
        meeting = Meeting.model_validate(legacy)
        self.assertIs(meeting.invitee_decision, InviteeDecision.pending)
        self.assertIs(meeting.invitee_delivery_status, InviteeDeliveryStatus.not_started)
        self.assertEqual(meeting.delivery_recipients, ["joseph@factor1.com.au"])

    def test_email_result_sent_now_defaults_empty(self):
        result = EmailResult(
            recipients=["joseph@factor1.com.au"],
            sent_at=datetime.now(timezone.utc),
        )
        self.assertEqual(result.sent_now, [])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && /c/Projects/meeting-notetaker-2/backend/.venv/Scripts/python.exe -m pytest tests/test_invitee_decision.py -q`
Expected: collection error, `ImportError: cannot import name 'InviteeDecision' from 'app.schemas'`.

- [ ] **Step 3: Add the enums**

In `backend/app/schemas.py`, directly after the `SharePointStatus` enum:

```python
class InviteeDecision(str, Enum):
    """IN-488: the recording owner's answer to "email the invitees?".

    `pending` is also what every meeting recorded before IN-488 loads as.
    A timeout is stored as `declined` (the audit entry carries the source),
    so "send later" is the same declined → approved move either way.
    """

    pending = "pending"
    approved = "approved"
    declined = "declined"


class InviteeDeliveryStatus(str, Enum):
    """State of the invitee send, kept apart from DeliveryStatus on purpose.

    DeliveryStatus clears delivery_recipients on any move out of `emailed`
    (IN-478). Sharing that machine with a later invitee-only send would let a
    crash mid-send forget the organiser already has theirs, and the next
    retry would email them again.
    """

    not_started = "not_started"
    sending = "sending"
    sent = "sent"
    unconfirmed = "unconfirmed"
    failed = "failed"


class InviteeDecisionSource(str, Enum):
    toast = "toast"
    app = "app"
    timeout = "timeout"
```

- [ ] **Step 4: Add the `Meeting` fields**

In `class Meeting`, after the `sharepoint_summary_url` field and before `recorder_audio_missing`:

```python
    # IN-488: ask-before-emailing-invitees. Stored locally like
    # delivery_status; nothing here goes to the central storage API.
    invitee_decision: InviteeDecision = InviteeDecision.pending
    invitee_delivery_status: InviteeDeliveryStatus = InviteeDeliveryStatus.not_started
    # The invitees this meeting has actually been emailed to. Only populated
    # while invitee_delivery_status is `sent`.
    invitee_recipients: list[str] = Field(default_factory=list)
    invitee_error_message: str | None = None
    invitee_error_code: str | None = None  # FailureCategory value (IN-391)
```

- [ ] **Step 5: Extend `EmailResult` and add the three models**

Replace the existing `EmailResult` class with:

```python
class EmailResult(BaseModel):
    # Everyone who has the transcript by email: organiser send + invitee send.
    recipients: list[str]
    sent_at: datetime
    # Who THIS call emailed (IN-488). Equal to `recipients` on a first send,
    # the invitees only on a later send, and empty on an idempotent replay.
    sent_now: list[str] = Field(default_factory=list)


class InviteeCandidate(BaseModel):
    """One person the owner may choose to email (IN-488)."""

    name: str | None = None
    email: str


class InviteeDecisionRequest(BaseModel):
    approved: bool
    source: InviteeDecisionSource


class InviteeState(BaseModel):
    candidates: list[InviteeCandidate]
    # The EFFECTIVE decision: reports `approved` under the `attendees` mode.
    decision: InviteeDecision
    invitee_delivery_status: InviteeDeliveryStatus
    invitee_recipients: list[str]
    # True only in `ask` mode. The desktop prompts, and offers "Send to N
    # invitees", only when this is true (spec Q2 and the 21 Sep amendment).
    prompt_enabled: bool
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend && /c/Projects/meeting-notetaker-2/backend/.venv/Scripts/python.exe -m pytest tests/test_invitee_decision.py -q`
Expected: `3 passed`.

- [ ] **Step 7: Commit**

```bash
git diff --check && git diff --stat
git add backend/app/schemas.py backend/tests/test_invitee_decision.py
git commit -m "feat(in-488): invitee decision and delivery state on the meeting model"
```

---

### Task 2: Three-value delivery mode

**Files:**
- Modify: `backend/app/services/recipient_policy.py` (add functions; `attendee_fan_out_enabled` stays until Task 3)
- Modify: `backend/app/config.py` (the `delivery_recipients` field and its comment)
- Modify: `backend.env.template` (the `MN_DELIVERY_RECIPIENTS` comment block, around line 56)
- Test: `backend/tests/test_organizer_only_delivery.py`

**Interfaces:**
- Consumes: `InviteeDecision`, `Meeting` from Task 1.
- Produces, all in `app.services.recipient_policy`:
  - `DELIVERY_MODE_ASK = "ask"`, `DELIVERY_MODE_ORGANIZER = "organizer"`, `DELIVERY_MODE_ATTENDEES = "attendees"`
  - `delivery_mode() -> str`
  - `prompt_enabled() -> bool`
  - `invitees_approved(meeting: Meeting) -> bool`

- [ ] **Step 1: Write the failing tests**

In `backend/tests/test_organizer_only_delivery.py`:

Replace the `app.schemas` import block and the `recipient_policy` import with:

```python
from app.schemas import (
    GraphMeetingAttendeeMetadata,
    GraphMeetingMetadata,
    InviteeDecision,
    ManualMeetingAttendee,
    Meeting,
    MeetingSource,
)
from app.services.recipient_policy import (
    delivery_mode,
    invitees_approved,
    prompt_enabled,
)
```

Replace the `_meeting` helper with:

```python
def _meeting(
    graph_metadata=None,
    source=MeetingSource.online,
    manual_attendees=None,
    invitee_decision=InviteeDecision.pending,
):
    return Meeting(
        id=uuid4(),
        title="Test",
        source=source,
        owner_id="organizer@factor1.com.au",
        created_at=datetime.now(timezone.utc),
        graph_metadata=graph_metadata,
        manual_attendees=manual_attendees or [],
        invitee_decision=invitee_decision,
    )
```

Replace `test_code_default_is_organizer_only` and `test_mode_parsing_is_tolerant` with:

```python
    def test_code_default_is_ask(self):
        # IN-488 (D10): an unconfigured build asks. It is still safe: in `ask`
        # nothing reaches an invitee without a stored approval. (conftest pins
        # MN_DELIVERY_RECIPIENTS=attendees for the rest of the suite.)
        env = {k: v for k, v in os.environ.items() if k != "MN_DELIVERY_RECIPIENTS"}
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(Settings(_env_file=None).delivery_recipients, "ask")

    def test_mode_parsing_is_tolerant_and_fails_closed_to_organizer(self):
        cases = (
            (" Attendees ", "attendees"),
            ("ASK", "ask"),
            ("organizer", "organizer"),
            # Unknown and blank values fail closed to TODAY's behaviour, not to
            # the prompt: a typo in a repo variable must not start emailing.
            ("anything-else", "organizer"),
            ("", "organizer"),
        )
        for raw, expected in cases:
            with self.subTest(raw=raw), _mode(raw):
                self.assertEqual(delivery_mode(), expected)

    def test_prompt_only_in_ask_mode(self):
        for raw, expected in (("ask", True), ("organizer", False), ("attendees", False)):
            with self.subTest(raw=raw), _mode(raw):
                self.assertEqual(prompt_enabled(), expected)

    def test_invitees_approved_matrix(self):
        # The 21 Sep "B" ruling: the kill switch stops ALL invitee delivery,
        # so a stored approval counts only while the mode is `ask`.
        expected = {
            ("ask", InviteeDecision.pending): False,
            ("ask", InviteeDecision.declined): False,
            ("ask", InviteeDecision.approved): True,
            ("organizer", InviteeDecision.pending): False,
            ("organizer", InviteeDecision.declined): False,
            ("organizer", InviteeDecision.approved): False,
            ("attendees", InviteeDecision.pending): True,
            ("attendees", InviteeDecision.declined): True,
            ("attendees", InviteeDecision.approved): True,
        }
        for (raw, decision), want in expected.items():
            with self.subTest(mode=raw, decision=decision.value), _mode(raw):
                meeting = _meeting(_scheduled(), invitee_decision=decision)
                self.assertEqual(invitees_approved(meeting), want)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && /c/Projects/meeting-notetaker-2/backend/.venv/Scripts/python.exe -m pytest tests/test_organizer_only_delivery.py -q`
Expected: collection error, `ImportError: cannot import name 'delivery_mode'`.

- [ ] **Step 3: Implement the mode functions**

In `backend/app/services/recipient_policy.py`, add to the imports:

```python
from app.schemas import InviteeDecision, Meeting
```

Add directly **above** `def attendee_fan_out_enabled()` (leave that function in place; Task 3 removes it once nothing calls it):

```python
# Delivery mode (IN-488, spec D10). `ask` is the code default. `organizer` is
# exactly the v2.0.29+ behaviour and therefore the kill switch. `attendees` is
# the unchanged escape hatch: everyone gets it, nobody is asked.
DELIVERY_MODE_ASK = "ask"
DELIVERY_MODE_ORGANIZER = "organizer"
DELIVERY_MODE_ATTENDEES = "attendees"
_DELIVERY_MODES = frozenset(
    {DELIVERY_MODE_ASK, DELIVERY_MODE_ORGANIZER, DELIVERY_MODE_ATTENDEES}
)


def delivery_mode() -> str:
    """The configured delivery mode, failing closed to ``organizer``.

    Anything unrecognised, including a blank value, reads as ``organizer``:
    a typo in a repo variable or a %PROGRAMDATA% override must degrade to
    today's organiser-only delivery, never to prompting or fan-out.
    """
    value = get_settings().delivery_recipients.strip().lower()
    return value if value in _DELIVERY_MODES else DELIVERY_MODE_ORGANIZER


def prompt_enabled() -> bool:
    """Whether the owner is asked about invitees at all (``ask`` mode only)."""
    return delivery_mode() == DELIVERY_MODE_ASK


def invitees_approved(meeting: Meeting) -> bool:
    """Whether this meeting's invitees may receive email and SharePoint grants.

    ``attendees``: always. ``ask``: only with a stored approval. ``organizer``:
    never, even with a stored approval (Joseph, 21 Sep 2026). The example that
    settled it: Monday "Just me" leaves a "Send to 5 invitees" button on Home;
    Tuesday the switch is flipped after an incident; Wednesday a click on that
    leftover button must send nothing. The stored decision is kept, so
    flipping back to ``ask`` restores it.
    """
    mode = delivery_mode()
    if mode == DELIVERY_MODE_ATTENDEES:
        return True
    if mode == DELIVERY_MODE_ASK:
        return meeting.invitee_decision is InviteeDecision.approved
    return False
```

- [ ] **Step 4: Move the code default**

In `backend/app/config.py`, replace the comment block above `delivery_recipients` and the field itself (the block that begins `# Temporary organiser-only delivery (David F via David A, 18 Aug 2026):`) with:

```python
    # Delivery mode (IN-488, D10). History: on 18 Aug 2026 a Notetaker
    # auto-recorded a scheduled meeting while its user was in an unrelated
    # in-person client conversation, and that transcript went to the meeting's
    # invitees; delivery became organiser-only (David F via David A).
    #   "ask"       (default) the recording owner is asked when notes are
    #               ready; no answer = organiser only.
    #   "organizer" never ask, organiser only: exactly the v2.0.29+ behaviour,
    #               which makes it the KILL SWITCH. It also blocks "Send to N
    #               invitees" and any stored approval.
    #   "attendees" invitees always receive it, nobody is asked.
    # Anything else reads as "organizer". Flip via the MN_DELIVERY_RECIPIENTS
    # repo variable + release, or per machine through the %PROGRAMDATA%
    # backend.env override with no release.
    delivery_recipients: str = "ask"
```

- [ ] **Step 5: Update the template comment**

In `backend.env.template`, replace the comment lines that describe `MN_DELIVERY_RECIPIENTS` and the commented `# MN_DELIVERY_RECIPIENTS=organizer` line with:

```
# Delivery mode (IN-488). "ask" (default): the recording owner is asked before
# invitees are emailed; no answer in 2 minutes means organiser only.
# "organizer": never ask, organiser only. This is the kill switch; it also
# blocks "Send to N invitees". "attendees": invitees always receive it.
# Anything else is treated as "organizer".
# MN_DELIVERY_RECIPIENTS=ask
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && /c/Projects/meeting-notetaker-2/backend/.venv/Scripts/python.exe -m pytest tests/test_organizer_only_delivery.py -q`
Expected: all pass. The five untouched recipient tests in that file still pass because `_email_recipients` still reads `attendee_fan_out_enabled()`, and `ask` is not `attendees`, so the old gate stays shut.

- [ ] **Step 7: Commit**

```bash
git diff --check && git diff --stat
git add backend/app/services/recipient_policy.py backend/app/config.py backend.env.template backend/tests/test_organizer_only_delivery.py
git commit -m "feat(in-488): three-value delivery mode with ask as the code default"
```

---

### Task 3: Invitee candidates and the per-meeting recipient rule

**Files:**
- Modify: `backend/app/services/recipient_policy.py` (add `invitee_candidates`; delete `attendee_fan_out_enabled`)
- Modify: `backend/app/routers/meetings.py` (import line; `_email_recipients`; `_sharepoint_recipients`)
- Test: `backend/tests/test_invitee_candidates.py` (new)
- Test: `backend/tests/test_email_recipients.py`, `backend/tests/test_organizer_only_delivery.py`

**Interfaces:**
- Consumes: `invitees_approved` (Task 2); `InviteeCandidate` (Task 1); existing `filter_deliverable(candidates, *, channel, meeting_id)`.
- Produces: `invitee_candidates(meeting: Meeting, recorder_email: str | None = None, *, channel: str = "invitees") -> list[InviteeCandidate]` in `app.services.recipient_policy`. Order is first-seen. Never contains the organiser or the recorder.

- [ ] **Step 1: Write the failing candidate tests**

Create `backend/tests/test_invitee_candidates.py`:

```python
"""IN-488: who the owner is asked about.

The list is computed backend-side because the domain allowlist lives there,
and it is the exact list the toast and the in-app card display. "5 invitees"
must always mean five OTHER people who are allowed to receive it.
"""

import unittest
from datetime import datetime, timezone
from uuid import uuid4

from app.schemas import (
    GraphMeetingAttendeeMetadata,
    GraphMeetingMetadata,
    ManualMeetingAttendee,
    Meeting,
    MeetingSource,
)
from app.services.recipient_policy import invitee_candidates


def _meeting(graph_metadata=None, source=MeetingSource.online, manual_attendees=None):
    return Meeting(
        id=uuid4(),
        title="Test",
        source=source,
        owner_id="joseph",
        created_at=datetime.now(timezone.utc),
        graph_metadata=graph_metadata,
        manual_attendees=manual_attendees or [],
    )


def _calendar(attendees, organizer="joseph@factor1.com.au"):
    return GraphMeetingMetadata(
        meeting_id="evt-1",
        organizer_email=organizer,
        attendees=attendees,
    )


def _pairs(candidates):
    return [(c.name, c.email) for c in candidates]


class InviteeCandidateTests(unittest.TestCase):
    def test_calendar_meeting_uses_graph_attendees_with_names(self):
        meeting = _meeting(
            _calendar(
                [
                    GraphMeetingAttendeeMetadata(name="David Ahlhaus", email="da@factor1.com.au"),
                    GraphMeetingAttendeeMetadata(name="Mel Tran", email="mel@factor1.com.au"),
                ]
            )
        )
        self.assertEqual(
            _pairs(invitee_candidates(meeting, "joseph@factor1.com.au")),
            [("David Ahlhaus", "da@factor1.com.au"), ("Mel Tran", "mel@factor1.com.au")],
        )

    def test_ad_hoc_recording_uses_the_attendee_picker(self):
        meeting = _meeting(
            source=MeetingSource.in_person,
            manual_attendees=[ManualMeetingAttendee(name="David Ahlhaus", email="da@factor1.com.au")],
        )
        self.assertEqual(
            _pairs(invitee_candidates(meeting, "joseph@factor1.com.au")),
            [("David Ahlhaus", "da@factor1.com.au")],
        )

    def test_organizer_and_recorder_are_never_candidates(self):
        meeting = _meeting(
            _calendar(
                [
                    GraphMeetingAttendeeMetadata(email="Organizer@Factor1.com.au"),
                    GraphMeetingAttendeeMetadata(email="recorder@factor1.com.au"),
                    GraphMeetingAttendeeMetadata(email="da@factor1.com.au"),
                ],
                organizer="organizer@factor1.com.au",
            )
        )
        self.assertEqual(
            _pairs(invitee_candidates(meeting, " Recorder@factor1.com.au ")),
            [(None, "da@factor1.com.au")],
        )

    def test_recorder_who_picked_themselves_is_excluded_from_ad_hoc(self):
        meeting = _meeting(
            source=MeetingSource.in_person,
            manual_attendees=[
                ManualMeetingAttendee(email="joseph@factor1.com.au"),
                ManualMeetingAttendee(email="da@factor1.com.au"),
            ],
        )
        self.assertEqual(
            _pairs(invitee_candidates(meeting, "joseph@factor1.com.au")),
            [(None, "da@factor1.com.au")],
        )

    def test_external_addresses_never_appear(self):
        # 7 Aug 2026: an interview transcript reached a candidate's gmail.
        meeting = _meeting(
            _calendar(
                [
                    GraphMeetingAttendeeMetadata(email="da@factor1.com.au"),
                    GraphMeetingAttendeeMetadata(email="juliannplatero@gmail.com"),
                    GraphMeetingAttendeeMetadata(email="staff@eager.com.au"),
                ]
            )
        )
        self.assertEqual(
            [c.email for c in invitee_candidates(meeting, "joseph@factor1.com.au")],
            ["da@factor1.com.au", "staff@eager.com.au"],
        )

    def test_all_external_means_no_candidates_so_no_prompt(self):
        meeting = _meeting(_calendar([GraphMeetingAttendeeMetadata(email="someone@gmail.com")]))
        self.assertEqual(invitee_candidates(meeting, "joseph@factor1.com.au"), [])

    def test_duplicates_collapse_case_insensitively_and_first_name_wins(self):
        meeting = _meeting(
            _calendar(
                [
                    GraphMeetingAttendeeMetadata(name="David Ahlhaus", email="DA@factor1.com.au"),
                    GraphMeetingAttendeeMetadata(name="D. Ahlhaus", email="da@factor1.com.au"),
                ]
            )
        )
        self.assertEqual(
            _pairs(invitee_candidates(meeting, "joseph@factor1.com.au")),
            [("David Ahlhaus", "da@factor1.com.au")],
        )

    def test_attendee_without_an_email_is_skipped_and_blank_name_is_none(self):
        meeting = _meeting(
            _calendar(
                [
                    GraphMeetingAttendeeMetadata(name="Boardroom", email=None),
                    GraphMeetingAttendeeMetadata(name="   ", email="da@factor1.com.au"),
                ]
            )
        )
        self.assertEqual(
            _pairs(invitee_candidates(meeting, "joseph@factor1.com.au")),
            [(None, "da@factor1.com.au")],
        )

    def test_calendar_branch_wins_when_manual_attendees_are_also_present(self):
        meeting = _meeting(
            _calendar([GraphMeetingAttendeeMetadata(email="da@factor1.com.au")]),
            manual_attendees=[ManualMeetingAttendee(email="mel@factor1.com.au")],
        )
        self.assertEqual(
            [c.email for c in invitee_candidates(meeting, "joseph@factor1.com.au")],
            ["da@factor1.com.au"],
        )


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && /c/Projects/meeting-notetaker-2/backend/.venv/Scripts/python.exe -m pytest tests/test_invitee_candidates.py -q`
Expected: collection error, `ImportError: cannot import name 'invitee_candidates'`.

- [ ] **Step 3: Implement `invitee_candidates`**

In `backend/app/services/recipient_policy.py`, extend the schemas import:

```python
from app.schemas import InviteeCandidate, InviteeDecision, Meeting
```

Add at the end of the file:

```python
def _clean_email(value: str | None) -> str | None:
    cleaned = (value or "").strip().lower()
    return cleaned if "@" in cleaned else None


def invitee_candidates(
    meeting: Meeting,
    recorder_email: str | None = None,
    *,
    channel: str = "invitees",
) -> list[InviteeCandidate]:
    """The other people this meeting's transcript could be emailed to (IN-488).

    Graph attendees for a calendar meeting, the attendee-picker selections for
    an ad-hoc one (the calendar branch wins when both exist, matching
    ``_sharepoint_recipients``). Never the organiser and never the recorder,
    so "5 invitees" always means five OTHER people. Everything passes the
    domain allowlist BEFORE it is counted, so an external address never
    appears in the toast or the card. First-seen order, deduped
    case-insensitively; the first name seen for an address wins.
    """
    if meeting.graph_metadata:
        source = [(a.name, a.email) for a in meeting.graph_metadata.attendees]
        organizer = _clean_email(meeting.graph_metadata.organizer_email)
    else:
        source = [(a.name, a.email) for a in meeting.manual_attendees]
        organizer = None
    excluded = {email for email in (organizer, _clean_email(recorder_email)) if email}

    names: dict[str, str | None] = {}
    for name, raw in source:
        email = _clean_email(raw)
        if email is None or email in excluded or email in names:
            continue
        names[email] = (name or "").strip() or None

    kept = filter_deliverable(list(names), channel=channel, meeting_id=meeting.id)
    return [InviteeCandidate(name=names[email], email=email) for email in kept]
```

- [ ] **Step 4: Run to verify the candidate tests pass**

Run: `cd backend && /c/Projects/meeting-notetaker-2/backend/.venv/Scripts/python.exe -m pytest tests/test_invitee_candidates.py -q`
Expected: `9 passed`.

- [ ] **Step 5: Write the failing recipient-rule tests**

In `backend/tests/test_organizer_only_delivery.py`, add these methods to `OrganizerOnlyDeliveryTests`:

```python
    def test_ask_mode_pending_is_organizer_only_everywhere(self):
        manual = [ManualMeetingAttendee(email="bb@factor1.com.au")]
        with _mode("ask"):
            self.assertEqual(
                _email_recipients(_meeting(_scheduled()), "organizer@factor1.com.au"),
                ["organizer@factor1.com.au"],
            )
            self.assertEqual(
                _sharepoint_recipients(_meeting(_scheduled())),
                ["organizer@factor1.com.au"],
            )
            ad_hoc = _meeting(source=MeetingSource.in_person, manual_attendees=manual)
            self.assertEqual(_email_recipients(ad_hoc, "recorder@factor1.com.au"), ["recorder@factor1.com.au"])
            self.assertEqual(_sharepoint_recipients(ad_hoc), [])

    def test_ask_mode_approved_fans_out_including_ad_hoc_email(self):
        # D2: ad-hoc attendees become emailable. They never were before.
        manual = [ManualMeetingAttendee(email="bb@factor1.com.au")]
        approved = InviteeDecision.approved
        with _mode("ask"):
            scheduled = _meeting(_scheduled(), invitee_decision=approved)
            self.assertEqual(
                _email_recipients(scheduled, "organizer@factor1.com.au"),
                ["bb@factor1.com.au", "jt@factor1.com.au", "organizer@factor1.com.au"],
            )
            self.assertEqual(
                _sharepoint_recipients(scheduled),
                ["bb@factor1.com.au", "jt@factor1.com.au", "organizer@factor1.com.au"],
            )
            ad_hoc = _meeting(
                source=MeetingSource.in_person, manual_attendees=manual, invitee_decision=approved
            )
            self.assertEqual(
                _email_recipients(ad_hoc, "recorder@factor1.com.au"),
                ["bb@factor1.com.au", "recorder@factor1.com.au"],
            )
            self.assertEqual(_sharepoint_recipients(ad_hoc), ["bb@factor1.com.au"])

    def test_kill_switch_ignores_a_stored_approval(self):
        # Monday "Just me", Tuesday the switch is flipped, Wednesday someone
        # clicks the leftover "Send to 5 invitees": nothing may go out.
        approved = _meeting(_scheduled(), invitee_decision=InviteeDecision.approved)
        with _mode("organizer"):
            self.assertEqual(
                _email_recipients(approved, "organizer@factor1.com.au"),
                ["organizer@factor1.com.au"],
            )
            self.assertEqual(_sharepoint_recipients(approved), ["organizer@factor1.com.au"])
```

In `backend/tests/test_email_recipients.py`, the test `test_adhoc_recording_still_emails_recorder_only` pins the rule D2 reverses ("ad-hoc never emails attendees"). It fails **by design** once the rule changes. Add these imports at the top of the file:

```python
from unittest.mock import patch

from app.config import get_settings
```

Add this helper above `class EmailRecipientTests`:

```python
def _mode(value: str):
    override = get_settings().model_copy(update={"delivery_recipients": value})
    return patch("app.services.recipient_policy.get_settings", return_value=override)
```

Replace `test_adhoc_recording_still_emails_recorder_only` with:

```python
    def _adhoc_with_two_picked(self):
        return _meeting(
            None,
            source=MeetingSource.in_person,
            manual_attendees=[
                ManualMeetingAttendee(name="David Ahlhaus", email="davidahlhaus@factor1.com.au"),
                ManualMeetingAttendee(name="Benjamin Bryant", email="benjaminbryant@factor1.com.au"),
            ],
        )

    def test_adhoc_recording_emails_recorder_only_until_approved(self):
        with _mode("ask"):
            recipients = _email_recipients(
                self._adhoc_with_two_picked(), recorder_email="recorder@factor1.com.au"
            )
        self.assertEqual(recipients, ["recorder@factor1.com.au"])

    def test_adhoc_recording_emails_picked_attendees_once_invitees_are_approved(self):
        # IN-488 D2 (Joseph, 15 Sep): "so that invited people can also get the
        # transcripts". The conftest pin is `attendees`, i.e. auto-approved.
        recipients = _email_recipients(
            self._adhoc_with_two_picked(), recorder_email="recorder@factor1.com.au"
        )
        self.assertEqual(
            recipients,
            [
                "davidahlhaus@factor1.com.au",
                "benjaminbryant@factor1.com.au",
                "recorder@factor1.com.au",
            ],
        )
```

- [ ] **Step 6: Run to verify the new rule tests fail**

Run: `cd backend && /c/Projects/meeting-notetaker-2/backend/.venv/Scripts/python.exe -m pytest tests/test_organizer_only_delivery.py tests/test_email_recipients.py -q`
Expected: FAIL. `test_ask_mode_approved_fans_out_including_ad_hoc_email` and `test_adhoc_recording_emails_picked_attendees_once_invitees_are_approved` fail because the old gate ignores the stored decision and ignores `manual_attendees` for email.

- [ ] **Step 7: Switch both recipient functions to the rule**

In `backend/app/routers/meetings.py`, replace the import line

```python
from app.services.recipient_policy import attendee_fan_out_enabled, filter_deliverable
```

with

```python
from app.services.recipient_policy import (
    filter_deliverable,
    invitee_candidates,
    invitees_approved,
)
```

Replace the whole `_email_recipients` function with:

```python
def _email_recipients(meeting: Meeting, recorder_email: str | None) -> list[str]:
    """Resolve Jira IN-93/IN-94 recipients under the IN-488 delivery rule.

    The organiser and the signed-in recorder always receive the transcript:
    Graph's ``attendees`` array excludes the organiser, so a scheduled meeting
    would otherwise email everyone *but* the person who recorded it (Jira
    IN-94/IN-119), and the recorder is the sole recipient for ad-hoc.

    Invitees (Graph attendees, or the attendee-picker selections for an ad-hoc
    recording) are added only when ``invitees_approved(meeting)``: the mode is
    ``attendees``, or the mode is ``ask`` and the owner said yes. Ad-hoc
    attendees were never emailable before IN-488 (D2).

    Every address, invitees, organiser and recorder alike, passes the delivery
    domain allowlist. Until 7 Aug 2026 this list was used verbatim, so an
    external invitee received the summary and the full transcript (see
    app/services/recipient_policy.py). First-seen order, deduped
    case-insensitively.
    """
    recipients: list[str] = []

    def _add(candidate: str | None) -> None:
        email = _normalise_email(candidate)
        if email and email not in recipients:
            recipients.append(email)

    if invitees_approved(meeting):
        for candidate in invitee_candidates(meeting, recorder_email, channel="email"):
            _add(candidate.email)

    # The organiser always receives their own transcript, even when absent
    # from the attendees array.
    if meeting.graph_metadata:
        _add(meeting.graph_metadata.organizer_email)

    # Signed-in recorder: the sole recipient for ad-hoc, and an organiser
    # safety net for calendar recordings.
    _add(recorder_email)

    return filter_deliverable(recipients, channel="email", meeting_id=meeting.id)
```

Replace the whole `_sharepoint_recipients` function with:

```python
def _sharepoint_recipients(meeting: Meeting) -> list[str]:
    """Resolve Jira IN-387 SharePoint view-access recipients (IN-488 rule).

    Invitees get a per-file view grant only when ``invitees_approved(meeting)``.
    The grant IS the sharing: it alone surfaces the file in an invitee's
    "Shared with me", so it follows the same decision as the email. Because
    the upload is a PUT by path, re-posting /sharepoint after a later approval
    overwrites the same two files and re-runs the grants; no Graph item IDs
    are stored.

    The organiser is always included for calendar meetings. The recording
    owner is not: they already have access as the identity that uploaded.
    Recipients with no usable email (rooms, unresolved externals) are skipped
    rather than failing delivery, and the result passes the delivery domain
    allowlist: on 7 Aug 2026 this function tried to share an interview
    transcript with an external candidate and was stopped only by the
    tenant's external-sharing policy (HTTP 400 sharingFailed).
    """
    recipients: list[str] = []

    def _add(candidate: str | None) -> None:
        email = _normalise_email(candidate)
        if email and email not in recipients:
            recipients.append(email)

    if invitees_approved(meeting):
        for candidate in invitee_candidates(meeting, channel="sharepoint"):
            _add(candidate.email)

    if meeting.graph_metadata:
        _add(meeting.graph_metadata.organizer_email)

    return filter_deliverable(recipients, channel="sharepoint", meeting_id=meeting.id)
```

- [ ] **Step 8: Delete the old gate**

In `backend/app/services/recipient_policy.py`, delete the whole `attendee_fan_out_enabled` function (signature, docstring and body).

Run: `grep -rn "attendee_fan_out_enabled" backend/app backend/tests`
Expected: no output.

- [ ] **Step 9: Run the delivery suite**

Run: `cd backend && /c/Projects/meeting-notetaker-2/backend/.venv/Scripts/python.exe -m pytest tests/test_delivery_reliability.py tests/test_email_idempotency.py tests/test_email_recipients.py tests/test_organizer_only_delivery.py tests/test_recipient_domain_allowlist.py tests/test_sharepoint_recipients.py tests/test_invitee_candidates.py tests/test_invitee_decision.py -q`
Expected: all pass. The allowlist tests' exact orderings (`[attendees…, organiser]`) are preserved because candidates are added before the organiser, exactly as the old loop did.

- [ ] **Step 10: Commit**

```bash
git diff --check && git diff --stat
git add backend/app/services/recipient_policy.py backend/app/routers/meetings.py backend/tests/test_invitee_candidates.py backend/tests/test_email_recipients.py backend/tests/test_organizer_only_delivery.py
git commit -m "feat(in-488): invitee candidates and a per-meeting recipient rule"
```

---

### Task 4: Invitee delivery state helpers, startup reconcile, reset on re-upload

**Files:**
- Modify: `backend/app/services/pipeline.py` (schema import block; new helpers after `set_delivery_state`; `reconcile_interrupted_pipelines`; `kick_pipeline`)
- Test: `backend/tests/test_invitee_decision.py`

**Interfaces:**
- Consumes: `InviteeDecision`, `InviteeDeliveryStatus` (Task 1).
- Produces, in `app.services.pipeline`:
  - `set_invitee_delivery_state(meeting_id: UUID, status: InviteeDeliveryStatus, error_message: str | None = None, *, error_code: str | None = None, recipients: list[str] | None = None) -> None`. `invitee_recipients` survives only in `sent`. **Never touches any `delivery_*` field.**
  - `reset_invitee_state(meeting_id: UUID) -> None`: decision → `pending`, delivery → `not_started`.
- Produces, in `backend/tests/test_invitee_decision.py`: the `_StoreIsolatedTestCase` base class that Task 5 reuses.

- [ ] **Step 1: Write the failing tests**

In `backend/tests/test_invitee_decision.py`, replace the import block at the top with:

```python
import asyncio
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from app import store
from app.schemas import (
    AccessRole,
    DeliveryStatus,
    EmailResult,
    InviteeDecision,
    InviteeDeliveryStatus,
    ManualMeetingAttendee,
    Meeting,
    MeetingAccessEntry,
    MeetingParticipant,
    MeetingSource,
    PipelineStatus,
    TranscriptSegment,
)
from app.services import pipeline
from app.services.pipeline import (
    reconcile_interrupted_pipelines,
    reset_invitee_state,
    set_delivery_state,
    set_invitee_delivery_state,
)
```

Add below `InviteeStateSchemaTests` (and above the `if __name__` guard):

```python
class _StoreIsolatedTestCase(unittest.IsolatedAsyncioTestCase):
    """A ready ad-hoc meeting owned by Joseph with two picked attendees."""

    def setUp(self):
        self._old_state = {
            "meetings": dict(store.MEETINGS),
            "access": {k: list(v) for k, v in store.ACCESS.items()},
            "summaries": dict(store.SUMMARIES),
            "participants": {k: list(v) for k, v in store.PARTICIPANTS.items()},
            "transcripts": {k: list(v) for k, v in store.TRANSCRIPTS.items()},
            "audit": list(store.AUDIT_LOG),
        }
        self.meeting_id = uuid4()
        store.MEETINGS[self.meeting_id] = Meeting(
            id=self.meeting_id,
            title="Innovations sync",
            source=MeetingSource.in_person,
            owner_id="joseph",
            created_at=datetime.now(timezone.utc),
            pipeline_status=PipelineStatus.ready,
            manual_attendees=[
                ManualMeetingAttendee(name="David Ahlhaus", email="da@factor1.com.au"),
                ManualMeetingAttendee(name="Mel Tran", email="mel@factor1.com.au"),
            ],
        )
        store.ACCESS[self.meeting_id] = [MeetingAccessEntry(user="Joseph", role=AccessRole.owner)]
        store.SUMMARIES[self.meeting_id] = "Summary."
        store.PARTICIPANTS[self.meeting_id] = [MeetingParticipant(name="Joseph Guerrero", known=True)]
        store.TRANSCRIPTS[self.meeting_id] = [
            TranscriptSegment(
                speaker="Joseph Guerrero",
                speaker_known=True,
                start_ms=0,
                end_ms=5000,
                text="Hello.",
            )
        ]

    def tearDown(self):
        store.MEETINGS.clear(); store.MEETINGS.update(self._old_state["meetings"])
        store.ACCESS.clear(); store.ACCESS.update(self._old_state["access"])
        store.SUMMARIES.clear(); store.SUMMARIES.update(self._old_state["summaries"])
        store.PARTICIPANTS.clear(); store.PARTICIPANTS.update(self._old_state["participants"])
        store.TRANSCRIPTS.clear(); store.TRANSCRIPTS.update(self._old_state["transcripts"])
        store.AUDIT_LOG[:] = self._old_state["audit"]

    def _meeting(self) -> Meeting:
        return store.MEETINGS[self.meeting_id]


class InviteeDeliveryStateTests(_StoreIsolatedTestCase):
    def test_recipients_survive_only_in_sent(self):
        invitees = ["da@factor1.com.au", "mel@factor1.com.au"]
        set_invitee_delivery_state(self.meeting_id, InviteeDeliveryStatus.sent, recipients=invitees)
        self.assertEqual(self._meeting().invitee_recipients, invitees)

        set_invitee_delivery_state(
            self.meeting_id, InviteeDeliveryStatus.failed, "boom", error_code="network"
        )
        meeting = self._meeting()
        self.assertIs(meeting.invitee_delivery_status, InviteeDeliveryStatus.failed)
        self.assertEqual(meeting.invitee_recipients, [])
        self.assertEqual(meeting.invitee_error_message, "boom")
        self.assertEqual(meeting.invitee_error_code, "network")

    def test_invitee_state_never_touches_the_organiser_record(self):
        # D7, the reason this machine exists: IN-478 clears delivery_recipients
        # on any move out of `emailed`. An invitee failure must not do that, or
        # the next retry re-emails the organiser.
        sent_at = datetime.now(timezone.utc)
        set_delivery_state(
            self.meeting_id,
            DeliveryStatus.emailed,
            recipients=["joseph@factor1.com.au"],
            emailed_at=sent_at,
        )
        for status in (
            InviteeDeliveryStatus.sending,
            InviteeDeliveryStatus.failed,
            InviteeDeliveryStatus.unconfirmed,
            InviteeDeliveryStatus.sent,
            InviteeDeliveryStatus.not_started,
        ):
            with self.subTest(status=status.value):
                set_invitee_delivery_state(self.meeting_id, status, recipients=["da@factor1.com.au"])
                meeting = self._meeting()
                self.assertIs(meeting.delivery_status, DeliveryStatus.emailed)
                self.assertEqual(meeting.delivery_recipients, ["joseph@factor1.com.au"])
                self.assertEqual(meeting.delivery_emailed_at, sent_at)

    def test_startup_reconcile_flips_stale_sending_to_unconfirmed(self):
        set_delivery_state(
            self.meeting_id,
            DeliveryStatus.emailed,
            recipients=["joseph@factor1.com.au"],
            emailed_at=datetime.now(timezone.utc),
        )
        set_invitee_delivery_state(self.meeting_id, InviteeDeliveryStatus.sending)

        reconcile_interrupted_pipelines()

        meeting = self._meeting()
        self.assertIs(meeting.invitee_delivery_status, InviteeDeliveryStatus.unconfirmed)
        self.assertIn("may already have been delivered", meeting.invitee_error_message or "")
        self.assertIsNone(meeting.invitee_error_code, "unconfirmed is not a failure category")
        self.assertIs(meeting.delivery_status, DeliveryStatus.emailed)
        self.assertEqual(meeting.delivery_recipients, ["joseph@factor1.com.au"])
        self.assertIs(meeting.pipeline_status, PipelineStatus.ready)

    def test_reset_returns_to_pending_and_not_started(self):
        store.MEETINGS[self.meeting_id] = self._meeting().model_copy(
            update={"invitee_decision": InviteeDecision.approved}
        )
        set_invitee_delivery_state(
            self.meeting_id, InviteeDeliveryStatus.sent, recipients=["da@factor1.com.au"]
        )

        reset_invitee_state(self.meeting_id)

        meeting = self._meeting()
        self.assertIs(meeting.invitee_decision, InviteeDecision.pending)
        self.assertIs(meeting.invitee_delivery_status, InviteeDeliveryStatus.not_started)
        self.assertEqual(meeting.invitee_recipients, [])

    async def test_reupload_resets_the_decision(self):
        # New content, new question: a regenerated transcript must be asked
        # about again, the same way kick_pipeline re-arms the organiser email.
        store.MEETINGS[self.meeting_id] = self._meeting().model_copy(
            update={"invitee_decision": InviteeDecision.declined}
        )
        with patch.object(pipeline, "run_pipeline", new=AsyncMock()):
            pipeline.kick_pipeline(self.meeting_id, Path("unused.webm"))
            await asyncio.sleep(0)

        meeting = self._meeting()
        self.assertIs(meeting.invitee_decision, InviteeDecision.pending)
        self.assertIs(meeting.invitee_delivery_status, InviteeDeliveryStatus.not_started)
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && /c/Projects/meeting-notetaker-2/backend/.venv/Scripts/python.exe -m pytest tests/test_invitee_decision.py -q`
Expected: collection error, `ImportError: cannot import name 'reset_invitee_state'`.

- [ ] **Step 3: Implement the helpers**

In `backend/app/services/pipeline.py`, add `InviteeDecision` and `InviteeDeliveryStatus` to the `from app.schemas import (...)` block (keep it alphabetical: after `DeliveryStatus`).

Add directly after the `set_delivery_state` function:

```python
def set_invitee_delivery_state(
    meeting_id: UUID,
    status: InviteeDeliveryStatus,
    error_message: str | None = None,
    *,
    error_code: str | None = None,
    recipients: list[str] | None = None,
) -> None:
    """Drive the invitee send's own state machine (IN-488, D7).

    Deliberately writes NO ``delivery_*`` field. ``set_delivery_state`` clears
    ``delivery_recipients`` on any move out of ``emailed``; doing that from an
    invitee failure would forget the organiser already has their copy, and the
    next retry would email them twice (the IN-478 history).
    """
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is not None:
        store.MEETINGS[meeting_id] = meeting.model_copy(
            update={
                "invitee_delivery_status": status,
                "invitee_error_message": error_message,
                "invitee_error_code": error_code,
                "invitee_recipients": (
                    list(recipients)
                    if status is InviteeDeliveryStatus.sent and recipients
                    else []
                ),
            }
        )


def reset_invitee_state(meeting_id: UUID) -> None:
    """A regenerated transcript is new content, so it gets a new question."""
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is not None:
        store.MEETINGS[meeting_id] = meeting.model_copy(
            update={
                "invitee_decision": InviteeDecision.pending,
                "invitee_delivery_status": InviteeDeliveryStatus.not_started,
                "invitee_error_message": None,
                "invitee_error_code": None,
                "invitee_recipients": [],
            }
        )
```

- [ ] **Step 4: Add the startup reconcile**

In `reconcile_interrupted_pipelines`, directly after the `if meeting.delivery_status is DeliveryStatus.emailing:` block (after its `changed += 1`) and before the `if meeting.pipeline_status not in (...)` line:

```python
        # IN-488: same reasoning for the invitee send. `sending` on disk means
        # the process died mid-send and the outcome is unknowable, so it must
        # not become `failed` ("resend safe"). Only the invitee machine moves:
        # the organiser's `emailed` record stays exactly as it was.
        if meeting.invitee_delivery_status is InviteeDeliveryStatus.sending:
            set_invitee_delivery_state(
                meeting_id,
                InviteeDeliveryStatus.unconfirmed,
                "The invitee email was interrupted by a backend restart — it "
                "may already have been delivered. Check with an invitee before "
                "resending.",
                error_code=None,
            )
            changed += 1
```

- [ ] **Step 5: Reset on re-upload**

In `kick_pipeline`, directly after the line `set_delivery_state(meeting_id, DeliveryStatus.not_started)`:

```python
    reset_invitee_state(meeting_id)
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd backend && /c/Projects/meeting-notetaker-2/backend/.venv/Scripts/python.exe -m pytest tests/test_invitee_decision.py tests/test_email_idempotency.py -q`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git diff --check && git diff --stat
git add backend/app/services/pipeline.py backend/tests/test_invitee_decision.py
git commit -m "feat(in-488): invitee delivery state machine, startup reconcile and reset on re-upload"
```

---

### Task 5: `GET /invitees` and `POST /invitees/decision`

**Files:**
- Modify: `backend/app/routers/meetings.py` (two import blocks; two routes after `save_transcript_to_sharepoint`; `_invitee_state` after `_sharepoint_recipients`)
- Test: `backend/tests/test_invitee_decision.py`

**Interfaces:**
- Consumes: `InviteeState`, `InviteeDecisionRequest`, `InviteeDecision` (Task 1); `delivery_mode`, `prompt_enabled`, `DELIVERY_MODE_ATTENDEES` (Task 2); `invitee_candidates` (Task 3); `_StoreIsolatedTestCase` (Task 4).
- Produces:
  - `GET /api/v1/meetings/{id}/invitees?recorder_email=<addr>` → `InviteeState`. Owner only (Q5). Python name `get_invitees(meeting_id, recorder_email=None, actor=Actor)`.
  - `POST /api/v1/meetings/{id}/invitees/decision` body `{approved: bool, source: "toast"|"app"|"timeout"}` → `Meeting`. Owner only. Python name `record_invitee_decision(meeting_id, body, actor=Actor)`.
  - Transitions: `pending → approved|declined` ok; `declined → approved` ok (send later); same value = no-op with no audit; **`approved → declined` = 409 always (Q4)**.

`recorder_email` travels as a query parameter because the hardening's `X-MN-User-Email` header is attached only to `POST …/sharepoint`. The desktop proxy logs `loggablePath()` (query stripped), so the address never reaches `main.log`.

- [ ] **Step 1: Write the failing tests**

In `backend/tests/test_invitee_decision.py`, add `import json` to the standard-library imports (after `import asyncio`), and add:

```python
from fastapi import HTTPException

from app.config import get_settings
from app.paths import snapshot_path
from app.routers import meetings as meetings_router
from app.schemas import InviteeDecisionRequest
```

Add this helper below the imports:

```python
def _mode(value: str):
    override = get_settings().model_copy(update={"delivery_recipients": value})
    return patch("app.services.recipient_policy.get_settings", return_value=override)
```

Add above the `if __name__` guard:

```python
class InviteeEndpointTests(_StoreIsolatedTestCase):
    async def _get(self, actor="Joseph"):
        return await meetings_router.get_invitees(
            self.meeting_id, recorder_email="joseph@factor1.com.au", actor=actor
        )

    async def _decide(self, approved: bool, source: str = "app", actor="Joseph"):
        return await meetings_router.record_invitee_decision(
            self.meeting_id,
            InviteeDecisionRequest(approved=approved, source=source),
            actor=actor,
        )

    def _decision_audits(self):
        return [
            a for a in store.AUDIT_LOG
            if a.action == "meeting.invitee_decision" and a.meeting_id == self.meeting_id
        ]

    async def test_get_reports_candidates_and_pending_in_ask_mode(self):
        with _mode("ask"):
            state = await self._get()
        self.assertEqual(
            [(c.name, c.email) for c in state.candidates],
            [("David Ahlhaus", "da@factor1.com.au"), ("Mel Tran", "mel@factor1.com.au")],
        )
        self.assertIs(state.decision, InviteeDecision.pending)
        self.assertIs(state.invitee_delivery_status, InviteeDeliveryStatus.not_started)
        self.assertEqual(state.invitee_recipients, [])
        self.assertTrue(state.prompt_enabled)

    async def test_get_reports_the_effective_decision_per_mode(self):
        with _mode("attendees"):
            state = await self._get()
            self.assertIs(state.decision, InviteeDecision.approved)
            self.assertFalse(state.prompt_enabled)
        with _mode("organizer"):
            state = await self._get()
            # The stored value is reported as is; prompt_enabled=False is what
            # tells the desktop not to ask and not to offer "Send to N".
            self.assertIs(state.decision, InviteeDecision.pending)
            self.assertFalse(state.prompt_enabled)

    async def test_get_is_owner_only(self):
        store.ACCESS[self.meeting_id] = [
            MeetingAccessEntry(user="Joseph", role=AccessRole.owner),
            MeetingAccessEntry(user="Editor", role=AccessRole.editor),
        ]
        with self.assertRaises(HTTPException) as raised:
            await self._get(actor="Editor")
        self.assertEqual(raised.exception.status_code, 403)
        with self.assertRaises(HTTPException) as raised:
            await self._get(actor="Stranger")
        self.assertEqual(raised.exception.status_code, 404)

    async def test_pending_to_approved_is_audited_with_its_source(self):
        meeting = await self._decide(True, source="toast")
        self.assertIs(meeting.invitee_decision, InviteeDecision.approved)
        audits = self._decision_audits()
        self.assertEqual(len(audits), 1)
        self.assertEqual(audits[0].before, "pending")
        self.assertEqual(audits[0].after, "approved (toast)")

    async def test_timeout_is_stored_as_declined(self):
        meeting = await self._decide(False, source="timeout")
        self.assertIs(meeting.invitee_decision, InviteeDecision.declined)
        self.assertEqual(self._decision_audits()[0].after, "declined (timeout)")

    async def test_declined_to_approved_is_the_send_later_path(self):
        await self._decide(False, source="timeout")
        meeting = await self._decide(True, source="app")
        self.assertIs(meeting.invitee_decision, InviteeDecision.approved)
        self.assertEqual(len(self._decision_audits()), 2)

    async def test_repeating_the_same_answer_is_a_silent_no_op(self):
        await self._decide(True)
        await self._decide(True)
        self.assertEqual(len(self._decision_audits()), 1)

    async def test_approved_is_final(self):
        # Q4: a timeout (or a decline) that reaches the backend after an
        # approve is rejected, whether or not the send has finished.
        await self._decide(True, source="app")
        with self.assertRaises(HTTPException) as raised:
            await self._decide(False, source="timeout")
        self.assertEqual(raised.exception.status_code, 409)
        self.assertIs(self._meeting().invitee_decision, InviteeDecision.approved)

    async def test_decision_is_persisted_on_its_own_request(self):
        # "Backend unreachable mid-pass" must not lose the answer: it hits disk
        # here, not when the snapshot middleware runs after some later call.
        await self._decide(True)
        data = json.loads(snapshot_path().read_text(encoding="utf-8"))
        self.assertEqual(
            data["meetings"][str(self.meeting_id)]["invitee_decision"], "approved"
        )

    async def test_decision_is_owner_only(self):
        store.ACCESS[self.meeting_id] = [
            MeetingAccessEntry(user="Joseph", role=AccessRole.owner),
            MeetingAccessEntry(user="Editor", role=AccessRole.editor),
        ]
        with self.assertRaises(HTTPException) as raised:
            await self._decide(True, actor="Editor")
        self.assertEqual(raised.exception.status_code, 403)
        self.assertIs(self._meeting().invitee_decision, InviteeDecision.pending)

    async def test_unknown_meeting_is_404(self):
        with self.assertRaises(HTTPException) as raised:
            await meetings_router.get_invitees(uuid4(), recorder_email=None, actor="Joseph")
        self.assertEqual(raised.exception.status_code, 404)
        with self.assertRaises(HTTPException) as raised:
            await meetings_router.record_invitee_decision(
                uuid4(), InviteeDecisionRequest(approved=True, source="app"), actor="Joseph"
            )
        self.assertEqual(raised.exception.status_code, 404)
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && /c/Projects/meeting-notetaker-2/backend/.venv/Scripts/python.exe -m pytest tests/test_invitee_decision.py -q`
Expected: FAIL with `AttributeError: module 'app.routers.meetings' has no attribute 'get_invitees'`.

- [ ] **Step 3: Extend the imports in `meetings.py`**

In the `from app.schemas import (...)` block add, in alphabetical position: `InviteeDecision`, `InviteeDecisionRequest`, `InviteeState`.

Replace the `recipient_policy` import (from Task 3) with:

```python
from app.services.recipient_policy import (
    DELIVERY_MODE_ATTENDEES,
    delivery_mode,
    filter_deliverable,
    invitee_candidates,
    invitees_approved,
    prompt_enabled,
)
```

- [ ] **Step 4: Add the two routes**

In `backend/app/routers/meetings.py`, directly after the end of `save_transcript_to_sharepoint` (after its `return updated`) and before `def _normalise_email`:

```python
@router.get("/{meeting_id}/invitees", response_model=InviteeState)
async def get_invitees(
    meeting_id: UUID,
    recorder_email: str | None = None,
    actor: str = Actor,
) -> InviteeState:
    """Who the owner would be emailing, and what they have decided (IN-488).

    Owner only: the response lists attendee email addresses. ``recorder_email``
    is excluded from the candidates so "N invitees" never counts the person
    being asked.
    """
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")
    require(meeting_id, actor, AccessRole.owner)
    return _invitee_state(meeting, recorder_email)


@router.post("/{meeting_id}/invitees/decision", response_model=Meeting)
async def record_invitee_decision(
    meeting_id: UUID,
    body: InviteeDecisionRequest,
    actor: str = Actor,
) -> Meeting:
    """Record the owner's answer to "email the invitees?" (IN-488).

    Sends nothing. The desktop follows this with its normal delivery pass
    (POST /sharepoint, then POST /email), and both read the stored decision.
    It is recorded even under the ``organizer`` kill switch, where it has no
    effect: flipping back to ``ask`` restores it.
    """
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")
    require(meeting_id, actor, AccessRole.owner)

    requested = InviteeDecision.approved if body.approved else InviteeDecision.declined
    current = meeting.invitee_decision
    if current is requested:
        return meeting
    if current is InviteeDecision.approved:
        # Approved is final (Q4). The realistic arrival here is main's timeout
        # landing a moment after the owner clicked "Email invitees".
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Invitee delivery was already approved for this meeting",
        )

    updated = meeting.model_copy(update={"invitee_decision": requested})
    store.MEETINGS[meeting_id] = updated
    logger.info(
        "invitee_decision meeting=%s decision=%s source=%s",
        meeting_id,
        requested.value,
        body.source.value,
    )
    store.add_audit(
        actor,
        "meeting.invitee_decision",
        meeting.title,
        before=current.value,
        after=f"{requested.value} ({body.source.value})",
        meeting_id=meeting_id,
    )
    # Persist on this request: the delivery pass that follows can fail or the
    # backend can be killed, and the answer must survive either.
    store.save_snapshot()
    return updated
```

- [ ] **Step 5: Add `_invitee_state`**

Directly after the end of `_sharepoint_recipients`:

```python
def _invitee_state(meeting: Meeting, recorder_email: str | None) -> InviteeState:
    # Effective decision: `attendees` auto-approves. Under `organizer` the
    # stored value is reported untouched; prompt_enabled=False is the signal
    # the desktop acts on (no prompt, no "Send to N invitees").
    effective = (
        InviteeDecision.approved
        if delivery_mode() == DELIVERY_MODE_ATTENDEES
        else meeting.invitee_decision
    )
    return InviteeState(
        candidates=invitee_candidates(meeting, recorder_email),
        decision=effective,
        invitee_delivery_status=meeting.invitee_delivery_status,
        invitee_recipients=meeting.invitee_recipients,
        prompt_enabled=prompt_enabled(),
    )
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd backend && /c/Projects/meeting-notetaker-2/backend/.venv/Scripts/python.exe -m pytest tests/test_invitee_decision.py -q`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git diff --check && git diff --stat
git add backend/app/routers/meetings.py backend/tests/test_invitee_decision.py
git commit -m "feat(in-488): invitee state and decision endpoints"
```

---

### Task 6: First-send and later-send paths in `POST /email`

**Files:**
- Modify: `backend/app/routers/meetings.py` (`email_notes` and four new helpers above it; schema and pipeline import blocks)
- Test: `backend/tests/test_email_idempotency.py`, `backend/tests/test_delivery_reliability.py`

**Interfaces:**
- Consumes: `set_invitee_delivery_state` (Task 4); `invitees_approved`, `invitee_candidates` (Tasks 2–3); `EmailResult.sent_now` (Task 1).
- Produces: `POST /email` behaviour.
  - **First send** (`delivery_status` is not `emailed`): today's machinery, recipients per the rule. If invitees are included, `invitee_delivery_status` follows along: `sending` → `sent` (with the invitee subset), `unconfirmed` on an unconfirmed send, back to `not_started` on a definitive failure. `sent_now == recipients`.
  - **Later send** (`delivery_status` is `emailed`, `invitees_approved`, invitee status not `sent`): emails the candidates **only**, drives **only** the invitee machine, audits `meeting.email_invitees`. `sent_now` = the invitees; `recipients` = everyone who has it.
  - **Replay** (anything else while `emailed`): no send, `sent_now == []`.

- [ ] **Step 1: Write the failing tests**

In `backend/tests/test_email_idempotency.py`, add to the imports:

```python
from unittest.mock import patch

from app.config import get_settings
from app.schemas import InviteeDecision, InviteeDeliveryStatus, ManualMeetingAttendee
from app.services.pipeline import set_invitee_delivery_state
```

Add this helper below the imports:

```python
def _mode(value: str):
    override = get_settings().model_copy(update={"delivery_recipients": value})
    return patch("app.services.recipient_policy.get_settings", return_value=override)
```

Add above the `if __name__` guard:

```python
class InviteeEmailPathTests(_EmailEndpointTestBase):
    """IN-488: one held send, plus a later invitee-only send that can never
    email the organiser twice."""

    INVITEES = ["da@factor1.com.au", "mel@factor1.com.au"]

    def setUp(self):
        super().setUp()
        store.MEETINGS[self.meeting_id] = store.MEETINGS[self.meeting_id].model_copy(
            update={
                "manual_attendees": [
                    ManualMeetingAttendee(name="David Ahlhaus", email="da@factor1.com.au"),
                    ManualMeetingAttendee(name="Mel Tran", email="mel@factor1.com.au"),
                ]
            }
        )
        ask = _mode("ask")
        ask.start()
        self.addCleanup(ask.stop)

    def _set_decision(self, decision: InviteeDecision) -> None:
        store.MEETINGS[self.meeting_id] = store.MEETINGS[self.meeting_id].model_copy(
            update={"invitee_decision": decision}
        )

    def _meeting(self):
        return store.MEETINGS[self.meeting_id]

    def _persisted(self, field: str):
        data = json.loads(snapshot_path().read_text(encoding="utf-8"))
        return data["meetings"][str(self.meeting_id)].get(field)

    async def test_first_send_pending_goes_to_the_organiser_only(self):
        result = await self._email()
        self.assertEqual(self.provider.sends, [["joseph@factor1.com.au"]])
        self.assertEqual(result.sent_now, ["joseph@factor1.com.au"])
        self.assertIs(self._meeting().invitee_delivery_status, InviteeDeliveryStatus.not_started)

    async def test_first_send_under_approval_is_one_email_to_everyone(self):
        self._set_decision(InviteeDecision.approved)
        result = await self._email()

        everyone = [*self.INVITEES, "joseph@factor1.com.au"]
        self.assertEqual(self.provider.sends, [everyone], "one message, one To: line (D3)")
        self.assertEqual(result.recipients, everyone)
        self.assertEqual(result.sent_now, everyone)
        meeting = self._meeting()
        self.assertIs(meeting.invitee_delivery_status, InviteeDeliveryStatus.sent)
        self.assertEqual(meeting.invitee_recipients, self.INVITEES)

        replay = await self._email()
        self.assertEqual(len(self.provider.sends), 1)
        self.assertEqual(replay.sent_now, [])

    async def test_later_send_reaches_invitees_only_and_never_the_organiser(self):
        await self._email()  # "Just me" or timeout
        self._set_decision(InviteeDecision.approved)  # "Send to 2 invitees"

        result = await self._email()

        self.assertEqual(self.provider.sends, [["joseph@factor1.com.au"], self.INVITEES])
        self.assertEqual(result.sent_now, self.INVITEES)
        self.assertEqual(result.recipients, ["joseph@factor1.com.au", *self.INVITEES])
        meeting = self._meeting()
        self.assertIs(meeting.delivery_status, DeliveryStatus.emailed)
        self.assertEqual(meeting.delivery_recipients, ["joseph@factor1.com.au"])
        self.assertIs(meeting.invitee_delivery_status, InviteeDeliveryStatus.sent)
        self.assertEqual(meeting.invitee_recipients, self.INVITEES)
        audits = [a for a in store.AUDIT_LOG if a.meeting_id == self.meeting_id]
        self.assertEqual(
            [a.action for a in audits if a.action.startswith("meeting.email")],
            ["meeting.email", "meeting.email_invitees"],
        )

        replay = await self._email()
        self.assertEqual(len(self.provider.sends), 2, "a third call sends nothing")
        self.assertEqual(replay.sent_now, [])
        self.assertEqual(replay.recipients, ["joseph@factor1.com.au", *self.INVITEES])

    async def test_later_send_failure_leaves_the_organiser_record_intact(self):
        first = await self._email()
        self._set_decision(InviteeDecision.approved)

        class RejectedProvider:
            async def send_meeting_notes(self, recipients, subject, body, **kwargs):
                raise RuntimeError("Graph sendMail failed: 400")

        meetings_router.get_email_provider = lambda token=None: RejectedProvider()
        with self.assertRaises(HTTPException) as raised:
            await self._email()
        self.assertEqual(raised.exception.status_code, 502)

        meeting = self._meeting()
        self.assertIs(meeting.delivery_status, DeliveryStatus.emailed)
        self.assertEqual(meeting.delivery_recipients, first.recipients)
        self.assertEqual(meeting.delivery_emailed_at, first.sent_at)
        self.assertIs(meeting.invitee_delivery_status, InviteeDeliveryStatus.failed)
        self.assertTrue(meeting.invitee_error_code)

        # Retry re-sends to the invitees only.
        meetings_router.get_email_provider = lambda token=None: self.provider
        await self._email()
        self.assertEqual(self.provider.sends, [["joseph@factor1.com.au"], self.INVITEES])

    async def test_later_send_unconfirmed_is_not_a_failure(self):
        await self._email()
        self._set_decision(InviteeDecision.approved)

        class UnconfirmedProvider:
            async def send_meeting_notes(self, recipients, subject, body, **kwargs):
                raise EmailDeliveryUnconfirmed("Graph sendMail timed out after 30s")

        meetings_router.get_email_provider = lambda token=None: UnconfirmedProvider()
        with self.assertRaises(HTTPException) as raised:
            await self._email()
        self.assertEqual(raised.exception.status_code, 502)

        meeting = self._meeting()
        self.assertIs(meeting.invitee_delivery_status, InviteeDeliveryStatus.unconfirmed)
        self.assertIn("may already have been delivered", meeting.invitee_error_message or "")
        self.assertIsNone(meeting.invitee_error_code)
        self.assertIs(meeting.delivery_status, DeliveryStatus.emailed)
        self.assertEqual(self._persisted("invitee_delivery_status"), "unconfirmed")

    async def test_later_send_persists_sending_before_the_graph_call(self):
        await self._email()
        self._set_decision(InviteeDecision.approved)
        seen: dict = {}
        outer = self

        class SnapshotReadingProvider:
            async def send_meeting_notes(self, recipients, subject, body, **kwargs):
                seen["invitee"] = outer._persisted("invitee_delivery_status")
                seen["organiser"] = outer._persisted("delivery_status")

        meetings_router.get_email_provider = lambda token=None: SnapshotReadingProvider()
        await self._email()

        self.assertEqual(seen, {"invitee": "sending", "organiser": "emailed"})

    async def test_later_send_conflicts_while_one_is_in_flight(self):
        await self._email()
        self._set_decision(InviteeDecision.approved)
        set_invitee_delivery_state(self.meeting_id, InviteeDeliveryStatus.sending)

        with self.assertRaises(HTTPException) as raised:
            await self._email()
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(len(self.provider.sends), 1)

    async def test_later_send_without_a_token_marks_only_the_invitee_send_failed(self):
        await self._email()
        self._set_decision(InviteeDecision.approved)

        with self.assertRaises(HTTPException) as raised:
            await meetings_router.email_notes(
                self.meeting_id,
                meetings_router.EmailRequest(recorder_email="joseph@factor1.com.au"),
                actor="Joseph",
                graph_token="",
            )
        self.assertEqual(raised.exception.status_code, 401)
        meeting = self._meeting()
        self.assertIs(meeting.invitee_delivery_status, InviteeDeliveryStatus.failed)
        self.assertEqual(meeting.invitee_error_code, "azure_signin")
        self.assertIs(meeting.delivery_status, DeliveryStatus.emailed)

    async def test_kill_switch_blocks_a_stored_approval(self):
        await self._email()
        self._set_decision(InviteeDecision.approved)

        with _mode("organizer"):
            result = await self._email()

        self.assertEqual(len(self.provider.sends), 1, "the leftover button must send nothing")
        self.assertEqual(result.sent_now, [])
        self.assertIs(self._meeting().invitee_delivery_status, InviteeDeliveryStatus.not_started)

    async def test_first_send_unconfirmed_marks_the_invitee_send_unconfirmed_too(self):
        self._set_decision(InviteeDecision.approved)

        class UnconfirmedProvider:
            async def send_meeting_notes(self, recipients, subject, body, **kwargs):
                raise EmailDeliveryUnconfirmed("Graph sendMail timed out after 30s")

        meetings_router.get_email_provider = lambda token=None: UnconfirmedProvider()
        with self.assertRaises(HTTPException):
            await self._email()

        meeting = self._meeting()
        self.assertIs(meeting.delivery_status, DeliveryStatus.unconfirmed)
        self.assertIs(meeting.invitee_delivery_status, InviteeDeliveryStatus.unconfirmed)

    async def test_first_send_definitive_failure_re_arms_the_invitee_send(self):
        self._set_decision(InviteeDecision.approved)

        class RejectedProvider:
            async def send_meeting_notes(self, recipients, subject, body, **kwargs):
                raise RuntimeError("Graph sendMail failed: 400")

        meetings_router.get_email_provider = lambda token=None: RejectedProvider()
        with self.assertRaises(HTTPException):
            await self._email()

        meeting = self._meeting()
        self.assertIs(meeting.delivery_status, DeliveryStatus.failed)
        self.assertIs(meeting.invitee_delivery_status, InviteeDeliveryStatus.not_started)
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && /c/Projects/meeting-notetaker-2/backend/.venv/Scripts/python.exe -m pytest tests/test_email_idempotency.py -q`
Expected: FAIL. `test_first_send_pending_goes_to_the_organiser_only` fails on `result.sent_now` (`[]` instead of the organiser) and `test_later_send_reaches_invitees_only_and_never_the_organiser` fails because the second call replays instead of sending.

- [ ] **Step 3: Extend the imports in `meetings.py`**

Add `InviteeDeliveryStatus` to the `from app.schemas import (...)` block. Add `set_invitee_delivery_state` to the `from app.services.pipeline import (...)` block.

- [ ] **Step 4: Add the helpers above `email_notes`**

Directly above the `@router.post("/{meeting_id}/email", ...)` decorator:

```python
_INVITEE_UNCONFIRMED_MESSAGE = (
    "The invitee email attempt was not confirmed — it may already have been "
    "delivered. Check with an invitee before resending."
)


def _merge_recipients(*groups: list[str]) -> list[str]:
    merged: list[str] = []
    for group in groups:
        for address in group:
            if address not in merged:
                merged.append(address)
    return merged


def _email_replay(meeting: Meeting, recorder_email: str | None) -> EmailResult:
    """The idempotent answer once a meeting's email work is done (IN-94).

    ``recipients`` means "everyone who has it": the organiser send plus any
    invitee send. ``sent_now`` stays empty, which is how the desktop tells a
    replay from a real send.
    """
    return EmailResult(
        recipients=_merge_recipients(
            meeting.delivery_recipients or _email_recipients(meeting, recorder_email),
            meeting.invitee_recipients,
        ),
        sent_at=meeting.delivery_emailed_at
        or meeting.pipeline_updated_at
        or datetime.now(timezone.utc),
    )


def _notes_email_payload(
    meeting: Meeting,
    meeting_id: UUID,
    note: str | None,
    participants: list,
    segments: list,
    summary: str,
    action_items: list,
) -> tuple[str, list]:
    """The HTML body and transcript attachment, identical for both sends."""
    email_body = build_meeting_notes_email_html(
        meeting_title=meeting.title,
        summary_html=store.SUMMARY_HTML.get(meeting_id),
        summary_text=summary,
        note=note,
        action_items=action_items,
    )
    transcript_text = _format_transcript(
        segments, meeting.title, participants,
        summary_text=summary,
        action_items=action_items,
        meeting=meeting,
    )
    attachments = [
        build_transcript_attachment(
            filename=f"transcript-{meeting.title[:40]}.txt",
            content=transcript_text,
        )
    ]
    return email_body, attachments


async def _send_to_invitees_later(
    meeting_id: UUID,
    meeting: Meeting,
    body: EmailRequest,
    actor: str,
    graph_token: str,
    participants: list,
    segments: list,
    summary: str,
    action_items: list,
) -> EmailResult:
    """The invitee-only send after the organiser already has theirs (IN-488).

    Drives ``invitee_delivery_status`` and nothing else. Every exit leaves
    ``delivery_status = emailed`` with ``delivery_recipients`` intact, so no
    failure here can cause the organiser to be emailed again (D7).
    """
    if meeting.invitee_delivery_status is InviteeDeliveryStatus.sending:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "The transcript is already being sent to invitees for this meeting",
        )
    already = set(meeting.delivery_recipients)
    targets = [
        candidate.email
        for candidate in invitee_candidates(meeting, body.recorder_email, channel="email")
        if candidate.email not in already
    ]
    if not targets:
        return _email_replay(meeting, body.recorder_email)

    if not graph_token:
        reason = FailureReason.for_category(
            FailureCategory.azure_signin, detail="signin_check"
        )
        log_delivery_failure(meeting_id, "email", reason, code="signin_check")
        set_invitee_delivery_state(
            meeting_id,
            InviteeDeliveryStatus.failed,
            "Outlook sign-in is required before the transcript can be sent to invitees",
            error_code=FailureCategory.azure_signin.value,
        )
        store.save_snapshot()
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Outlook sign-in is required before the transcript can be sent to invitees",
        )

    set_invitee_delivery_state(meeting_id, InviteeDeliveryStatus.sending)
    # Same durability order as the organiser send (IN-478): `sending` is on
    # disk before the Graph call, so a crash restarts into `unconfirmed`.
    store.save_snapshot()
    email_body, attachments = _notes_email_payload(
        meeting, meeting_id, body.note, participants, segments, summary, action_items
    )
    try:
        await get_email_provider(graph_token or None).send_meeting_notes(
            targets,
            f"Meeting notes: {meeting.title}",
            email_body,
            attachments=attachments,
            access_token=graph_token or None,
            content_type="HTML",
        )
    except EmailDeliveryUnconfirmed as exc:
        logger.exception("Invitee email delivery unconfirmed for %s", meeting_id)
        set_invitee_delivery_state(
            meeting_id,
            InviteeDeliveryStatus.unconfirmed,
            _INVITEE_UNCONFIRMED_MESSAGE,
            error_code=None,
        )
        store.save_snapshot()
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"Invitee email delivery unconfirmed: {exc}",
        )
    except Exception as exc:
        logger.exception("Invitee email delivery failed for %s", meeting_id)
        reason = classify(exc, stage="email")
        log_delivery_failure(meeting_id, "email", reason, code=exc.__class__.__name__)
        set_invitee_delivery_state(
            meeting_id,
            InviteeDeliveryStatus.failed,
            reason.user_sentence,
            error_code=reason.category.value,
        )
        store.save_snapshot()
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"Invitee email delivery failed: {exc}",
        )

    sent_at = datetime.now(timezone.utc)
    set_invitee_delivery_state(meeting_id, InviteeDeliveryStatus.sent, recipients=targets)
    store.save_snapshot()
    store.add_audit(
        actor,
        "meeting.email_invitees",
        meeting.title,
        after=", ".join(targets),
        meeting_id=meeting_id,
    )
    return EmailResult(
        recipients=_merge_recipients(meeting.delivery_recipients, targets),
        sent_at=sent_at,
        sent_now=targets,
    )
```

- [ ] **Step 5: Rewrite `email_notes`**

Replace the whole `email_notes` function (decorator through its final `return`) with:

```python
@router.post("/{meeting_id}/email", response_model=EmailResult)
async def email_notes(
    meeting_id: UUID,
    body: EmailRequest,
    actor: str = Actor,
    graph_token: str = Header("", alias="X-MN-Graph-Token"),
) -> EmailResult:
    """Email the transcript from the signed-in user's Outlook (IN-93/IN-94).

    Two paths (IN-488). FIRST SEND: one message to the organiser, the recorder
    and, when ``invitees_approved``, the invitees. LATER SEND: the organiser
    already has theirs and the owner has since approved, so only the invitees
    are emailed, on their own state machine. Anything else while ``emailed``
    is an idempotent replay.
    """
    require(meeting_id, actor, AccessRole.editor)
    meeting, participants, segments, summary, action_items = _delivery_artifacts(meeting_id)

    # Idempotency guard (Jira IN-94 follow-up: ad-hoc transcripts arrived
    # twice). Once emailed, a second POST must never re-send to the organiser.
    # It either sends to newly approved invitees, or replays.
    if meeting.delivery_status is DeliveryStatus.emailed:
        if (
            invitees_approved(meeting)
            and meeting.invitee_delivery_status is not InviteeDeliveryStatus.sent
        ):
            return await _send_to_invitees_later(
                meeting_id, meeting, body, actor, graph_token,
                participants, segments, summary, action_items,
            )
        return _email_replay(meeting, body.recorder_email)
    if meeting.delivery_status is DeliveryStatus.emailing:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Transcript email is already being sent for this meeting",
        )

    recipients = _email_recipients(meeting, body.recorder_email)
    if not recipients:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "No email recipients resolved — no invitee is on an allowed company domain",
        )
    # The invitees riding on this first send. Empty unless approved, which is
    # what keeps the invitee machine untouched for an organiser-only send.
    invitee_subset = (
        [
            candidate.email
            for candidate in invitee_candidates(meeting, body.recorder_email, channel="email")
            if candidate.email in recipients
        ]
        if invitees_approved(meeting)
        else []
    )
    if not graph_token:
        reason = FailureReason.for_category(
            FailureCategory.azure_signin, detail="signin_check"
        )
        log_delivery_failure(meeting_id, "email", reason, code="signin_check")
        set_delivery_state(
            meeting_id,
            DeliveryStatus.failed,
            "Outlook sign-in is required before transcript email can be sent",
            error_code=FailureCategory.azure_signin.value,
        )
        store.save_snapshot()
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Outlook sign-in is required before transcript email can be sent",
        )

    set_delivery_state(meeting_id, DeliveryStatus.emailing)
    if invitee_subset:
        set_invitee_delivery_state(meeting_id, InviteeDeliveryStatus.sending)
    # Durability before the side effect (IN-478): the snapshot middleware only
    # persists after the response, so a crash mid-send used to restart into a
    # fully re-armed not_started — and the post-capture watcher then sent a
    # second real email. With `emailing` on disk, startup reconcile flips it
    # to `unconfirmed` instead.
    store.save_snapshot()
    email_body, attachments = _notes_email_payload(
        meeting, meeting_id, body.note, participants, segments, summary, action_items
    )

    try:
        await get_email_provider(graph_token or None).send_meeting_notes(
            recipients,
            f"Meeting notes: {meeting.title}",
            email_body,
            attachments=attachments,
            access_token=graph_token or None,
            content_type="HTML",
        )
    except EmailDeliveryUnconfirmed as exc:
        # The message may have reached Graph (timeout/5xx/connection drop
        # after send). Recording `failed` here invited a duplicate resend
        # (IN-478); `unconfirmed` keeps retry open but warns the user first.
        logger.exception("Email delivery unconfirmed for %s", meeting_id)
        set_delivery_state(
            meeting_id,
            DeliveryStatus.unconfirmed,
            "The transcript email attempt was not confirmed — it may already "
            "have been delivered. Check your inbox before resending.",
            error_code=None,
        )
        if invitee_subset:
            set_invitee_delivery_state(
                meeting_id,
                InviteeDeliveryStatus.unconfirmed,
                _INVITEE_UNCONFIRMED_MESSAGE,
                error_code=None,
            )
        store.save_snapshot()
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"Email delivery unconfirmed: {exc}",
        )
    except Exception as exc:
        logger.exception("Email delivery failed for %s", meeting_id)
        reason = classify(exc, stage="email")
        log_delivery_failure(meeting_id, "email", reason, code=exc.__class__.__name__)
        set_delivery_state(
            meeting_id,
            DeliveryStatus.failed,
            reason.user_sentence,
            error_code=reason.category.value,
        )
        if invitee_subset:
            # Nobody received anything, and the retry is another FIRST send to
            # everyone, so the invitee machine simply re-arms.
            set_invitee_delivery_state(meeting_id, InviteeDeliveryStatus.not_started)
        store.save_snapshot()
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"Email delivery failed: {exc}",
        )

    sent_at = datetime.now(timezone.utc)
    set_delivery_state(meeting_id, DeliveryStatus.emailed, recipients=recipients, emailed_at=sent_at)
    if invitee_subset:
        set_invitee_delivery_state(
            meeting_id, InviteeDeliveryStatus.sent, recipients=invitee_subset
        )
    # Persist success before anything else can fail — a crash between the
    # send and the middleware snapshot would forget the email was ever sent.
    store.save_snapshot()
    store.add_audit(
        actor,
        "meeting.email",
        meeting.title,
        after=", ".join(recipients),
        meeting_id=meeting_id,
    )
    return EmailResult(recipients=recipients, sent_at=sent_at, sent_now=recipients)
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd backend && /c/Projects/meeting-notetaker-2/backend/.venv/Scripts/python.exe -m pytest tests/test_email_idempotency.py -q`
Expected: all pass, including every pre-existing IN-478 test in the file.

- [ ] **Step 7: Pin the SharePoint half of the send-later pass**

This step adds a test that is expected to **pass immediately**: Task 3 already changed `_sharepoint_recipients`. It pins the claim the whole design leans on (D4, and "no item IDs are stored"): re-posting `/sharepoint` after a later approval overwrites the same two files and grants the invitees. If it fails, Task 3 is wrong.

In `backend/tests/test_delivery_reliability.py`, add `from app.config import get_settings` to the imports, add `InviteeDecision` to the `from app.schemas import (...)` block, and add below the imports:

```python
def _delivery_mode(value: str):
    override = get_settings().model_copy(update={"delivery_recipients": value})
    return patch("app.services.recipient_policy.get_settings", return_value=override)
```

Add to `DeliveryReliabilityTests`:

```python
    async def test_sharepoint_repost_after_a_later_approval_grants_the_invitees(self):
        uploads = []
        grants = []
        meetings_router.get_sharepoint_provider = (
            lambda token=None: CaptureSharePointProvider(uploads, grants)
        )

        async def save():
            # Post-hardening signature (Task 0 gate): the owner email header.
            await meetings_router.save_transcript_to_sharepoint(
                self.meeting_id,
                actor="Joseph",
                graph_token="token",
                user_email="joseph@factor1.com.au",
            )

        with _delivery_mode("ask"):
            await save()  # held decision answered "Just me": nobody is granted
            self.assertEqual([g["recipients"] for g in grants], [[], []])

            store.MEETINGS[self.meeting_id] = store.MEETINGS[self.meeting_id].model_copy(
                update={"invitee_decision": InviteeDecision.approved}
            )
            await save()  # "Send to 1 invitee"

        self.assertEqual(
            [g["recipients"] for g in grants[2:]],
            [["benjamin@factor1.com.au"], ["benjamin@factor1.com.au"]],
        )
        # A PUT by path: the same two files are overwritten, not duplicated.
        self.assertEqual(
            [u["filename"] for u in uploads[:2]], [u["filename"] for u in uploads[2:]]
        )
```

Run: `cd backend && /c/Projects/meeting-notetaker-2/backend/.venv/Scripts/python.exe -m pytest tests/test_delivery_reliability.py -q`
Expected: all pass.

- [ ] **Step 8: Run the delivery suite, then the full backend**

Run the delivery suite command from "Verification commands", then the full backend command.
Expected: delivery suite all green; full backend shows no failing test that was not in the Task 0 baseline.

- [ ] **Step 9: Lint**

Run: `cd backend && uvx ruff check app tests`
Expected: no new findings in the files this plan touched. `ruff` is not in the shared venv and must not be installed there; `uvx` runs it from a throwaway environment.

- [ ] **Step 10: Commit**

```bash
git diff --check && git diff --stat
git add backend/app/routers/meetings.py backend/tests/test_email_idempotency.py backend/tests/test_delivery_reliability.py
git commit -m "feat(in-488): held first send and an invitee-only later send that never re-emails the organiser"
```

---

### Task 7: Toast XML and the `?meeting=` action parser

**Files:**
- Modify: `src/main/toast-xml.ts`
- Test: `scripts/verify-toast-xml.ts`

**Interfaces:**
- Consumes: existing `toastUri`, `xmlEscape`, `TOAST_LIFETIME_MS`.
- Produces, in `src/main/toast-xml.ts`:
  - `type InviteeToastVerb = 'invitees-approve' | 'invitees-decline'` (added to the `ToastAction` union)
  - `inviteeToastUri(verb: InviteeToastVerb, meetingId: string): string`
  - `interface ParsedToastAction { action: ToastAction; meetingId: string | null }`
  - `parseToastArgv(argv: readonly string[]): ParsedToastAction | null`
  - `toastActionFromArgv` keeps its signature and now delegates to `parseToastArgv`
  - `inviteeToastLines(title: string, names: readonly string[]): string[]` (2 lines for one invitee, otherwise 3)
  - `buildInviteePromptToastXml(input: { meetingId: string; title: string; names: readonly string[] }): string`

- [ ] **Step 1: Write the failing harness assertions**

In `scripts/verify-toast-xml.ts`, add `buildInviteePromptToastXml`, `inviteeToastLines`, `inviteeToastUri` and `parseToastArgv` to the import from `'../src/main/toast-xml'`. Add directly above the final `console.log`:

```ts
// IN-488 invitee prompt: "Notes ready" + the question + up to three names.
// Unlike every toast above, more than one can be up at once (an ad-hoc upload
// and a scheduled meeting finishing together), so the buttons carry the
// meeting id as a query and the parser learns to read it.
{
  const meetingId = '3f0c1f4e-9a57-4b0e-8d5a-0c6f1f6f2a11'
  const five = ['David Ahlhaus', 'Priya Nair', 'Sam Whitfield', 'Alex Morgan', 'Jordan Lee']

  assert.deepEqual(inviteeToastLines('Innovations sync', five), [
    'Notes ready: Innovations sync',
    'Email the transcript to 5 invitees?',
    'David Ahlhaus, Priya Nair, Sam Whitfield +2 more'
  ])
  assert.deepEqual(
    inviteeToastLines('Innovations sync', five.slice(0, 3))[2],
    'David Ahlhaus, Priya Nair, Sam Whitfield',
    'exactly three names: no "+0 more"'
  )
  assert.deepEqual(inviteeToastLines('Innovations sync', five.slice(0, 2)), [
    'Notes ready: Innovations sync',
    'Email the transcript to 2 invitees?',
    'David Ahlhaus, Priya Nair'
  ])
  assert.deepEqual(
    inviteeToastLines('Innovations sync', ['David Ahlhaus']),
    ['Notes ready: Innovations sync', 'Email the transcript to David Ahlhaus?'],
    'one invitee: singular wording, and the name is not repeated on a third line (Q6)'
  )
  assert.equal(inviteeToastLines('', five)[0], 'Notes ready', 'no title: no dangling colon')

  const xml = buildInviteePromptToastXml({ meetingId, title: 'Innovations sync', names: five })
  assert.match(xml, /<toast[^>]*scenario="reminder"/, 'sticky; the runtime closes it after TOAST_LIFETIME_MS')
  assert.match(xml, /launch="notetaker:\/\/open"/, 'body click opens the app')
  assert.match(xml, /<audio silent="true"\/>/, 'silent: the chime comes from the renderer')
  assert.equal((xml.match(/<text>/g) ?? []).length, 3, 'three text lines is the Windows limit')
  assert.match(
    xml,
    new RegExp(
      `<action content="Email invitees" activationType="protocol" arguments="notetaker://invitees-approve\\?meeting=${meetingId}"/>`
    )
  )
  assert.match(
    xml,
    new RegExp(
      `<action content="Just me" activationType="protocol" arguments="notetaker://invitees-decline\\?meeting=${meetingId}"/>`
    )
  )
  assert.doesNotMatch(xml, /activationType="foreground"/, 'IN-483: no dead foreground buttons')

  const escaped = buildInviteePromptToastXml({
    meetingId,
    title: 'Q&A <Board>',
    names: ['O"Brien & Co', 'Sam']
  })
  assert.match(escaped, /Notes ready: Q&amp;A &lt;Board&gt;/, 'title is XML-escaped')
  assert.match(escaped, /O&quot;Brien &amp; Co, Sam/, 'names are XML-escaped')
  assert.doesNotMatch(escaped, /<Board>/, 'raw angle brackets never reach the toast XML')

  assert.equal(inviteeToastUri('invitees-approve', meetingId), `notetaker://invitees-approve?meeting=${meetingId}`)
  assert.deepEqual(parseToastArgv(['exe', inviteeToastUri('invitees-approve', meetingId)]), {
    action: 'invitees-approve',
    meetingId
  })
  assert.deepEqual(
    parseToastArgv(['exe', `notetaker://invitees-decline/?meeting=${meetingId}`]),
    { action: 'invitees-decline', meetingId },
    'Windows can normalise a slash in before the query'
  )
  assert.equal(parseToastArgv(['exe', 'notetaker://invitees-approve']), null, 'no meeting id: ignored, never guessed')
  assert.equal(parseToastArgv(['exe', 'notetaker://invitees-approve?meeting=']), null, 'blank meeting id: ignored')
  assert.deepEqual(parseToastArgv(['exe', toastUri('extend')]), { action: 'extend', meetingId: null }, 'bare URIs still parse')
  assert.deepEqual(parseToastArgv(['exe', 'mn-open']), { action: 'open', meetingId: null }, 'legacy mn-* still parse')
  assert.equal(toastActionFromArgv(['exe', inviteeToastUri('invitees-decline', meetingId)]), 'invitees-decline')
  assert.equal(parseToastArgv(['exe', '--background']), null)
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run verify:toast-xml`
Expected: esbuild error, `No matching export in "src/main/toast-xml.ts" for import "buildInviteePromptToastXml"`.

- [ ] **Step 3: Implement**

In `src/main/toast-xml.ts`, replace the `ToastAction` type with:

```ts
/** IN-488 invitee prompt buttons. Unlike the other actions these carry a
 *  `?meeting=<id>` query, because more than one prompt can be up at once. */
export type InviteeToastVerb = 'invitees-approve' | 'invitees-decline'

export type ToastAction =
  | 'open'
  | 'extend'
  | 'update-restart'
  | 'update-defer'
  | 'upload-now'
  | 'resume-recording'
  | 'record-now'
  | InviteeToastVerb
```

Replace the whole `toastActionFromArgv` function (keep its doc comment, and append the sentence shown) with:

```ts
const INVITEE_TOAST_VERBS: readonly InviteeToastVerb[] = ['invitees-approve', 'invitees-decline']

export function inviteeToastUri(verb: InviteeToastVerb, meetingId: string): string {
  return `${toastUri(verb)}?meeting=${encodeURIComponent(meetingId)}`
}

export interface ParsedToastAction {
  action: ToastAction
  /** Set only for the invitee prompt's buttons; null for every bare action. */
  meetingId: string | null
}

function bareToastAction(arg: string): ToastAction | null {
  if (arg === toastUri('extend') || arg === 'mn-extend') return 'extend'
  if (arg === toastUri('update-restart') || arg === 'mn-update-restart') return 'update-restart'
  if (arg === toastUri('update-defer') || arg === 'mn-update-defer') return 'update-defer'
  if (arg === toastUri('open') || arg === 'mn-open') return 'open'
  if (arg === toastUri('upload-now')) return 'upload-now'
  if (arg === toastUri('resume-recording')) return 'resume-recording'
  if (arg === toastUri('record-now')) return 'record-now'
  return null
}

/**
 * Extract the toast action, and for the invitee prompt its meeting id, from a
 * process argv. Understands the current `notetaker://<action>` URIs and the
 * legacy `mn-*` foreground arguments (still emitted by toasts shown by app
 * versions before the IN-483 fix, which can outlive the update that fixes
 * them). An invitee URI without a usable meeting id is ignored, never guessed:
 * answering the wrong meeting would email the wrong people.
 */
export function parseToastArgv(argv: readonly string[]): ParsedToastAction | null {
  for (const raw of argv) {
    const queryAt = raw.indexOf('?')
    const head = (queryAt === -1 ? raw : raw.slice(0, queryAt)).replace(/\/$/, '')
    const bare = bareToastAction(head)
    if (bare) return { action: bare, meetingId: null }
    const verb = INVITEE_TOAST_VERBS.find((candidate) => head === toastUri(candidate))
    if (!verb || queryAt === -1) continue
    const meetingId = (new URLSearchParams(raw.slice(queryAt + 1)).get('meeting') ?? '').replace(/\/$/, '')
    if (meetingId) return { action: verb, meetingId }
  }
  return null
}

/** The action alone, for callers that do not need a meeting id. */
export function toastActionFromArgv(argv: readonly string[]): ToastAction | null {
  return parseToastArgv(argv)?.action ?? null
}
```

Add directly above the `TOAST_LIFETIME_MS` doc comment:

```ts
const INVITEE_TOAST_NAME_LIMIT = 3

/**
 * The invitee prompt's text lines (IN-488, D9). A Windows toast is three short
 * lines with no hover text, so: the first three names, then "+N more"; the
 * full list lives on the in-app card. One invitee reads as a sentence about
 * that person, and the name is not repeated on a third line (Q6).
 */
export function inviteeToastLines(title: string, names: readonly string[]): string[] {
  const headline = title ? `Notes ready: ${title}` : 'Notes ready'
  if (names.length === 1) return [headline, `Email the transcript to ${names[0]}?`]
  const shown = names.slice(0, INVITEE_TOAST_NAME_LIMIT).join(', ')
  const extra = names.length - INVITEE_TOAST_NAME_LIMIT
  return [
    headline,
    `Email the transcript to ${names.length} invitees?`,
    extra > 0 ? `${shown} +${extra} more` : shown
  ]
}

/**
 * "Notes ready. Email the transcript to N invitees?" (IN-488). Sticky like the
 * others; invitee-prompt closes it after TOAST_LIFETIME_MS, and that expiry
 * fires the safe default (organiser only), the same shape as the
 * paused-recording grace toast. Both buttons render grey: Windows does not let
 * an app style one as primary, so the wording carries the emphasis.
 */
export function buildInviteePromptToastXml(input: {
  meetingId: string
  title: string
  names: readonly string[]
}): string {
  const text = inviteeToastLines(input.title, input.names)
    .map((line) => `<text>${xmlEscape(line)}</text>`)
    .join('')
  const approve = xmlEscape(inviteeToastUri('invitees-approve', input.meetingId))
  const decline = xmlEscape(inviteeToastUri('invitees-decline', input.meetingId))
  return (
    `<toast scenario="reminder" activationType="protocol" launch="${toastUri('open')}">` +
    `<visual><binding template="ToastGeneric">${text}</binding></visual>` +
    '<audio silent="true"/>' +
    '<actions>' +
    `<action content="Email invitees" activationType="protocol" arguments="${approve}"/>` +
    `<action content="Just me" activationType="protocol" arguments="${decline}"/>` +
    '</actions>' +
    '</toast>'
  )
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run verify:toast-xml && npm run typecheck`
Expected: `Toast XML verification passed`; typecheck clean. (`index.ts` still calls `toastActionFromArgv`; its wider return type is handled in Task 9.)

- [ ] **Step 5: Commit**

```bash
git diff --check && git diff --stat
git add src/main/toast-xml.ts scripts/verify-toast-xml.ts
git commit -m "feat(in-488): invitee prompt toast XML and a meeting-aware toast action parser"
```

---

### Task 8: The pure prompt engine

**Files:**
- Create: `src/main/invitee-prompt-core.ts`
- Create: `scripts/verify-invitee-prompt.ts`
- Modify: `package.json` (one script)

**Interfaces:**
- Consumes: `TOAST_LIFETIME_MS` from `./toast-xml` (pure, so the bundle stays Electron-free).
- Produces, in `src/main/invitee-prompt-core.ts`:
  - `interface InviteePromptCandidate { name: string | null; email: string }`
  - `interface InviteePromptRequest { meetingId: string; title: string; candidates: InviteePromptCandidate[] }`
  - `type InviteeDecisionSource = 'toast' | 'app' | 'timeout'`
  - `interface InviteeDecisionMessage { meetingId: string; approved: boolean; source: InviteeDecisionSource }`
  - `interface InviteePromptDeps { showToast; playChime; sendDecision; timers; log; lifetimeMs? }`
  - `interface InviteePromptEngine { show(request): void; answerFromToast(meetingId, approved): void; closeFromApp(meetingId): void; dispose(): void; openCount(): number }`
  - `createInviteePromptEngine(deps: InviteePromptDeps): InviteePromptEngine`
  - `inviteeDisplayNames(candidates): string[]` (name, else the address)
  - `parseInviteePromptRequest(value: unknown): InviteePromptRequest | null`

The timer is the hold's backstop and runs **whether or not the toast could be shown**: if Windows refuses the toast, the in-app card is still up, and delivery must not wait forever.

- [ ] **Step 1: Add the script**

In `package.json`, add after the `verify:join-watch` line:

```json
    "verify:invitee-prompt": "esbuild scripts/verify-invitee-prompt.ts --bundle --platform=node --format=cjs --outfile=out/verify-invitee-prompt.cjs --log-level=error --external:electron && node out/verify-invitee-prompt.cjs",
```

- [ ] **Step 2: Write the failing harness**

Create `scripts/verify-invitee-prompt.ts`:

```ts
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createInviteePromptEngine,
  inviteeDisplayNames,
  parseInviteePromptRequest,
  type InviteeDecisionMessage,
  type InviteePromptRequest
} from '../src/main/invitee-prompt-core'
import { TOAST_LIFETIME_MS } from '../src/main/toast-xml'

// IN-488: the main-process half of "ask before emailing invitees". The engine
// owns one toast + one timer per meeting. Whatever happens first (a toast
// button, the in-app card, or the timer) resolves that meeting exactly once,
// and the timer's answer is always the safe default: organiser only.

function harness(opts: { toastFails?: boolean; lifetimeMs?: number } = {}) {
  let seq = 0
  let now = 0
  const pending = new Map<number, { fn: () => void; at: number }>()
  const decisions: InviteeDecisionMessage[] = []
  const logs: string[] = []
  const shown: string[] = []
  const closed: string[] = []
  let chimes = 0
  const engine = createInviteePromptEngine({
    showToast: (request) => {
      if (opts.toastFails) return null
      shown.push(request.meetingId)
      return () => closed.push(request.meetingId)
    },
    playChime: () => {
      chimes += 1
    },
    sendDecision: (message) => decisions.push(message),
    timers: {
      setTimeout: (fn, ms) => {
        const id = ++seq
        pending.set(id, { fn, at: now + ms })
        return id
      },
      clearTimeout: (handle) => {
        pending.delete(handle as number)
      }
    },
    log: (_level, message) => logs.push(message),
    lifetimeMs: opts.lifetimeMs
  })
  const advance = (ms: number): void => {
    now += ms
    for (const [id, timer] of [...pending]) {
      if (timer.at <= now) {
        pending.delete(id)
        timer.fn()
      }
    }
  }
  return { engine, decisions, logs, shown, closed, advance, chimes: () => chimes, timers: () => pending.size }
}

// A function declaration, not `const request = (…): T => ({…})`: directly after
// harness()'s one-line object return, TypeScript 5.9 mis-parses that arrow's
// object literal as a parameter pattern (TS1003). esbuild does not, so the
// harness would run but `npm run typecheck` style checks would reject it.
function request(meetingId: string): InviteePromptRequest {
  return {
    meetingId,
    title: 'Innovations sync',
    candidates: [{ name: 'David Ahlhaus', email: 'da@factor1.com.au' }]
  }
}

// ---- bundle purity ---------------------------------------------------------
{
  const bundle = join(process.cwd(), 'out', 'verify-invitee-prompt.cjs')
  if (existsSync(bundle)) {
    const src = readFileSync(bundle, 'utf8')
    assert.ok(!/require\(["']electron["']\)/.test(src), 'invitee-prompt-core must not import electron')
  }
}

// ---- show ------------------------------------------------------------------
{
  const h = harness()
  h.engine.show(request('m1'))
  assert.deepEqual(h.shown, ['m1'])
  assert.equal(h.chimes(), 1, 'the chime accompanies a toast that rendered')
  assert.equal(h.engine.openCount(), 1)
  assert.deepEqual(h.decisions, [], 'showing the prompt decides nothing')
  assert.ok(h.logs.includes('[invitee-prompt] shown'))
}

// ---- toast answer ----------------------------------------------------------
{
  const h = harness()
  h.engine.show(request('m1'))
  h.engine.answerFromToast('m1', true)
  assert.deepEqual(h.decisions, [{ meetingId: 'm1', approved: true, source: 'toast' }])
  assert.deepEqual(h.closed, ['m1'], 'the toast is closed')
  assert.equal(h.timers(), 0, 'the timer is cancelled')
  h.advance(TOAST_LIFETIME_MS * 2)
  assert.equal(h.decisions.length, 1, 'no timeout follows an answer')
  assert.ok(h.logs.includes('[invitee-prompt] answered'))
}

// ---- timeout = the safe default ---------------------------------------------
{
  const h = harness()
  h.engine.show(request('m1'))
  h.advance(TOAST_LIFETIME_MS - 1)
  assert.deepEqual(h.decisions, [], 'not before the lifetime')
  h.advance(1)
  assert.deepEqual(h.decisions, [{ meetingId: 'm1', approved: false, source: 'timeout' }])
  assert.deepEqual(h.closed, ['m1'])
  assert.equal(h.engine.openCount(), 0)
  assert.ok(h.logs.includes('[invitee-prompt] timeout'))
}

// ---- default lifetime is the app standard, not a new constant ---------------
{
  const h = harness()
  h.engine.show(request('m1'))
  h.advance(2 * 60_000)
  assert.equal(h.decisions.length, 1, 'default lifetime is TOAST_LIFETIME_MS (2 min)')
}

// ---- in-app answer cancels the timer and sends nothing ----------------------
{
  const h = harness()
  h.engine.show(request('m1'))
  h.engine.closeFromApp('m1')
  assert.deepEqual(h.closed, ['m1'])
  h.advance(TOAST_LIFETIME_MS * 2)
  assert.deepEqual(h.decisions, [], 'the renderer already has its own answer')
}

// ---- stale click ------------------------------------------------------------
{
  const h = harness()
  h.engine.show(request('m1'))
  h.advance(TOAST_LIFETIME_MS)
  h.engine.answerFromToast('m1', true)
  assert.deepEqual(
    h.decisions,
    [{ meetingId: 'm1', approved: false, source: 'timeout' }],
    'a toast that lingered in Action Center after the timer fired cannot send anything'
  )
  assert.ok(h.logs.includes('[invitee-prompt] stale-click'))
}

// ---- two meetings are independent -------------------------------------------
{
  const h = harness()
  h.engine.show(request('m1'))
  h.advance(60_000)
  h.engine.show(request('m2'))
  assert.equal(h.engine.openCount(), 2)
  h.engine.answerFromToast('m2', true)
  h.advance(60_000)
  assert.deepEqual(h.decisions, [
    { meetingId: 'm2', approved: true, source: 'toast' },
    { meetingId: 'm1', approved: false, source: 'timeout' }
  ])
}

// ---- a toast that cannot be shown still times out ---------------------------
{
  const h = harness({ toastFails: true })
  h.engine.show(request('m1'))
  assert.equal(h.chimes(), 0, 'no chime without a toast')
  assert.equal(h.engine.openCount(), 1, 'the hold still has its backstop')
  h.advance(TOAST_LIFETIME_MS)
  assert.deepEqual(h.decisions, [{ meetingId: 'm1', approved: false, source: 'timeout' }])
}

// ---- re-showing the same meeting replaces, never doubles --------------------
{
  const h = harness()
  h.engine.show(request('m1'))
  h.engine.show(request('m1'))
  assert.deepEqual(h.closed, ['m1'], 'the first toast is closed')
  assert.equal(h.timers(), 1, 'one timer')
  h.advance(TOAST_LIFETIME_MS)
  assert.equal(h.decisions.length, 1, 'one timeout')
}

// ---- dispose ----------------------------------------------------------------
{
  const h = harness()
  h.engine.show(request('m1'))
  h.engine.dispose()
  h.advance(TOAST_LIFETIME_MS * 2)
  assert.deepEqual(h.decisions, [], 'quitting decides nothing: the card resurfaces on next launch')
  assert.equal(h.engine.openCount(), 0)
}

// ---- display names and IPC payload validation -------------------------------
{
  assert.deepEqual(
    inviteeDisplayNames([
      { name: 'David Ahlhaus', email: 'da@factor1.com.au' },
      { name: null, email: 'mel@factor1.com.au' },
      { name: '  ', email: 'sam@factor1.com.au' }
    ]),
    ['David Ahlhaus', 'mel@factor1.com.au', 'sam@factor1.com.au']
  )
  assert.deepEqual(parseInviteePromptRequest(request('m1')), request('m1'))
  assert.equal(parseInviteePromptRequest(null), null)
  assert.equal(parseInviteePromptRequest({ meetingId: '', title: 't', candidates: [] }), null)
  assert.equal(
    parseInviteePromptRequest({ meetingId: 'm1', title: 't', candidates: [] }),
    null,
    'nobody to ask about: there is no prompt'
  )
  assert.equal(parseInviteePromptRequest({ meetingId: 'm1', title: 't', candidates: [{ name: 'x' }] }), null)
  assert.deepEqual(
    parseInviteePromptRequest({ meetingId: 'm1', candidates: [{ email: 'a@factor1.com.au' }] }),
    { meetingId: 'm1', title: '', candidates: [{ name: null, email: 'a@factor1.com.au' }] },
    'missing title and name are normalised, not rejected'
  )
}

console.log('Invitee prompt verification passed')
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm run verify:invitee-prompt`
Expected: esbuild error, `Could not resolve "../src/main/invitee-prompt-core"`.

- [ ] **Step 4: Implement the core**

Create `src/main/invitee-prompt-core.ts`:

```ts
/**
 * Invitee prompt engine (IN-488): the main-process half of "ask before
 * emailing invitees".
 *
 * Pure on purpose: no Electron, no logger, no clock of its own, so the verify
 * script can drive it under plain Node (same shape as join-watch-core). The
 * runtime (invitee-prompt.ts) injects the real toast, chime, IPC relay and
 * timers.
 *
 * One entry per meeting, because two meetings can finish close together (an
 * ad-hoc upload and a scheduled one). Whatever happens first resolves the
 * entry exactly once: a toast button, the in-app card, or the timer. The
 * timer's answer is always the safe default, organiser only, the same pattern
 * as the paused-recording grace toast.
 */

import { TOAST_LIFETIME_MS } from './toast-xml'

export interface InviteePromptCandidate {
  name: string | null
  email: string
}

export interface InviteePromptRequest {
  meetingId: string
  title: string
  candidates: InviteePromptCandidate[]
}

export type InviteeDecisionSource = 'toast' | 'app' | 'timeout'

export interface InviteeDecisionMessage {
  meetingId: string
  approved: boolean
  source: InviteeDecisionSource
}

export interface InviteePromptTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type InviteePromptLog = (
  level: 'info' | 'warn',
  message: string,
  context?: Record<string, unknown>
) => void

export interface InviteePromptDeps {
  /** Show the OS toast. Returns a function that closes it, or null when it
   *  could not be shown (unsupported, or the OS refused). May throw. */
  showToast: (request: InviteePromptRequest) => (() => void) | null
  playChime: () => void
  /** Relay a decision to the renderer, which owns the delivery pass. */
  sendDecision: (message: InviteeDecisionMessage) => void
  timers: InviteePromptTimers
  log: InviteePromptLog
  lifetimeMs?: number
}

export interface InviteePromptEngine {
  show(request: InviteePromptRequest): void
  /** A toast button was clicked. Ignored when no prompt is open for it. */
  answerFromToast(meetingId: string, approved: boolean): void
  /** The owner answered on the in-app card: close up, send nothing. */
  closeFromApp(meetingId: string): void
  dispose(): void
  openCount(): number
}

/** What the toast shows for each person: their name, else their address. */
export function inviteeDisplayNames(candidates: readonly InviteePromptCandidate[]): string[] {
  return candidates.map((candidate) => candidate.name?.trim() || candidate.email)
}

/** Validate a `delivery:prompt-invitees` payload. IPC input is untrusted
 *  shape-wise, and an empty candidate list means there is nothing to ask. */
export function parseInviteePromptRequest(value: unknown): InviteePromptRequest | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { meetingId?: unknown; title?: unknown; candidates?: unknown }
  if (typeof raw.meetingId !== 'string' || !raw.meetingId) return null
  if (!Array.isArray(raw.candidates) || raw.candidates.length === 0) return null
  const candidates: InviteePromptCandidate[] = []
  for (const entry of raw.candidates) {
    if (!entry || typeof entry !== 'object') return null
    const candidate = entry as { name?: unknown; email?: unknown }
    if (typeof candidate.email !== 'string' || !candidate.email) return null
    candidates.push({
      name: typeof candidate.name === 'string' ? candidate.name : null,
      email: candidate.email
    })
  }
  return {
    meetingId: raw.meetingId,
    title: typeof raw.title === 'string' ? raw.title : '',
    candidates
  }
}

interface OpenPrompt {
  closeToast: (() => void) | null
  timer: unknown
}

export function createInviteePromptEngine(deps: InviteePromptDeps): InviteePromptEngine {
  const lifetimeMs = deps.lifetimeMs ?? TOAST_LIFETIME_MS
  const open = new Map<string, OpenPrompt>()

  /** Remove the entry, cancel its timer, close its toast. Null when there is
   *  none, which is how a stale click and a double answer are both caught. */
  const take = (meetingId: string): OpenPrompt | null => {
    const entry = open.get(meetingId)
    if (!entry) return null
    open.delete(meetingId)
    deps.timers.clearTimeout(entry.timer)
    try {
      entry.closeToast?.()
    } catch {
      // Already gone (dismissed by the user or by Windows): nothing to do.
    }
    return entry
  }

  return {
    show(request) {
      const { meetingId } = request
      take(meetingId)
      let closeToast: (() => void) | null = null
      try {
        closeToast = deps.showToast(request)
      } catch (err) {
        deps.log('warn', '[invitee-prompt] toast failed', {
          meetingId,
          message: err instanceof Error ? err.message : String(err)
        })
      }
      if (closeToast) deps.playChime()
      // The timer is the hold's backstop and runs even without a toast: the
      // in-app card is still up, and delivery must never wait forever.
      const timer = deps.timers.setTimeout(() => {
        if (!take(meetingId)) return
        deps.log('info', '[invitee-prompt] timeout', { meetingId })
        deps.sendDecision({ meetingId, approved: false, source: 'timeout' })
      }, lifetimeMs)
      open.set(meetingId, { closeToast, timer })
      deps.log('info', '[invitee-prompt] shown', {
        meetingId,
        invitees: request.candidates.length,
        toast: closeToast !== null
      })
    },

    answerFromToast(meetingId, approved) {
      if (!take(meetingId)) {
        // A toast that lingered in Action Center after its timer fired. The
        // card is the way to send later; a stale click sends nothing.
        deps.log('info', '[invitee-prompt] stale-click', { meetingId, approved })
        return
      }
      deps.log('info', '[invitee-prompt] answered', { meetingId, approved, source: 'toast' })
      deps.sendDecision({ meetingId, approved, source: 'toast' })
    },

    closeFromApp(meetingId) {
      if (take(meetingId)) {
        deps.log('info', '[invitee-prompt] answered', { meetingId, source: 'app' })
      }
    },

    dispose() {
      for (const meetingId of [...open.keys()]) take(meetingId)
    },

    openCount: () => open.size
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm run verify:invitee-prompt && npm run typecheck`
Expected: `Invitee prompt verification passed`; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git diff --check && git diff --stat
git add src/main/invitee-prompt-core.ts scripts/verify-invitee-prompt.ts package.json
git commit -m "feat(in-488): pure invitee prompt engine with a timeout that fires the safe default"
```

---

### Task 9: Main-process runtime, toast button routing, preload bridge

**Files:**
- Create: `src/main/invitee-prompt.ts`
- Modify: `src/main/recording-ipc.ts` (export `playNotificationChime`, around line 117)
- Modify: `src/main/index.ts` (imports; IPC registration near line 97; `second-instance` near line 197; `before-quit` near line 473)
- Modify: `src/preload/index.ts`
- Test: `scripts/verify-invitee-prompt.ts`

**Interfaces:**
- Consumes: the engine (Task 8); `parseToastArgv`, `buildInviteePromptToastXml`, `inviteeToastLines` (Task 7).
- Produces:
  - main: `registerInviteePromptIpc(): void`, `inviteePromptToastAnswered(meetingId: string, approved: boolean): void`, `disposeInviteePrompt(): void`
  - `window.api.promptInvitees(request: InviteePromptRequest): void` → `delivery:prompt-invitees`
  - `window.api.closeInviteePrompt(meetingId: string): void` → `delivery:close-invitee-prompt`
  - `window.api.onInviteeDecision(callback: (decision: InviteeDecisionMessage) => void): () => void` ← `delivery:invitee-decision`
  - preload exports the types `InviteePromptCandidate`, `InviteePromptRequest`, `InviteeDecisionMessage`.

The runtime is Electron-bound and has no unit harness, so this task's red/green cycle is a set of **wiring pins** in the harness (the same technique `verify-join-watch.ts` uses on `index.ts`), plus a dev smoke.

- [ ] **Step 1: Write the failing wiring pins**

In `scripts/verify-invitee-prompt.ts`, add directly above the final `console.log`:

```ts
// ---- wiring pins (Task 9) -----------------------------------------------------
// The runtime is Electron-bound, so its wiring is pinned textually, the way
// verify-join-watch pins index.ts.
{
  const read = (...parts: string[]): string => readFileSync(join(process.cwd(), ...parts), 'utf8')
  const index = read('src', 'main', 'index.ts')
  assert.match(index, /registerInviteePromptIpc\(\)/, 'IPC is registered at startup')
  assert.match(index, /parseToastArgv\(argv\)/, 'second-instance reads the meeting id, not just the action')
  assert.match(index, /'invitees-approve'/, 'approve button is routed')
  assert.match(index, /'invitees-decline'/, 'decline button is routed')
  assert.match(index, /disposeInviteePrompt\(\)/, 'timers are cleared on quit')
  const branch = index.slice(index.indexOf("'invitees-approve'"), index.indexOf("'update-restart'"))
  assert.doesNotMatch(branch, /showMainWindow\(\)/, 'answering from the toast never steals focus')

  const runtime = read('src', 'main', 'invitee-prompt.ts')
  for (const channel of ['delivery:prompt-invitees', 'delivery:close-invitee-prompt', 'delivery:invitee-decision']) {
    assert.ok(runtime.includes(`'${channel}'`), `runtime uses ${channel}`)
  }
  const preload = read('src', 'preload', 'index.ts')
  for (const channel of ['delivery:prompt-invitees', 'delivery:close-invitee-prompt', 'delivery:invitee-decision']) {
    assert.ok(preload.includes(`'${channel}'`), `preload bridges ${channel}`)
  }
  assert.match(read('src', 'main', 'recording-ipc.ts'), /export function playNotificationChime/, 'chime helper is shared (Q14)')
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run verify:invitee-prompt`
Expected: `AssertionError: IPC is registered at startup`.

- [ ] **Step 3: Export the chime helper**

In `src/main/recording-ipc.ts`, change `function playNotificationChime(): void {` to `export function playNotificationChime(): void {`. Nothing else in the function changes.

- [ ] **Step 4: Create the runtime**

Create `src/main/invitee-prompt.ts`:

```ts
/**
 * Invitee prompt runtime (IN-488): the Electron half of invitee-prompt-core.
 *
 * Toasts live in the main process; the renderer cannot show one. The renderer
 * owns delivery, so it asks main to prompt (`delivery:prompt-invitees`), and
 * main relays the first answer back (`delivery:invitee-decision`), the same
 * direction as the tray's Pause/Stop relay. When the owner answers on the
 * in-app card instead, the renderer sends `delivery:close-invitee-prompt` so
 * main's timer cannot fire "declined" while they are looking at the card.
 */
import { BrowserWindow, ipcMain, Notification } from 'electron'
import {
  createInviteePromptEngine,
  inviteeDisplayNames,
  parseInviteePromptRequest,
  type InviteeDecisionMessage,
  type InviteePromptEngine,
  type InviteePromptRequest
} from './invitee-prompt-core'
import { logger } from './logger'
import { playNotificationChime } from './recording-ipc'
import { buildInviteePromptToastXml, inviteeToastLines } from './toast-xml'

let engine: InviteePromptEngine | null = null

/** Same win32-toast / other-platform split as the join prompt. */
function showToast(request: InviteePromptRequest): (() => void) | null {
  if (!Notification?.isSupported?.()) {
    logger().warn('[invitee-prompt] toast unsupported by Electron', { meetingId: request.meetingId })
    return null
  }
  const names = inviteeDisplayNames(request.candidates)
  const lines = inviteeToastLines(request.title, names)
  const toast =
    process.platform === 'win32'
      ? new Notification({
          toastXml: buildInviteePromptToastXml({
            meetingId: request.meetingId,
            title: request.title,
            names
          })
        })
      : new Notification({ title: lines[0], body: lines.slice(1).join('\n'), silent: true })
  toast.show()
  return () => toast.close()
}

/** The window hides to the tray but is never destroyed, so the relay normally
 *  lands. If it cannot, nothing is sent to anyone: the meeting stays
 *  undelivered and resurfaces as a card on the next launch. */
function sendDecision(message: InviteeDecisionMessage): void {
  const window = BrowserWindow.getAllWindows()[0]
  if (!window || window.isDestroyed()) {
    logger().warn('[invitee-prompt] cannot relay decision: no main window', { ...message })
    return
  }
  window.webContents.send('delivery:invitee-decision', message)
}

function getEngine(): InviteePromptEngine {
  engine ??= createInviteePromptEngine({
    showToast,
    playChime: playNotificationChime,
    sendDecision,
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
    },
    log: (level, message, context) => logger()[level](message, context)
  })
  return engine
}

export function registerInviteePromptIpc(): void {
  ipcMain.on('delivery:prompt-invitees', (_event, payload: unknown) => {
    const request = parseInviteePromptRequest(payload)
    if (!request) {
      logger().warn('[invitee-prompt] ignored malformed prompt request')
      return
    }
    getEngine().show(request)
  })
  ipcMain.on('delivery:close-invitee-prompt', (_event, payload: { meetingId?: unknown }) => {
    if (typeof payload?.meetingId === 'string') getEngine().closeFromApp(payload.meetingId)
  })
}

/** A `notetaker://invitees-*?meeting=<id>` toast button (index.ts). */
export function inviteePromptToastAnswered(meetingId: string, approved: boolean): void {
  getEngine().answerFromToast(meetingId, approved)
}

export function disposeInviteePrompt(): void {
  engine?.dispose()
  engine = null
}
```

- [ ] **Step 5: Wire `index.ts`**

Add the import (next to the other `./` main imports):

```ts
import { disposeInviteePrompt, inviteePromptToastAnswered, registerInviteePromptIpc } from './invitee-prompt'
```

In the `./toast-xml` import block, replace `toastActionFromArgv,` with `parseToastArgv,`.

After the line `registerWindowSizingIpc()` add:

```ts
registerInviteePromptIpc()
```

In the `second-instance` handler, replace

```ts
  const toastAction = toastActionFromArgv(argv)
```

with

```ts
  const parsedToast = parseToastArgv(argv)
  const toastAction = parsedToast?.action ?? null
```

and add this branch directly above `if (toastAction === 'update-restart') {`:

```ts
  if (toastAction === 'invitees-approve' || toastAction === 'invitees-decline') {
    // IN-488: answer the invitee prompt in place, without stealing focus (same
    // rationale as extend/upload-now above). The meeting id rides on the URI
    // because more than one prompt can be up; a click for a meeting whose
    // timer already fired is dropped by the engine as a stale click.
    const approved = toastAction === 'invitees-approve'
    logger().info('[app] invitee prompt answered from toast notification', { approved })
    if (parsedToast?.meetingId) inviteePromptToastAnswered(parsedToast.meetingId, approved)
    return
  }
```

In the `before-quit` handler, directly after `disposeJoinWatch()`:

```ts
  // Invitee prompts: clear timers and toasts. Quitting decides nothing; an
  // unanswered meeting resurfaces as a card on the next launch.
  disposeInviteePrompt()
```

- [ ] **Step 6: Bridge the preload**

In `src/preload/index.ts`, add after the `AutoStopRequest` interface:

```ts
// IN-488 invitee prompt. Mirrors src/main/invitee-prompt-core.ts; declared
// here because the renderer's tsconfig sees the preload types, not src/main.
export interface InviteePromptCandidate {
  name: string | null
  email: string
}

export interface InviteePromptRequest {
  meetingId: string
  title: string
  candidates: InviteePromptCandidate[]
}

export interface InviteeDecisionMessage {
  meetingId: string
  approved: boolean
  source: 'toast' | 'app' | 'timeout'
}
```

In the `api` object, after the `onRecordingEndExtended` entry (add a comma after its closing brace):

```ts
  /** Ask main to show the "email invitees?" toast and start its 2-minute
   *  timer (IN-488). The answer arrives through onInviteeDecision. */
  promptInvitees: (request: InviteePromptRequest): void =>
    ipcRenderer.send('delivery:prompt-invitees', request),

  /** The owner answered on the in-app card: close the toast and cancel the
   *  timer, so the timeout cannot fire "declined" behind their back. */
  closeInviteePrompt: (meetingId: string): void =>
    ipcRenderer.send('delivery:close-invitee-prompt', { meetingId }),

  /** Listen for a toast-button answer or main's timeout. Returns unsubscribe. */
  onInviteeDecision: (callback: (decision: InviteeDecisionMessage) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, decision: InviteeDecisionMessage): void =>
      callback(decision)
    ipcRenderer.on('delivery:invitee-decision', handler)
    return () => ipcRenderer.removeListener('delivery:invitee-decision', handler)
  }
```

`src/preload/index.d.ts` needs no change: it declares `api: Api`, and `Api` is `typeof api`.

- [ ] **Step 7: Run to verify it passes**

Run: `npm run verify:invitee-prompt && npm run verify:toast-xml && npm run typecheck && npm run build`
Expected: both harnesses pass; typecheck and build clean.

- [ ] **Step 8: Dev smoke**

> **Deferred to Joseph (22 Sep ruling).** This step drives the Electron GUI by hand, which a subagent cannot do. Implementer: skip it, say so in your report, and do not claim it ran. It stays here as Joseph's pre-release walkthrough; the harness pins in this task are the automated evidence.

`npm run dev` hot-reloads the renderer only, so stop any running dev process first, then start it. In the app's DevTools console:

```js
window.api.onInviteeDecision((d) => console.log('decision', d))
window.api.promptInvitees({ meetingId: 'smoke-1', title: 'Smoke test', candidates: [
  { name: 'David Ahlhaus', email: 'da@factor1.com.au' },
  { name: 'Mel Tran', email: 'mel@factor1.com.au' } ] })
```

Expected: a sticky toast "Notes ready: Smoke test / Email the transcript to 2 invitees? / David Ahlhaus, Mel Tran" with the chime. Then either wait 2 minutes and see `decision {meetingId: 'smoke-1', approved: false, source: 'timeout'}`, or run `window.api.closeInviteePrompt('smoke-1')` and see the toast close with no decision logged.

**The toast buttons do nothing in dev, and that is expected:** the `notetaker://` scheme is registered only for packaged builds (`app.isPackaged`, see the IN-483 comment in `index.ts`). Button routing is covered by the harness here and by live check L1 on a packaged test build.

- [ ] **Step 9: Commit**

```bash
git diff --check && git diff --stat
git add src/main/invitee-prompt.ts src/main/recording-ipc.ts src/main/index.ts src/preload/index.ts scripts/verify-invitee-prompt.ts
git commit -m "feat(in-488): invitee prompt runtime, toast button routing and preload bridge"
```

---

### Task 10: Renderer library and API client

**Files:**
- Create: `src/renderer/src/lib/inviteePrompt.ts` (zero imports, so the harness bundles it without React or the API client)
- Create: `scripts/verify-invitee-cards.ts`
- Modify: `src/renderer/src/lib/api.ts`
- Modify: `package.json` (one script)

**Interfaces:**
- Consumes: the backend contracts from Tasks 5–6.
- Produces, in `lib/inviteePrompt.ts`:
  - types `InviteeCandidate`, `InviteeDecision`, `InviteeDeliveryStatus`, `InviteeDecisionSource`, `InviteeState`, `ResurfaceMeeting`
  - `interpretInviteesResponse(res: { ok: boolean; status: number; body: unknown }): InviteeState | null` (null = "cannot ask: deliver now")
  - `inviteeDisplayName(c)`, `inviteeNamesLine(candidates): string | null`, `inviteeQuestion(candidates)`, `inviteeCountLabel(n)`, `sendLaterLabel(n)`, `emailingMessage(approved, n)`, `sendingLaterMessage(n)`, `INVITEES_NOT_SENT`
  - `shouldPrompt(state)`, `canSendLater(state)`
  - `RESURFACE_WINDOW_MS`, `resurfaceKind(meeting, nowMs, dismissed): 'pending' | 'send_later' | null`, `formatEmailedAt(date)`, `resurfacedSendLaterMessage(iso)`
  - `DISMISSED_INVITEE_CARDS_KEY`, `parseDismissed(raw)`, `withDismissed(list, meetingId)`
- Produces, in `lib/api.ts`: `fetchInvitees(meetingId, recorderEmail?)`, `postInviteeDecision(meetingId, approved, source)`, `fetchMeetingDtos()`; optional `invitee_*` and `delivery_emailed_at` fields on `MeetingDto`; `EmailResultDto.sent_now?`.

**Why `resurfaceKind` is strict about `pending`:** every meeting recorded before this release loads as `invitee_decision = pending`. Those meetings are already `emailed`. If a `pending` meeting that is already emailed counted as "send later", the first launch after the update would put a card on Home for every meeting of the past week. So `pending` resurfaces only while `delivery_status` is `not_started`. Do not widen it.

- [ ] **Step 1: Add the script**

In `package.json`, add after the `verify:email-notice` line:

```json
    "verify:invitee-cards": "esbuild scripts/verify-invitee-cards.ts --bundle --platform=node --format=cjs --tsconfig=tsconfig.web.json --outfile=out/verify-invitee-cards.cjs --log-level=error && node out/verify-invitee-cards.cjs",
```

- [ ] **Step 2: Write the failing harness**

Create `scripts/verify-invitee-cards.ts`:

```ts
import assert from 'node:assert/strict'
import {
  INVITEES_NOT_SENT,
  RESURFACE_WINDOW_MS,
  canSendLater,
  emailingMessage,
  formatEmailedAt,
  interpretInviteesResponse,
  inviteeNamesLine,
  inviteeQuestion,
  parseDismissed,
  resurfaceKind,
  resurfacedSendLaterMessage,
  sendLaterLabel,
  sendingLaterMessage,
  shouldPrompt,
  withDismissed,
  type InviteeState,
  type ResurfaceMeeting
} from '../src/renderer/src/lib/inviteePrompt'

// IN-488: the in-app half of "ask before emailing invitees". Card copy, the
// rules for when to ask and when to offer "Send to N invitees", what comes
// back after a restart, and the old-backend fallback.

const five = [
  { name: 'David Ahlhaus', email: 'da@factor1.com.au' },
  { name: 'Priya Nair', email: 'priya@factor1.com.au' },
  { name: null, email: 'sam@factor1.com.au' },
  { name: 'Alex Morgan', email: 'alex@factor1.com.au' },
  { name: 'Jordan Lee', email: 'jordan@factor1.com.au' }
]
const one = five.slice(0, 1)

// ---- copy -------------------------------------------------------------------
assert.equal(inviteeQuestion(five), 'Notes are ready. Email the transcript to 5 invitees?')
assert.equal(
  inviteeQuestion(one),
  'Notes are ready. Email the transcript to David Ahlhaus?',
  'singular wording (Q6)'
)
assert.equal(
  inviteeNamesLine(five),
  'David Ahlhaus, Priya Nair, sam@factor1.com.au, Alex Morgan, Jordan Lee',
  'the card shows the FULL list (the toast only fits three); no name falls back to the address'
)
assert.equal(inviteeNamesLine(one), null, 'one invitee is already named in the question')
assert.equal(sendLaterLabel(5), 'Send to 5 invitees')
assert.equal(sendLaterLabel(1), 'Send to 1 invitee')
assert.equal(emailingMessage(true, 5), 'Saving to SharePoint and emailing to you and 5 invitees…')
assert.equal(emailingMessage(true, 1), 'Saving to SharePoint and emailing to you and 1 invitee…')
assert.equal(emailingMessage(false, 5), 'Saving to SharePoint and emailing to you…')
assert.equal(sendingLaterMessage(5), 'Sending the transcript to 5 invitees…')
assert.equal(INVITEES_NOT_SENT, "Invitees haven't received it.")

// ---- when to ask, when to offer send-later ----------------------------------
const state = (over: Partial<InviteeState> = {}): InviteeState => ({
  candidates: five,
  decision: 'pending',
  invitee_delivery_status: 'not_started',
  invitee_recipients: [],
  prompt_enabled: true,
  ...over
})
assert.equal(shouldPrompt(state()), true)
assert.equal(shouldPrompt(null), false, 'cannot ask: deliver now')
assert.equal(shouldPrompt(state({ prompt_enabled: false })), false, 'kill switch / attendees mode: never ask')
assert.equal(shouldPrompt(state({ candidates: [] })), false, 'nobody to ask about')
assert.equal(shouldPrompt(state({ decision: 'approved' })), false, 'already answered')
assert.equal(shouldPrompt(state({ decision: 'declined' })), false, 'already answered')

assert.equal(canSendLater(state({ decision: 'declined' })), true)
assert.equal(canSendLater(state({ decision: 'pending' })), true, 'an answer that failed to record can still be sent later')
assert.equal(canSendLater(state({ decision: 'approved' })), false)
assert.equal(canSendLater(state({ decision: 'declined', invitee_delivery_status: 'sent' })), false)
assert.equal(
  canSendLater(state({ decision: 'declined', prompt_enabled: false })),
  false,
  'kill switch: the leftover button must not be offered (21 Sep "B" ruling)'
)
assert.equal(canSendLater(state({ decision: 'declined', candidates: [] })), false)
assert.equal(canSendLater(null), false)

// ---- 404 means "no prompt support" ------------------------------------------
assert.equal(
  interpretInviteesResponse({ ok: false, status: 404, body: { detail: 'Not Found' } }),
  null,
  'an older backend has no /invitees route: deliver now, which there means organiser only'
)
assert.equal(interpretInviteesResponse({ ok: false, status: 0, body: null }), null, 'backend unreachable')
assert.equal(interpretInviteesResponse({ ok: false, status: 403, body: null }), null, 'not the owner')
assert.equal(interpretInviteesResponse({ ok: true, status: 200, body: { nonsense: true } }), null, 'unrecognised body')
assert.deepEqual(
  interpretInviteesResponse({
    ok: true,
    status: 200,
    body: {
      candidates: [{ name: '  ', email: 'da@factor1.com.au' }, { junk: 1 }],
      decision: 'pending',
      invitee_delivery_status: 'not_started',
      invitee_recipients: [],
      prompt_enabled: true
    }
  }),
  state({ candidates: [{ name: null, email: 'da@factor1.com.au' }] }),
  'blank names normalise to null; malformed candidates are dropped'
)

// ---- restart resurfacing ----------------------------------------------------
const NOW = Date.parse('2026-09-21T02:00:00Z')
const none = new Set<string>()
const meeting = (over: Partial<ResurfaceMeeting> = {}): ResurfaceMeeting => ({
  id: 'm1',
  created_at: '2026-09-20T02:00:00Z',
  pipeline_status: 'ready',
  delivery_status: 'not_started',
  invitee_decision: 'pending',
  invitee_delivery_status: 'not_started',
  ...over
})
assert.equal(resurfaceKind(meeting(), NOW, none), 'pending', 'the app closed during the hold')
assert.equal(
  resurfaceKind(meeting({ delivery_status: 'emailed' }), NOW, none),
  null,
  'EVERY pre-IN-488 meeting loads as pending + emailed: widening this floods Home on the first launch after the update'
)
assert.equal(
  resurfaceKind(meeting({ invitee_decision: 'declined', delivery_status: 'emailed' }), NOW, none),
  'send_later'
)
assert.equal(
  resurfaceKind(
    meeting({ invitee_decision: 'approved', delivery_status: 'emailed', invitee_delivery_status: 'failed' }),
    NOW,
    none
  ),
  'send_later',
  'the owner said yes and the send never completed: do not lose it silently'
)
assert.equal(
  resurfaceKind(
    meeting({ invitee_decision: 'approved', delivery_status: 'emailed', invitee_delivery_status: 'sent' }),
    NOW,
    none
  ),
  null
)
assert.equal(
  resurfaceKind(meeting({ invitee_decision: 'declined', delivery_status: 'failed' }), NOW, none),
  null,
  'the send-later card says "Emailed to you on…", which would be false here'
)
assert.equal(
  resurfaceKind(meeting({ invitee_decision: 'declined', delivery_status: 'emailed' }), NOW, new Set(['m1'])),
  null,
  'dismissed send-later cards stay dismissed'
)
assert.equal(resurfaceKind(meeting(), NOW, new Set(['m1'])), 'pending', 'a pending question cannot be dismissed')
assert.equal(resurfaceKind(meeting({ pipeline_status: 'processing' }), NOW, none), null)
assert.equal(
  resurfaceKind(meeting({ created_at: new Date(NOW - RESURFACE_WINDOW_MS - 1).toISOString() }), NOW, none),
  null,
  'older than 7 days'
)
assert.equal(RESURFACE_WINDOW_MS, 7 * 24 * 60 * 60_000)
assert.equal(
  resurfaceKind(meeting({ invitee_decision: undefined, invitee_delivery_status: undefined }), NOW, none),
  null,
  'a backend from before IN-488 sends no invitee fields'
)

// Local-time constructor, so this pin holds in any timezone.
assert.equal(formatEmailedAt(new Date(2026, 8, 15, 14, 32)), 'Tue 15 Sep, 14:32')
assert.equal(formatEmailedAt(new Date(2026, 0, 5, 9, 5)), 'Mon 5 Jan, 09:05')
assert.match(
  resurfacedSendLaterMessage(new Date(2026, 8, 15, 14, 32).toISOString()),
  /^Emailed to you on Tue 15 Sep, 14:32\. Invitees haven't received it\.$/
)
assert.equal(resurfacedSendLaterMessage(null), "Emailed to you. Invitees haven't received it.")
assert.equal(resurfacedSendLaterMessage('not a date'), "Emailed to you. Invitees haven't received it.")

// ---- dismissed set ----------------------------------------------------------
assert.deepEqual(parseDismissed(null), [])
assert.deepEqual(parseDismissed('not json'), [])
assert.deepEqual(parseDismissed('{"a":1}'), [])
assert.deepEqual(parseDismissed('["m1", 7, "m2"]'), ['m1', 'm2'])
assert.deepEqual(withDismissed(['m1'], 'm2'), ['m1', 'm2'])
assert.deepEqual(withDismissed(['m1', 'm2'], 'm1'), ['m2', 'm1'], 'no duplicates')
assert.equal(
  withDismissed(Array.from({ length: 200 }, (_, i) => `m${i}`), 'new').length,
  200,
  'capped, so localStorage cannot grow without bound'
)

console.log('Invitee cards verification passed')
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm run verify:invitee-cards`
Expected: esbuild error, `Could not resolve "../src/renderer/src/lib/inviteePrompt"`.

- [ ] **Step 4: Implement the library**

Create `src/renderer/src/lib/inviteePrompt.ts`:

```ts
/**
 * IN-488 "ask before emailing invitees": the renderer's pure rules.
 *
 * Zero imports on purpose. The verify script bundles this file under plain
 * Node, and api.ts imports its types, so it must not pull in React, the API
 * client or the design system.
 */

export interface InviteeCandidate {
  name: string | null
  email: string
}

export type InviteeDecision = 'pending' | 'approved' | 'declined'
export type InviteeDeliveryStatus = 'not_started' | 'sending' | 'sent' | 'unconfirmed' | 'failed'
export type InviteeDecisionSource = 'toast' | 'app' | 'timeout'

/** GET /meetings/{id}/invitees. */
export interface InviteeState {
  candidates: InviteeCandidate[]
  /** The EFFECTIVE decision: `approved` under the `attendees` delivery mode. */
  decision: InviteeDecision
  invitee_delivery_status: InviteeDeliveryStatus
  invitee_recipients: string[]
  /** True only in `ask` mode. False = never prompt and never offer send-later. */
  prompt_enabled: boolean
}

const DECISIONS: readonly InviteeDecision[] = ['pending', 'approved', 'declined']

/**
 * Null means "cannot ask: deliver now". That covers an older backend with no
 * /invitees route (404), an unreachable backend, a non-owner (403) and a body
 * this build does not recognise. Delivering now is safe on every backend: with
 * no stored approval the backend sends to the organiser only, never to
 * invitees.
 */
export function interpretInviteesResponse(res: {
  ok: boolean
  status: number
  body: unknown
}): InviteeState | null {
  if (!res.ok || !res.body || typeof res.body !== 'object') return null
  const body = res.body as {
    candidates?: unknown
    decision?: unknown
    invitee_delivery_status?: unknown
    invitee_recipients?: unknown
    prompt_enabled?: unknown
  }
  if (!Array.isArray(body.candidates) || typeof body.prompt_enabled !== 'boolean') return null
  if (!DECISIONS.includes(body.decision as InviteeDecision)) return null
  const candidates: InviteeCandidate[] = []
  for (const entry of body.candidates) {
    const candidate = entry as { name?: unknown; email?: unknown } | null
    if (!candidate || typeof candidate.email !== 'string' || !candidate.email) continue
    candidates.push({
      name: typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name : null,
      email: candidate.email
    })
  }
  return {
    candidates,
    decision: body.decision as InviteeDecision,
    invitee_delivery_status:
      typeof body.invitee_delivery_status === 'string'
        ? (body.invitee_delivery_status as InviteeDeliveryStatus)
        : 'not_started',
    invitee_recipients: Array.isArray(body.invitee_recipients)
      ? body.invitee_recipients.filter((value): value is string => typeof value === 'string')
      : [],
    prompt_enabled: body.prompt_enabled
  }
}

// ---- copy (mock-ups: docs/superpowers/specs/in488-invitee-prompt-mockups.html)

export const INVITEES_NOT_SENT = "Invitees haven't received it."

export function inviteeDisplayName(candidate: InviteeCandidate): string {
  return candidate.name?.trim() || candidate.email
}

export function inviteeCountLabel(count: number): string {
  return count === 1 ? '1 invitee' : `${count} invitees`
}

export function inviteeQuestion(candidates: readonly InviteeCandidate[]): string {
  return candidates.length === 1
    ? `Notes are ready. Email the transcript to ${inviteeDisplayName(candidates[0])}?`
    : `Notes are ready. Email the transcript to ${candidates.length} invitees?`
}

/** The card's full name list (the toast only fits three). Null for a single
 *  invitee, who is already named in the question. */
export function inviteeNamesLine(candidates: readonly InviteeCandidate[]): string | null {
  return candidates.length > 1 ? candidates.map(inviteeDisplayName).join(', ') : null
}

export function sendLaterLabel(count: number): string {
  return `Send to ${inviteeCountLabel(count)}`
}

export function emailingMessage(approved: boolean, count: number): string {
  return approved
    ? `Saving to SharePoint and emailing to you and ${inviteeCountLabel(count)}…`
    : 'Saving to SharePoint and emailing to you…'
}

export function sendingLaterMessage(count: number): string {
  return `Sending the transcript to ${inviteeCountLabel(count)}…`
}

// ---- rules -------------------------------------------------------------------

/** Ask only in `ask` mode, only once, and only when there is someone to ask about. */
export function shouldPrompt(state: InviteeState | null): boolean {
  return Boolean(
    state && state.prompt_enabled && state.decision === 'pending' && state.candidates.length > 0
  )
}

/**
 * Offer "Send to N invitees" on a ready card. `pending` counts as well as
 * `declined`: if the answer could not be recorded, the owner can still send.
 * False under the kill switch (prompt_enabled=false): a leftover button must
 * send nothing (Joseph, 21 Sep 2026).
 */
export function canSendLater(state: InviteeState | null): boolean {
  return Boolean(
    state &&
      state.prompt_enabled &&
      state.decision !== 'approved' &&
      state.invitee_delivery_status !== 'sent' &&
      state.candidates.length > 0
  )
}

// ---- restart resurfacing -----------------------------------------------------

export const RESURFACE_WINDOW_MS = 7 * 24 * 60 * 60_000

/** The MeetingDto fields the restart filter reads. The invitee fields are
 *  optional because a backend from before IN-488 does not send them. */
export interface ResurfaceMeeting {
  id: string
  created_at: string
  pipeline_status: string
  delivery_status: string
  invitee_decision?: InviteeDecision
  invitee_delivery_status?: InviteeDeliveryStatus
}

/**
 * Which card, if any, a meeting gets on launch.
 *
 * `pending`: the app closed during the hold, so nothing was delivered. STRICT
 * on purpose: every meeting recorded before IN-488 loads as `pending`, and
 * those are already `emailed`. Treating pending + emailed as "send later"
 * would put a card on Home for every meeting of the past week on the first
 * launch after the update.
 *
 * `send_later`: the organiser has their copy and the invitees do not, either
 * because the owner said "Just me" / did not answer, or because they said yes
 * and the invitee send never completed. It requires `emailed` because the card
 * reads "Emailed to you on …". Only send-later cards can be dismissed.
 */
export function resurfaceKind(
  meeting: ResurfaceMeeting,
  nowMs: number,
  dismissed: ReadonlySet<string>
): 'pending' | 'send_later' | null {
  if (!meeting.invitee_decision || !meeting.invitee_delivery_status) return null
  const createdMs = Date.parse(meeting.created_at)
  if (!Number.isFinite(createdMs) || nowMs - createdMs > RESURFACE_WINDOW_MS) return null
  if (meeting.pipeline_status !== 'ready') return null
  if (meeting.invitee_decision === 'pending') {
    return meeting.delivery_status === 'not_started' ? 'pending' : null
  }
  if (meeting.delivery_status !== 'emailed') return null
  if (meeting.invitee_delivery_status === 'sent' || meeting.invitee_delivery_status === 'sending') {
    return null
  }
  return dismissed.has(meeting.id) ? null : 'send_later'
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Tue 15 Sep, 14:32" in local time. Hand-rolled because Intl's en-AU output
 *  ("Sept", comma placement) shifts between ICU versions. */
export function formatEmailedAt(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}, ${hh}:${mm}`
}

/** By restart time the delivery detail is history; the date is what helps the
 *  owner recognise the meeting (mock-up 5, approved 15 Sep). */
export function resurfacedSendLaterMessage(emailedAtIso: string | null | undefined): string {
  const at = emailedAtIso ? new Date(emailedAtIso) : null
  return at && Number.isFinite(at.getTime())
    ? `Emailed to you on ${formatEmailedAt(at)}. ${INVITEES_NOT_SENT}`
    : `Emailed to you. ${INVITEES_NOT_SENT}`
}

// ---- dismissed send-later cards (a UI preference, so localStorage) -----------

export const DISMISSED_INVITEE_CARDS_KEY = 'mn.inviteeCards.dismissed'
const DISMISSED_CAP = 200

export function parseDismissed(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]')
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export function withDismissed(list: readonly string[], meetingId: string): string[] {
  return [...list.filter((id) => id !== meetingId), meetingId].slice(-DISMISSED_CAP)
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm run verify:invitee-cards`
Expected: `Invitee cards verification passed`.

- [ ] **Step 6: Extend the API client**

In `src/renderer/src/lib/api.ts`, add near the top-of-file imports:

```ts
import {
  interpretInviteesResponse,
  type InviteeDecision,
  type InviteeDecisionSource,
  type InviteeDeliveryStatus,
  type InviteeState
} from './inviteePrompt'
```

In `interface MeetingDto`, add after `delivery_error_code: string | null`:

```ts
  /** When the organiser's email went out (IN-478 replay field). */
  delivery_emailed_at?: string | null
  // IN-488. Optional: a backend from before IN-488 sends none of these.
  invitee_decision?: InviteeDecision
  invitee_delivery_status?: InviteeDeliveryStatus
  invitee_recipients?: string[]
  invitee_error_message?: string | null
  invitee_error_code?: string | null
```

Replace `interface EmailResultDto` with:

```ts
export interface EmailResultDto {
  /** Everyone who has the transcript by email. */
  recipients: string[]
  sent_at: string
  /** Who THIS call emailed (IN-488): everyone on a first send, the invitees
   *  only on a later send, empty on a replay. Absent on an older backend. */
  sent_now?: string[]
}
```

Add after `saveTranscriptToSharePoint`:

```ts
/** Raw DTOs, for the IN-488 restart filter, which reads fields mapMeeting drops. */
export async function fetchMeetingDtos(): Promise<MeetingDto[] | null> {
  return get<MeetingDto[]>('/meetings')
}

/** Null means "cannot ask: deliver now" (see interpretInviteesResponse). Needs
 *  the HTTP status, which `call` discards, so it uses the bridge directly. */
export async function fetchInvitees(
  meetingId: string,
  recorderEmail?: string | null
): Promise<InviteeState | null> {
  if (typeof window.api?.request !== 'function') return null
  const query = recorderEmail ? `?recorder_email=${encodeURIComponent(recorderEmail)}` : ''
  try {
    return interpretInviteesResponse(
      await window.api.request<unknown>('GET', `${PREFIX}/meetings/${meetingId}/invitees${query}`)
    )
  } catch {
    return null
  }
}

/** Null when the answer could not be recorded (including a 409 because the
 *  meeting was already approved). Sends nothing by itself. */
export async function postInviteeDecision(
  meetingId: string,
  approved: boolean,
  source: InviteeDecisionSource
): Promise<MeetingDto | null> {
  try {
    return await call<MeetingDto>('POST', `/meetings/${meetingId}/invitees/decision`, {
      approved,
      source
    })
  } catch {
    return null
  }
}
```

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck && npm run verify:invitee-cards`
Expected: both clean.

```bash
git diff --check && git diff --stat
git add src/renderer/src/lib/inviteePrompt.ts src/renderer/src/lib/api.ts scripts/verify-invitee-cards.ts package.json
git commit -m "feat(in-488): renderer invitee rules, card copy and API client"
```

---

### Task 11: One delivery pass (behaviour-preserving refactor)

**Files:**
- Modify: `src/renderer/src/lib/deliveryNotice.ts`
- Modify: `src/renderer/src/App.tsx` (`watchProcessing` ready branch near line 1033; `retryTranscriptEmail` tail near line 1218; new `runDeliveryPass` above `watchProcessing`)
- Test: `scripts/verify-email-notice.ts`

**Interfaces:**
- Consumes: existing `emailFailureMessage`.
- Produces:
  - `deliveryOutcomeNotice(input: DeliveryOutcomeInput): DeliveryOutcomeNotice` in `lib/deliveryNotice.ts`, with `DeliveryOutcomeInput = { attempt: 'first' | 'retry'; emailRecipients: string[] | null; sharePointSaved: boolean; grantWarning?: string | null; deliveryStatus?: DeliveryStatus; deliveryErrorMessage?: string | null; deliveryErrorCode?: string | null }` and `DeliveryOutcomeNotice = { state: 'ready' | 'email_failed'; message: string; errorCode?: string | null }`
  - `runDeliveryPass(meetingId: string, title: string, recorderEmail: string, attempt: 'first' | 'retry'): Promise<void>` inside the `App` component.

**Why this task exists:** the SharePoint → email → notice mapping is copy-pasted in `watchProcessing` and `retryTranscriptEmail`, including IN-478's subtle "unconfirmed is not a failure" rule for `errorCode`. IN-488 adds two more callers. This task makes it one function **with no behaviour change**; every string below is copied from the current code. Review it as a refactor.

- [ ] **Step 1: Write the failing harness assertions**

In `scripts/verify-email-notice.ts`, change the import to:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deliveryOutcomeNotice, emailFailureMessage } from '../src/renderer/src/lib/deliveryNotice'
```

Add directly above the final `console.log`:

```ts
// One delivery pass, one place that turns its result into a card. The strings
// are the ones watchProcessing ('first') and retryTranscriptEmail ('retry')
// have always shown; this pins the extraction as behaviour-preserving.
const base = { emailRecipients: null, sharePointSaved: false } as const

assert.deepEqual(
  deliveryOutcomeNotice({
    attempt: 'first',
    emailRecipients: ['joseph@factor1.com.au', 'da@factor1.com.au'],
    sharePointSaved: true
  }),
  {
    state: 'ready',
    message: 'Transcript saved to SharePoint and emailed to joseph@factor1.com.au, da@factor1.com.au.'
  },
  'ready lists the actual addresses (deliberate since 7 Aug) and carries no errorCode'
)
assert.equal(
  deliveryOutcomeNotice({
    attempt: 'retry',
    emailRecipients: ['joseph@factor1.com.au'],
    sharePointSaved: true,
    grantWarning: 'View access could not be granted to: x@factor1.com.au.'
  }).message,
  'Transcript saved to SharePoint and emailed to joseph@factor1.com.au. View access could not be granted to: x@factor1.com.au.',
  'Option A (IN-398): the grant warning is appended, not hidden'
)

for (const [attempt, sharePointFailed, emailFailed, bothFailed] of [
  [
    'first',
    'Transcript email was sent, but SharePoint save failed. Sign in again, then retry delivery.',
    'Transcript saved to SharePoint, but email was not sent. Sign in to Outlook, then retry email.',
    'Notes are ready, but SharePoint save and transcript email failed. Sign in to Microsoft, then retry delivery.'
  ],
  [
    'retry',
    'Transcript email was sent, but SharePoint save still failed.',
    'Transcript saved to SharePoint, but email still failed.',
    'SharePoint save and email still failed. The notes are ready and the recording is safe.'
  ]
] as const) {
  assert.deepEqual(
    deliveryOutcomeNotice({ attempt, emailRecipients: ['j@factor1.com.au'], sharePointSaved: false }),
    { state: 'email_failed', message: sharePointFailed, errorCode: null },
    `${attempt}: email sent, SharePoint failed → fallback "Processing error" label`
  )
  assert.deepEqual(
    deliveryOutcomeNotice({
      ...base,
      attempt,
      sharePointSaved: true,
      deliveryStatus: 'failed',
      deliveryErrorCode: 'azure_signin'
    }),
    { state: 'email_failed', message: emailFailed, errorCode: 'azure_signin' },
    `${attempt}: SharePoint saved, email failed`
  )
  assert.deepEqual(
    deliveryOutcomeNotice({ ...base, attempt, deliveryStatus: 'failed' }),
    { state: 'email_failed', message: bothFailed, errorCode: null },
    `${attempt}: both failed, no classified code → null`
  )
}

const unconfirmed = deliveryOutcomeNotice({
  ...base,
  attempt: 'first',
  sharePointSaved: true,
  deliveryStatus: 'unconfirmed',
  deliveryErrorMessage: 'Backend says check your inbox first.',
  deliveryErrorCode: 'network'
})
assert.equal(unconfirmed.message, 'Backend says check your inbox first.')
assert.equal(
  unconfirmed.errorCode,
  undefined,
  "IN-478: 'unconfirmed' is not a failure, so HomeScreen must never render a Failed: label for it"
)

// Every delivery goes through the one pass.
{
  const app = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'App.tsx'), 'utf8')
  assert.equal((app.match(/saveTranscriptToSharePoint\(/g) ?? []).length, 1, 'one SharePoint call site')
  assert.equal((app.match(/emailNotes\(/g) ?? []).length, 1, 'one email call site')
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run verify:email-notice`
Expected: esbuild error, `No matching export in "src/renderer/src/lib/deliveryNotice.ts" for import "deliveryOutcomeNotice"`.

- [ ] **Step 3: Implement `deliveryOutcomeNotice`**

Append to `src/renderer/src/lib/deliveryNotice.ts`:

```ts
export interface DeliveryOutcomeInput {
  /** 'first' = the post-capture watcher's wording; 'retry' = Retry email's. */
  attempt: 'first' | 'retry'
  /** Everyone who has the email, or null when the email call failed. */
  emailRecipients: string[] | null
  sharePointSaved: boolean
  grantWarning?: string | null
  /** Re-fetched after an email failure (IN-478); undefined otherwise. */
  deliveryStatus?: DeliveryStatus
  deliveryErrorMessage?: string | null
  deliveryErrorCode?: string | null
}

export interface DeliveryOutcomeNotice {
  state: 'ready' | 'email_failed'
  message: string
  // Three-way, as on PostCaptureNotice: a FailureCategory string; null = a
  // genuine failure with no classified code; undefined = not a failure at all
  // (the email-unconfirmed case, IN-478), so no "Failed:" label is rendered.
  errorCode?: string | null
}

const OUTCOME_WORDING = {
  first: {
    sharePointFailed:
      'Transcript email was sent, but SharePoint save failed. Sign in again, then retry delivery.',
    emailFailed:
      'Transcript saved to SharePoint, but email was not sent. Sign in to Outlook, then retry email.',
    bothFailed:
      'Notes are ready, but SharePoint save and transcript email failed. Sign in to Microsoft, then retry delivery.'
  },
  retry: {
    sharePointFailed: 'Transcript email was sent, but SharePoint save still failed.',
    emailFailed: 'Transcript saved to SharePoint, but email still failed.',
    bothFailed: 'SharePoint save and email still failed. The notes are ready and the recording is safe.'
  }
} as const

/**
 * The card for one delivery pass (POST /sharepoint, then POST /email). The
 * single home for IN-478's rule: an `unconfirmed` email is not a failure, so
 * it shows the backend's check-your-inbox text and no "Failed:" label.
 */
export function deliveryOutcomeNotice(input: DeliveryOutcomeInput): DeliveryOutcomeNotice {
  const wording = OUTCOME_WORDING[input.attempt]
  if (input.emailRecipients && input.sharePointSaved) {
    return {
      state: 'ready',
      // Option A (IN-398): a saved delivery can still carry a view-grant
      // warning for ungrantable attendees — say so instead of hiding it.
      message:
        `Transcript saved to SharePoint and emailed to ${input.emailRecipients.join(', ')}.` +
        (input.grantWarning ? ` ${input.grantWarning}` : '')
    }
  }
  if (input.emailRecipients) {
    // The save endpoint raises rather than returning a DTO, so no fresh
    // sharepoint_error_code is in scope: fall back to the chips' default label.
    return { state: 'email_failed', message: wording.sharePointFailed, errorCode: null }
  }
  return {
    state: 'email_failed',
    message: emailFailureMessage(
      input.deliveryStatus,
      input.deliveryErrorMessage,
      input.sharePointSaved ? wording.emailFailed : wording.bothFailed
    ),
    errorCode:
      input.deliveryStatus === 'unconfirmed' ? undefined : (input.deliveryErrorCode ?? null)
  }
}
```

- [ ] **Step 4: Add `runDeliveryPass` to `App.tsx`**

Change the `./lib/deliveryNotice` import to:

```ts
import { deliveryOutcomeNotice } from './lib/deliveryNotice'
```

Directly above `const watchProcessing = (meetingId: string, title: string): void => {` (this is below the `if (!user)` early return, so `user` is non-null here):

```ts
  // The one delivery pass: SharePoint, then email, then the card. Shared by the
  // post-capture watcher and Retry email so IN-478's unconfirmed handling
  // lives in one place (lib/deliveryNotice).
  const runDeliveryPass = async (
    meetingId: string,
    title: string,
    recorderEmail: string,
    attempt: 'first' | 'retry'
  ): Promise<void> => {
    const sharePointResult = await saveTranscriptToSharePoint(meetingId)
    const emailResult = await emailNotes(meetingId, null, recorderEmail)
    // IN-478: a failed email call may still have delivered (transport error or
    // backend restart mid-send). Re-check delivery state so the notice warns
    // "check your inbox" instead of inviting a blind resend.
    const deliveryAfterFailure = emailResult
      ? null
      : (await fetchMeetingReview(meetingId))?.meeting
    setPostCaptureNotice({
      meetingId,
      title,
      ...deliveryOutcomeNotice({
        attempt,
        emailRecipients: emailResult?.recipients ?? null,
        sharePointSaved: Boolean(sharePointResult?.sharepoint_web_url),
        grantWarning: sharePointResult?.sharepoint_grant_warning,
        deliveryStatus: deliveryAfterFailure?.delivery_status,
        deliveryErrorMessage: deliveryAfterFailure?.delivery_error_message,
        deliveryErrorCode: deliveryAfterFailure?.delivery_error_code
      })
    })
  }
```

- [ ] **Step 5: Use it in `watchProcessing`**

Inside `if (status === 'ready' && review) {`, keep the `void watchBlobDelivery(...)` call and the `setPostCaptureNotice({ state: 'emailing', … })` call that follows it. Replace **everything after that `setPostCaptureNotice` call, up to and including the block's `return`** (the `const sharePointResult = …`, `const emailResult = …`, `const deliveryAfterFailure = …` lines and the four-way `if / else if / else if / else`) with:

```ts
        await runDeliveryPass(meetingId, title, user.email, 'first')
        return
```

- [ ] **Step 6: Use it in `retryTranscriptEmail`**

Keep everything down to and including the `setPostCaptureNotice({ state: 'emailing', …, message: 'Retrying SharePoint save and transcript email…' })` call. Replace **everything after it to the end of the function body** (the two `await` lines, `deliveryAfterFailure`, and the large `setPostCaptureNotice({ state: emailResult && … })` call) with:

```ts
    await runDeliveryPass(meetingId, title, recorderEmail, 'retry')
```

- [ ] **Step 7: Run to verify it passes**

Run: `npm run verify:email-notice && npm run typecheck`
Expected: `Email notice verification passed`; typecheck clean. If typecheck reports `emailFailureMessage` is unused in `App.tsx`, that is correct: the import was replaced in Step 4.

- [ ] **Step 8: Commit**

```bash
git diff --check && git diff --stat
git add src/renderer/src/lib/deliveryNotice.ts src/renderer/src/App.tsx scripts/verify-email-notice.ts
git commit -m "refactor(delivery): one delivery pass shared by the watcher and retry email"
```

---

### Task 12: The hold, the pending card and "Send to N invitees"

**Files:**
- Modify: `src/renderer/src/lib/deliveryNotice.ts` (extend `deliveryOutcomeNotice`)
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/screens/HomeScreen.tsx`
- Test: `scripts/verify-email-notice.ts`, `scripts/verify-invitee-cards.ts`

**Interfaces:**
- Consumes: `fetchInvitees`, `postInviteeDecision` (Task 10); `shouldPrompt`, `canSendLater`, copy helpers (Task 10); `window.api.promptInvitees` / `closeInviteePrompt` / `onInviteeDecision` (Task 9); `runDeliveryPass` (Task 11).
- Produces:
  - `DeliveryOutcomeInput` gains `sentNow?: string[]`, `sendLaterOffered?: boolean`, `inviteeDeliveryStatus?: InviteeDeliveryStatus`, `inviteeErrorMessage?: string | null`, `inviteeErrorCode?: string | null`
  - `PostCaptureState` gains `'awaiting_invitees'`; `PostCaptureNotice` gains `invitees?: InviteeCandidate[]`
  - in `App`: `deliverWithInviteeHold(meetingId, title, recorderEmail, notAskedMessage)`, `answerInviteePrompt(meetingId, approved)`, `sendToInvitees(meetingId, title, count)`
  - `HomeScreen` props `onAnswerInviteePrompt?: (meetingId: string, approved: boolean) => void` and `onSendToInvitees?: (meetingId: string, title: string, count: number) => void`

**How a later send is recognised without the renderer tracking a mode:** the backend's `sent_now` is everyone on a first send, a strict subset (the invitees) on a later send, and empty on a replay. A failed later send is recognised from the re-fetched meeting: `delivery_status` is still `emailed`.

- [ ] **Step 1: Write the failing outcome assertions**

In `scripts/verify-email-notice.ts`, add directly above the `// Every delivery goes through the one pass.` block:

```ts
// IN-488 outcomes.
assert.equal(
  deliveryOutcomeNotice({
    attempt: 'first',
    emailRecipients: ['joseph@factor1.com.au'],
    sentNow: ['joseph@factor1.com.au'],
    sharePointSaved: true,
    sendLaterOffered: true
  }).message,
  "Transcript saved to SharePoint and emailed to joseph@factor1.com.au. Invitees haven't received it.",
  'after "Just me" or a timeout the card must not read as if delivery is finished'
)
assert.equal(
  deliveryOutcomeNotice({
    attempt: 'retry',
    emailRecipients: ['joseph@factor1.com.au', 'da@factor1.com.au', 'mel@factor1.com.au'],
    sentNow: ['da@factor1.com.au', 'mel@factor1.com.au'],
    sharePointSaved: true
  }).message,
  'Sent to da@factor1.com.au, mel@factor1.com.au.',
  'a later send names only the people THIS send reached'
)
assert.equal(
  deliveryOutcomeNotice({
    attempt: 'retry',
    emailRecipients: ['joseph@factor1.com.au', 'da@factor1.com.au'],
    sentNow: [],
    sharePointSaved: true
  }).message,
  'Transcript saved to SharePoint and emailed to joseph@factor1.com.au, da@factor1.com.au.',
  'a replay (nothing sent now) lists everyone who has it'
)
assert.deepEqual(
  deliveryOutcomeNotice({
    ...base,
    attempt: 'retry',
    sharePointSaved: true,
    deliveryStatus: 'emailed',
    inviteeDeliveryStatus: 'failed',
    inviteeErrorMessage: 'Outlook sign-in is required before the transcript can be sent to invitees',
    inviteeErrorCode: 'azure_signin'
  }),
  {
    state: 'email_failed',
    message:
      'Outlook sign-in is required before the transcript can be sent to invitees. ' +
      'Nothing was sent to invitees; your own copy was already delivered.',
    errorCode: 'azure_signin'
  },
  'a failed later send reassures the owner about their own copy (mock-up 4)'
)
const inviteeUnconfirmed = deliveryOutcomeNotice({
  ...base,
  attempt: 'retry',
  sharePointSaved: true,
  deliveryStatus: 'emailed',
  inviteeDeliveryStatus: 'unconfirmed',
  inviteeErrorMessage: 'It may already have been delivered. Check with an invitee before resending.'
})
assert.equal(inviteeUnconfirmed.message, 'It may already have been delivered. Check with an invitee before resending.')
assert.equal(inviteeUnconfirmed.errorCode, undefined, 'unconfirmed is never a Failed: label')
```

In `scripts/verify-invitee-cards.ts`, add `readFileSync` / `join` imports:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
```

and add directly above the final `console.log`:

```ts
// ---- wiring pins (Task 12) ---------------------------------------------------
{
  const read = (...parts: string[]): string => readFileSync(join(process.cwd(), 'src', 'renderer', 'src', ...parts), 'utf8')
  const app = read('App.tsx')
  assert.match(app, /'awaiting_invitees'/, 'the hold has its own post-capture state')
  assert.match(app, /window\.api\.promptInvitees\(/, 'the renderer asks main to show the toast')
  assert.match(app, /window\.api\.closeInviteePrompt/, "an in-app answer cancels main's timer")
  assert.match(app, /window\.api\.onInviteeDecision\(/, 'toast answers and the timeout reach the renderer')
  const hold = app.slice(app.indexOf('const deliverWithInviteeHold'))
  assert.ok(
    hold.indexOf('postInviteeDecision(') < hold.indexOf('runDeliveryPass('),
    'the decision is recorded BEFORE delivery starts, so every retry uses the same recipient list'
  )
  const activeNotice = app.slice(app.indexOf('const activePostCaptureNotice'), app.indexOf('const shellRecordingState'))
  assert.doesNotMatch(activeNotice, /awaiting_invitees/, 'waiting for an answer is not "processing" in the status bar')

  const home = read('screens', 'HomeScreen.tsx')
  assert.match(home, /sendLaterLabel\(/, 'the ready card offers Send to N invitees')
  assert.match(home, /inviteeNamesLine\(/, 'the pending card shows the full list')
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run verify:email-notice; npm run verify:invitee-cards`
Expected: the first fails on `"Invitees haven't received it."`; the second fails on `the hold has its own post-capture state`.

- [ ] **Step 3: Extend `deliveryOutcomeNotice`**

In `src/renderer/src/lib/deliveryNotice.ts`, add below the existing `import type` line:

```ts
import { INVITEES_NOT_SENT, type InviteeDeliveryStatus } from './inviteePrompt'
```

Add these fields to `DeliveryOutcomeInput`:

```ts
  /** Who THIS pass emailed (EmailResultDto.sent_now). A non-empty strict
   *  subset of emailRecipients means this was a later, invitee-only send. */
  sentNow?: string[]
  /** "Send to N invitees" is being offered on this card (IN-488). */
  sendLaterOffered?: boolean
  // Re-fetched after an email failure, like the delivery_* trio.
  inviteeDeliveryStatus?: InviteeDeliveryStatus
  inviteeErrorMessage?: string | null
  inviteeErrorCode?: string | null
```

Add above `deliveryOutcomeNotice`:

```ts
const INVITEE_UNCONFIRMED_WARNING =
  'The invitee email attempt was interrupted — it may already have been delivered. ' +
  'Check with an invitee before retrying.'
const ORGANISER_COPY_SAFE = 'Nothing was sent to invitees; your own copy was already delivered.'
```

Replace the body of `deliveryOutcomeNotice` with:

```ts
  const wording = OUTCOME_WORDING[input.attempt]
  if (input.emailRecipients && input.sharePointSaved) {
    const sentNow = input.sentNow ?? []
    const laterSend = sentNow.length > 0 && sentNow.length < input.emailRecipients.length
    return {
      state: 'ready',
      message:
        (laterSend
          ? `Sent to ${sentNow.join(', ')}.`
          : `Transcript saved to SharePoint and emailed to ${input.emailRecipients.join(', ')}.`) +
        // Without this line the card reads as if delivery is finished and the
        // Send button looks like a resend (mock-ups, approved 15 Sep).
        (input.sendLaterOffered ? ` ${INVITEES_NOT_SENT}` : '') +
        // Option A (IN-398): a saved delivery can still carry a view-grant
        // warning for ungrantable attendees — say so instead of hiding it.
        (input.grantWarning ? ` ${input.grantWarning}` : '')
    }
  }
  if (input.emailRecipients) {
    // The save endpoint raises rather than returning a DTO, so no fresh
    // sharepoint_error_code is in scope: fall back to the chips' default label.
    return { state: 'email_failed', message: wording.sharePointFailed, errorCode: null }
  }
  if (input.deliveryStatus === 'emailed') {
    // The email call failed although the organiser already has theirs: this
    // was the later, invitee-only send (IN-488). Same unconfirmed rule.
    const unconfirmed = input.inviteeDeliveryStatus === 'unconfirmed'
    const cause = input.inviteeErrorMessage?.trim().replace(/\.$/, '')
    return {
      state: 'email_failed',
      message: unconfirmed
        ? input.inviteeErrorMessage?.trim() || INVITEE_UNCONFIRMED_WARNING
        : `${cause || 'The transcript could not be sent to invitees'}. ${ORGANISER_COPY_SAFE}`,
      errorCode: unconfirmed ? undefined : (input.inviteeErrorCode ?? null)
    }
  }
  return {
    state: 'email_failed',
    message: emailFailureMessage(
      input.deliveryStatus,
      input.deliveryErrorMessage,
      input.sharePointSaved ? wording.emailFailed : wording.bothFailed
    ),
    errorCode:
      input.deliveryStatus === 'unconfirmed' ? undefined : (input.deliveryErrorCode ?? null)
  }
```

Run: `npm run verify:email-notice`
Expected: `Email notice verification passed`.

- [ ] **Step 4: Extend the notice type and imports in `App.tsx`**

Add to the `./lib/api` import list: `fetchInvitees`, `postInviteeDecision`.

Add a new import:

```ts
import {
  canSendLater,
  emailingMessage,
  inviteeQuestion,
  sendingLaterMessage,
  shouldPrompt,
  type InviteeCandidate,
  type InviteeDecisionSource
} from './lib/inviteePrompt'
```

Replace the `PostCaptureState` type with:

```ts
type PostCaptureState =
  | 'processing'
  // IN-488: notes are ready and delivery is held on the owner's answer.
  | 'awaiting_invitees'
  | 'emailing'
  | 'ready'
  | 'upload_failed'
  | 'processing_failed'
  | 'email_failed'
```

In the `PostCaptureNotice` type, add after the `errorCode?: string | null` field:

```ts
  // IN-488. awaiting_invitees: the people being asked about. ready: present
  // only when "Send to N invitees" is offered.
  invitees?: InviteeCandidate[]
```

Add at **module level**, directly below the `PostCaptureNotice` type (module level because a hook above the `if (!user)` early return uses it; a `const` declared below that return is never initialised on a signed-out render):

```ts
type InviteeAnswer = { approved: boolean; source: InviteeDecisionSource }

/** First answer wins (spec §4): the resolver is removed as it is used, so a
 *  toast click, a card click and main's timeout can never both act. */
function settleInviteeHold(
  holds: Map<string, (answer: InviteeAnswer) => void>,
  meetingId: string,
  answer: InviteeAnswer
): boolean {
  const resolve = holds.get(meetingId)
  if (!resolve) return false
  holds.delete(meetingId)
  resolve(answer)
  return true
}
```

- [ ] **Step 5: Add the hold's ref and the decision listener (above the early return)**

Directly after the `const [unuploaded, setUnuploaded] = useState<…>([])` declaration:

```ts
  // IN-488: meetings whose delivery is held on the owner's answer.
  const inviteeHoldsRef = useRef(new Map<string, (answer: InviteeAnswer) => void>())
```

Directly after the `useEffect` that subscribes to `window.api.onNotificationChime`:

```ts
  // IN-488: a toast button, or main's timeout (the safe default), answers the hold.
  useEffect(() => {
    if (typeof window.api?.onInviteeDecision !== 'function') return
    return window.api.onInviteeDecision((decision) => {
      settleInviteeHold(inviteeHoldsRef.current, decision.meetingId, {
        approved: decision.approved,
        source: decision.source
      })
    })
  }, [])
```

- [ ] **Step 6: Teach `runDeliveryPass` about invitees**

Replace the whole `runDeliveryPass` function from Task 11 with:

```ts
  // The one delivery pass: SharePoint, then email, then the card. Shared by the
  // post-capture watcher, Retry email and "Send to N invitees" (IN-488). The
  // backend routes POST /email to a first send, a later invitee-only send or a
  // replay from its stored state; the card is derived from what comes back.
  const runDeliveryPass = async (
    meetingId: string,
    title: string,
    recorderEmail: string,
    attempt: 'first' | 'retry'
  ): Promise<void> => {
    const sharePointResult = await saveTranscriptToSharePoint(meetingId)
    const emailResult = await emailNotes(meetingId, null, recorderEmail)
    // IN-478: a failed email call may still have delivered (transport error or
    // backend restart mid-send). Re-check delivery state so the notice warns
    // "check your inbox" instead of inviting a blind resend.
    const afterFailure = emailResult ? null : (await fetchMeetingReview(meetingId))?.meeting
    const sharePointSaved = Boolean(sharePointResult?.sharepoint_web_url)
    // Whether to offer "Send to N invitees" is the backend's call, asked after
    // every successful pass so Retry and the restart cards get it right too.
    const invitees = emailResult && sharePointSaved ? await fetchInvitees(meetingId, recorderEmail) : null
    const sendLaterOffered = canSendLater(invitees)
    setPostCaptureNotice({
      meetingId,
      title,
      ...deliveryOutcomeNotice({
        attempt,
        emailRecipients: emailResult?.recipients ?? null,
        sentNow: emailResult?.sent_now ?? [],
        sharePointSaved,
        grantWarning: sharePointResult?.sharepoint_grant_warning,
        sendLaterOffered,
        deliveryStatus: afterFailure?.delivery_status,
        deliveryErrorMessage: afterFailure?.delivery_error_message,
        deliveryErrorCode: afterFailure?.delivery_error_code,
        inviteeDeliveryStatus: afterFailure?.invitee_delivery_status,
        inviteeErrorMessage: afterFailure?.invitee_error_message,
        inviteeErrorCode: afterFailure?.invitee_error_code
      }),
      invitees: sendLaterOffered ? invitees?.candidates : undefined
    })
  }
```

- [ ] **Step 7: Add the hold and its two actions**

Directly below `runDeliveryPass`:

```ts
  // IN-488 (D3, D4): nothing is delivered until the owner answers. Both the
  // SharePoint save and the email are held, because the SharePoint grants ARE
  // the sharing; one decision then leads to one delivery pass.
  const deliverWithInviteeHold = async (
    meetingId: string,
    title: string,
    recorderEmail: string,
    notAskedMessage: string
  ): Promise<void> => {
    const state = await fetchInvitees(meetingId, recorderEmail)
    if (!shouldPrompt(state) || !state || typeof window.api?.promptInvitees !== 'function') {
      // Nobody to ask about, already answered, the kill switch, the attendees
      // override, or an older backend (404): deliver now. Without a stored
      // approval the backend sends to the organiser only.
      setPostCaptureNotice({ state: 'emailing', meetingId, title, message: notAskedMessage })
      await runDeliveryPass(meetingId, title, recorderEmail, 'first')
      return
    }

    const { candidates } = state
    setPostCaptureNotice({
      state: 'awaiting_invitees',
      meetingId,
      title,
      message: inviteeQuestion(candidates),
      invitees: candidates
    })
    const answer = await new Promise<InviteeAnswer>((resolve) => {
      inviteeHoldsRef.current.set(meetingId, resolve)
      window.api.promptInvitees({ meetingId, title, candidates })
    })
    window.api.debugLog?.('[invitee-prompt] answered', { meetingId, ...answer })

    // Recorded BEFORE delivery starts, on its own request, so every retry of
    // the pass runs with the same recipient list. If recording fails the pass
    // still runs: the backend then sends to the organiser only, and the ready
    // card offers "Send to N invitees".
    await postInviteeDecision(meetingId, answer.approved, answer.source)
    setPostCaptureNotice({
      state: 'emailing',
      meetingId,
      title,
      message: emailingMessage(answer.approved, candidates.length)
    })
    await runDeliveryPass(meetingId, title, recorderEmail, 'first')
  }

  /** The pending card's buttons. Closing main's prompt first means its timeout
   *  cannot fire "declined" while the owner is looking at the card. */
  const answerInviteePrompt = (meetingId: string, approved: boolean): void => {
    window.api.closeInviteePrompt?.(meetingId)
    settleInviteeHold(inviteeHoldsRef.current, meetingId, { approved, source: 'app' })
  }

  /** "Send to N invitees": declined → approved, then the same delivery pass.
   *  The backend knows the organiser has their copy, so only invitees are
   *  emailed, and the SharePoint re-post overwrites the files and adds grants. */
  const sendToInvitees = async (meetingId: string, title: string, count: number): Promise<void> => {
    setPostCaptureNotice({
      state: 'emailing',
      meetingId,
      title,
      message: sendingLaterMessage(count)
    })
    const recorded = await postInviteeDecision(meetingId, true, 'app')
    if (!recorded) {
      setPostCaptureNotice({
        state: 'email_failed',
        meetingId,
        title,
        message:
          'Could not start sending to invitees. Nothing was sent to invitees; your own copy was already delivered.',
        errorCode: null
      })
      return
    }
    await runDeliveryPass(meetingId, title, user.email, 'retry')
  }
```

- [ ] **Step 8: Route `watchProcessing` through the hold**

Inside `if (status === 'ready' && review) {`, keep the `void watchBlobDelivery(...)` call (blob delivery stays independent). Replace the `setPostCaptureNotice({ state: 'emailing', … })` call **and** the `await runDeliveryPass(...)` line from Task 11 with:

```ts
        await deliverWithInviteeHold(
          meetingId,
          title,
          user.email,
          `Notes are ready: ${review.segments.length} transcript segments and ${review.action_items.length} action items. Saving to SharePoint and emailing transcript…`
        )
        return
```

(Keep exactly one `return` closing the block.)

Do **not** change `activePostCaptureNotice`: it lists `processing` and `emailing` only, which is what keeps the shell status bar from saying "processing" while the app waits for an answer (spec §3.1).

- [ ] **Step 9: Pass the two actions to `HomeScreen`**

In the `<HomeScreen … />` JSX, add after `onRetryPostCapture={…}`:

```tsx
          onAnswerInviteePrompt={answerInviteePrompt}
          onSendToInvitees={(meetingId, title, count) => void sendToInvitees(meetingId, title, count)}
```

- [ ] **Step 10: Build the cards in `HomeScreen.tsx`**

Add `Mail` to the `lucide-react` import (alphabetical: after `Loader2`). Add:

```ts
import { inviteeNamesLine, sendLaterLabel, type InviteeCandidate } from '../lib/inviteePrompt'
```

In `interface HomeProps`, replace the `state:` line of `postCaptureNotice` with:

```ts
    state:
      | 'processing'
      | 'awaiting_invitees'
      | 'emailing'
      | 'ready'
      | 'upload_failed'
      | 'processing_failed'
      | 'email_failed'
```

add after its `errorCode?: string | null` field:

```ts
    // IN-488: who is being asked about (awaiting_invitees), or who "Send to N
    // invitees" would reach (ready).
    invitees?: InviteeCandidate[]
```

and add after `onRetryPostCapture?: …`:

```ts
  onAnswerInviteePrompt?: (meetingId: string, approved: boolean) => void
  onSendToInvitees?: (meetingId: string, title: string, count: number) => void
```

Add `onAnswerInviteePrompt,` and `onSendToInvitees,` to the destructured props of `HomeScreen`.

Replace the `postCaptureNotice` render block (the `{postCaptureNotice && postCaptureNotice.state !== 'processing' && postCaptureNotice.state !== 'emailing' && ( … )}` expression) with:

```tsx
      {/* `processing` stays status-bar only. `emailing` is a card since IN-488
          (Q10): the approved mock-ups draw it between the question and the result. */}
      {postCaptureNotice && postCaptureNotice.state !== 'processing' && (
        <PostCaptureNotice
          notice={postCaptureNotice}
          onDismiss={onDismissPostCaptureNotice}
          onRetry={onRetryPostCapture}
          onAnswerInvitees={onAnswerInviteePrompt}
          onSendToInvitees={onSendToInvitees}
        />
      )}
```

Replace the whole `PostCaptureNotice` function with:

```tsx
function PostCaptureNotice({
  notice,
  onDismiss,
  onRetry,
  onAnswerInvitees,
  onSendToInvitees
}: {
  notice: NonNullable<HomeProps['postCaptureNotice']>
  onDismiss?: () => void
  onRetry?: (meetingId: string, title: string) => void
  onAnswerInvitees?: (meetingId: string, approved: boolean) => void
  onSendToInvitees?: (meetingId: string, title: string, count: number) => void
}): JSX.Element {
  const failed = notice.state.endsWith('_failed')
  const awaiting = notice.state === 'awaiting_invitees'
  const icon =
    notice.state === 'ready' ? (
      <CheckCircle2 size={16} strokeWidth={1.75} />
    ) : failed ? (
      <XCircle size={16} strokeWidth={1.75} />
    ) : awaiting ? (
      <Mail size={16} strokeWidth={1.75} />
    ) : (
      <Loader2 className="animate-spin" size={16} strokeWidth={1.75} />
    )
  const toneClass =
    notice.state === 'ready'
      ? 'border-edge-success bg-bg-success text-content-success'
      : failed
        ? 'border-edge-danger bg-bg-danger text-content-danger'
        : 'border-edge-info bg-bg-info text-content-info'
  const actionLabel =
    notice.state === 'upload_failed'
      ? 'Retry upload'
      : notice.state === 'processing_failed'
        ? 'Check status'
        : notice.state === 'email_failed'
          ? 'Retry email'
          : null
  const invitees = notice.invitees ?? []
  // The card carries the FULL list; the toast only fits three names (D9).
  const namesLine = awaiting ? inviteeNamesLine(invitees) : null
  const sendLater = notice.state === 'ready' && invitees.length > 0
  const buttonClass =
    'rounded-sm border-[0.5px] border-current px-2 py-1 text-[12px] opacity-85 hover:opacity-100'

  return (
    <div className={`rounded-md border-[0.5px] px-3 py-2.5 ${toneClass}`}>
      <div className="flex items-start gap-2">
        <div className="mt-0.5 shrink-0">{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{notice.title}</div>
          {failed && notice.errorCode !== undefined && (
            <div className="mt-0.5 text-[12px] font-semibold">
              Failed: {categoryLabel(notice.errorCode)}
            </div>
          )}
          <div className="mt-0.5 text-[12px] opacity-90">{notice.message}</div>
          {namesLine && <div className="mt-0.5 text-[12px] opacity-90">{namesLine}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {awaiting && onAnswerInvitees && (
            <>
              <button
                type="button"
                className={buttonClass}
                onClick={() => onAnswerInvitees(notice.meetingId, true)}
              >
                Email invitees
              </button>
              <button
                type="button"
                className={buttonClass}
                onClick={() => onAnswerInvitees(notice.meetingId, false)}
              >
                Just me
              </button>
            </>
          )}
          {sendLater && onSendToInvitees && (
            <button
              type="button"
              className={buttonClass}
              onClick={() => onSendToInvitees(notice.meetingId, notice.title, invitees.length)}
            >
              {sendLaterLabel(invitees.length)}
            </button>
          )}
          {actionLabel && onRetry && (
            <button
              type="button"
              className={buttonClass}
              onClick={() => onRetry(notice.meetingId, notice.title)}
            >
              {actionLabel}
            </button>
          )}
          {/* No Dismiss while awaiting: the timeout resolves it (spec §3.1). */}
          {notice.state !== 'processing' && notice.state !== 'emailing' && !awaiting && onDismiss && (
            <button type="button" className="text-[12px] opacity-80 hover:opacity-100" onClick={onDismiss}>
              Dismiss
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
```

Note: `font-semibold` on the existing "Failed:" line predates this work; leave it. New elements use weights 400/500 only.

- [ ] **Step 11: Run to verify it passes**

Run: `npm run verify:email-notice && npm run verify:invitee-cards && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 12: Stub-mode walkthrough**

> **Deferred to Joseph (22 Sep ruling).** This step drives the Electron GUI by hand, which a subagent cannot do. Implementer: skip it, say so in your report, and do not claim it ran. It stays here as Joseph's pre-release walkthrough; the harness pins in this task are the automated evidence.

This exercises the real hold end to end with no cloud credentials (stub providers "send" by logging).

```bash
grep -c "MN_DELIVERY_RECIPIENTS" backend/.env
```

Expected: `0` (so the backend runs in `ask`). If it prints 1, comment that line out for this walkthrough.

Restart uvicorn (see `CLAUDE.md`, "Backend process management"), then `npm run dev` (kill any previous dev process first: main and preload do not hot-reload). On Home, enter a title, pick one attendee in the attendee picker, and upload a short audio file. Expect, in order:

1. The pending card: "Notes are ready. Email the transcript to {name}?" with **Email invitees** / **Just me**, no Dismiss, and a toast with the chime. The status bar does **not** say processing.
2. Click **Just me** → the toast closes → an `emailing` card "Saving to SharePoint and emailing to you…" → a ready card ending "Invitees haven't received it." with **Send to 1 invitee**.
3. Click **Send to 1 invitee** → "Sending the transcript to 1 invitee…" → "Sent to {address}."
4. `backend/var/store.json`: that meeting has `"invitee_decision": "approved"`, `"invitee_delivery_status": "sent"`, and `delivery_recipients` still lists only you.

Repeat with no attendee picked: expect no card and no toast, straight to the ready card (live check L6).

- [ ] **Step 13: Commit**

```bash
git diff --check && git diff --stat
git add src/renderer/src/lib/deliveryNotice.ts src/renderer/src/App.tsx src/renderer/src/screens/HomeScreen.tsx scripts/verify-email-notice.ts scripts/verify-invitee-cards.ts
git commit -m "feat(in-488): hold delivery on the owner's answer, with a pending card and send-later"
```

---

### Task 13: Startup resurfacing and the dismissed set

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/screens/HomeScreen.tsx`
- Test: `scripts/verify-invitee-cards.ts`

**Interfaces:**
- Consumes: `fetchMeetingDtos`, `fetchInvitees`, `postInviteeDecision` (Task 10); `resurfaceKind`, `resurfacedSendLaterMessage`, `parseDismissed`, `withDismissed`, `DISMISSED_INVITEE_CARDS_KEY` (Task 10); `runDeliveryPass`, `sendToInvitees` (Tasks 11–12).
- Produces: `HomeScreen` props `inviteeCards?: InviteeResurfacedCard[]`, `onAnswerInviteeCard?: (meetingId: string, approved: boolean) => void`, `onSendInviteeCard?: (meetingId: string) => void`, `onDismissInviteeCard?: (meetingId: string) => void`, where `InviteeResurfacedCard = { meetingId: string; title: string; kind: 'pending' | 'send_later'; candidates: InviteeCandidate[]; emailedAt: string | null }` is exported from `HomeScreen.tsx`.

There is no toast and no timer on this path: the owner decides when they open the app (spec §2, "Restart during the hold").

- [ ] **Step 1: Write the failing wiring pins**

In `scripts/verify-invitee-cards.ts`, add directly above the final `console.log`:

```ts
// ---- wiring pins (Task 13) ---------------------------------------------------
{
  const read = (...parts: string[]): string => readFileSync(join(process.cwd(), 'src', 'renderer', 'src', ...parts), 'utf8')
  const app = read('App.tsx')
  assert.match(app, /resurfaceKind\(/, 'launch scan uses the pure restart filter')
  assert.match(app, /DISMISSED_INVITEE_CARDS_KEY/, 'dismissal is a per-machine UI preference in localStorage')
  const scan = app.slice(app.indexOf('resurfaceKind('))
  assert.ok(
    scan.indexOf('prompt_enabled') !== -1 && scan.indexOf('prompt_enabled') < scan.indexOf('setInviteeCards('),
    'no card is built under the kill switch'
  )
  const home = read('screens', 'HomeScreen.tsx')
  assert.match(home, /resurfacedSendLaterMessage\(/, 'send-later card shows when the owner was emailed')
  assert.doesNotMatch(
    home.slice(home.indexOf('function InviteeResurfacedNotice')),
    /promptInvitees/,
    'no toast and no timer after a restart'
  )
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run verify:invitee-cards`
Expected: `AssertionError: launch scan uses the pure restart filter`.

- [ ] **Step 3: Add state, storage helpers and the launch scan to `App.tsx`**

Extend the `./lib/api` import list with `fetchMeetingDtos`. Extend the `./lib/inviteePrompt` import list with `DISMISSED_INVITEE_CARDS_KEY`, `parseDismissed`, `resurfaceKind`, `withDismissed`. Change the `HomeScreen` import to:

```ts
import { HomeScreen, type InviteeResurfacedCard } from './screens/HomeScreen'
```

At module level, directly below `loadUser`:

```ts
// IN-488: dismissed "Send to N invitees" cards. A UI preference, not delivery
// state, so it lives beside USER_KEY in localStorage and is per machine.
function loadDismissedInviteeCards(): string[] {
  try {
    return parseDismissed(localStorage.getItem(DISMISSED_INVITEE_CARDS_KEY))
  } catch {
    return []
  }
}

function rememberDismissedInviteeCard(meetingId: string): void {
  try {
    localStorage.setItem(
      DISMISSED_INVITEE_CARDS_KEY,
      JSON.stringify(withDismissed(loadDismissedInviteeCards(), meetingId))
    )
  } catch {
    // Storage unavailable: the card simply comes back on the next launch.
  }
}

const RESURFACED_INVITEE_CARD_LIMIT = 10
```

Directly after the `inviteeHoldsRef` declaration:

```ts
  // IN-488: questions and send-later actions that survived a restart.
  const [inviteeCards, setInviteeCards] = useState<InviteeResurfacedCard[]>([])
```

Directly after the unuploaded-recordings `useEffect` (the one that ends `}, [user])` just above the capture status listener effect):

```ts
  // IN-488 (spec §3.4): a restart during the hold loses the renderer's watcher,
  // so nothing fires. On launch, meetings from the last 7 days that still owe
  // the owner a question, or that went to the owner only, come back as cards.
  // No toast and no timer here: the owner decides when they open the app.
  const signedInEmail = user?.email
  useEffect(() => {
    if (!signedInEmail) return
    let cancelled = false
    void (async () => {
      try {
        const meetings = await fetchMeetingDtos()
        if (cancelled || !meetings) return
        const dismissed = new Set(loadDismissedInviteeCards())
        const now = Date.now()
        const cards: InviteeResurfacedCard[] = []
        for (const meeting of meetings) {
          const kind = resurfaceKind(meeting, now, dismissed)
          // A meeting whose hold is live in this session already has its card.
          if (!kind || inviteeHoldsRef.current.has(meeting.id)) continue
          const state = await fetchInvitees(meeting.id, signedInEmail)
          if (cancelled) return
          // prompt_enabled=false is the kill switch (or the attendees override):
          // no question and no send-later action may be offered.
          if (!state || !state.prompt_enabled || state.candidates.length === 0) continue
          cards.push({
            meetingId: meeting.id,
            title: meeting.title,
            kind,
            candidates: state.candidates,
            emailedAt: meeting.delivery_emailed_at ?? null
          })
          if (cards.length >= RESURFACED_INVITEE_CARD_LIMIT) break
        }
        if (!cancelled && cards.length) setInviteeCards(cards)
      } catch {
        // Best-effort; the scan simply runs again on the next launch.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [signedInEmail])
```

The dependency is the email string, not the `user` object: `retryTranscriptEmail` replaces `user` with a fresh object on every sign-in, which would otherwise re-run the scan mid-delivery. It is named `signedInEmail`, not `recorderEmail`, because `retryTranscriptEmail` and `runDeliveryPass` already use `recorderEmail` as a local.

- [ ] **Step 4: Add the card actions (below the early return)**

Directly below `sendToInvitees`:

```ts
  // Restart cards (IN-488). Each leaves the list at once and hands over to the
  // single post-capture notice, the same hand-off the unuploaded cards use.
  const takeInviteeCard = (meetingId: string): InviteeResurfacedCard | undefined => {
    const card = inviteeCards.find((entry) => entry.meetingId === meetingId)
    setInviteeCards((list) => list.filter((entry) => entry.meetingId !== meetingId))
    return card
  }

  const answerInviteeCard = async (meetingId: string, approved: boolean): Promise<void> => {
    const card = takeInviteeCard(meetingId)
    if (!card) return
    setPostCaptureNotice({
      state: 'emailing',
      meetingId,
      title: card.title,
      message: emailingMessage(approved, card.candidates.length)
    })
    await postInviteeDecision(meetingId, approved, 'app')
    await runDeliveryPass(meetingId, card.title, user.email, 'first')
  }

  const sendInviteeCard = (meetingId: string): void => {
    const card = takeInviteeCard(meetingId)
    if (card) void sendToInvitees(meetingId, card.title, card.candidates.length)
  }

  const dismissInviteeCard = (meetingId: string): void => {
    rememberDismissedInviteeCard(meetingId)
    takeInviteeCard(meetingId)
  }
```

In `deliverWithInviteeHold`, directly above the `setPostCaptureNotice({ state: 'awaiting_invitees', … })` call, add:

```ts
    // A restart card for this meeting would now be a second copy of the question.
    setInviteeCards((list) => list.filter((entry) => entry.meetingId !== meetingId))
```

In the `<HomeScreen … />` JSX, add after `onSendToInvitees={…}`:

```tsx
          inviteeCards={inviteeCards}
          onAnswerInviteeCard={(meetingId, approved) => void answerInviteeCard(meetingId, approved)}
          onSendInviteeCard={sendInviteeCard}
          onDismissInviteeCard={dismissInviteeCard}
```

- [ ] **Step 5: Render the cards in `HomeScreen.tsx`**

Extend the `../lib/inviteePrompt` import with `inviteeQuestion` and `resurfacedSendLaterMessage`.

Add above `interface HomeProps`:

```ts
/** IN-488: a question or a send-later action that survived a restart. */
export interface InviteeResurfacedCard {
  meetingId: string
  title: string
  kind: 'pending' | 'send_later'
  candidates: InviteeCandidate[]
  emailedAt: string | null
}
```

Add to `interface HomeProps`, after `onSendToInvitees?: …`:

```ts
  inviteeCards?: InviteeResurfacedCard[]
  onAnswerInviteeCard?: (meetingId: string, approved: boolean) => void
  onSendInviteeCard?: (meetingId: string) => void
  onDismissInviteeCard?: (meetingId: string) => void
```

Add `inviteeCards,`, `onAnswerInviteeCard,`, `onSendInviteeCard,` and `onDismissInviteeCard,` to the destructured props.

In the JSX, directly after the `unuploadedRecordings?.map(...)` block and before the post-capture notice:

```tsx
      {inviteeCards?.map((card) => (
        <InviteeResurfacedNotice
          key={card.meetingId}
          card={card}
          onAnswer={onAnswerInviteeCard}
          onSend={onSendInviteeCard}
          onDismiss={onDismissInviteeCard}
        />
      ))}
```

Add directly above `function PostCaptureNotice`:

```tsx
function InviteeResurfacedNotice({
  card,
  onAnswer,
  onSend,
  onDismiss
}: {
  card: InviteeResurfacedCard
  onAnswer?: (meetingId: string, approved: boolean) => void
  onSend?: (meetingId: string) => void
  onDismiss?: (meetingId: string) => void
}): JSX.Element {
  const pending = card.kind === 'pending'
  const namesLine = pending ? inviteeNamesLine(card.candidates) : null
  const toneClass = pending
    ? 'border-edge-info bg-bg-info text-content-info'
    : 'border-edge-success bg-bg-success text-content-success'
  const buttonClass =
    'rounded-sm border-[0.5px] border-current px-2 py-1 text-[12px] opacity-85 hover:opacity-100'

  return (
    <div className={`rounded-md border-[0.5px] px-3 py-2.5 ${toneClass}`}>
      <div className="flex items-start gap-2">
        <div className="mt-0.5 shrink-0">
          {pending ? (
            <Mail size={16} strokeWidth={1.75} />
          ) : (
            <CheckCircle2 size={16} strokeWidth={1.75} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{card.title}</div>
          <div className="mt-0.5 text-[12px] opacity-90">
            {pending ? inviteeQuestion(card.candidates) : resurfacedSendLaterMessage(card.emailedAt)}
          </div>
          {namesLine && <div className="mt-0.5 text-[12px] opacity-90">{namesLine}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {pending && onAnswer && (
            <>
              <button type="button" className={buttonClass} onClick={() => onAnswer(card.meetingId, true)}>
                Email invitees
              </button>
              <button type="button" className={buttonClass} onClick={() => onAnswer(card.meetingId, false)}>
                Just me
              </button>
            </>
          )}
          {!pending && onSend && (
            <button type="button" className={buttonClass} onClick={() => onSend(card.meetingId)}>
              {sendLaterLabel(card.candidates.length)}
            </button>
          )}
          {/* Only a send-later card can be dismissed; a pending question is
              answered, and "Just me" is its way out. */}
          {!pending && onDismiss && (
            <button
              type="button"
              className="text-[12px] opacity-80 hover:opacity-100"
              onClick={() => onDismiss(card.meetingId)}
            >
              Dismiss
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npm run verify:invitee-cards && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 7: Restart walkthrough**

> **Deferred to Joseph (22 Sep ruling).** This step drives the Electron GUI by hand, which a subagent cannot do. Implementer: skip it, say so in your report, and do not claim it ran. It stays here as Joseph's pre-release walkthrough; the harness pins in this task are the automated evidence.

With the Task 12 stub setup: upload a recording with an attendee picked, and when the pending card appears **quit the app from the tray** (do not answer). Relaunch with `npm run dev`. Expect the pending card on Home with both buttons, **no toast and no chime**. Click **Just me** → ready card with **Send to 1 invitee**. Click **Dismiss**, quit, relaunch: expect a send-later card reading "Emailed to you on {day date, time}. Invitees haven't received it." Dismiss it, relaunch again: it stays gone. DevTools → Application → Local Storage shows `mn.inviteeCards.dismissed` containing that meeting id.

- [ ] **Step 8: Commit**

```bash
git diff --check && git diff --stat
git add src/renderer/src/App.tsx src/renderer/src/screens/HomeScreen.tsx scripts/verify-invitee-cards.ts
git commit -m "feat(in-488): resurface unanswered and organiser-only meetings after a restart"
```

---

### Task 14: CI, release wiring, runbook, evidence, hand-off

**Files:**
- Modify: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `docs/rollout-runbook.md`, `docs/jira-progress.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a branch that is green in CI and ready for Joseph's live checks. **This task does not tag or release.**

- [ ] **Step 1: Run the new harnesses in CI (Q13)**

In `.github/workflows/ci.yml`, in the `Renderer and main-process fixtures` step, add directly after `npm run verify:toast-xml`:

```yaml
          npm run verify:invitee-prompt
          npm run verify:invitee-cards
          npm run verify:email-notice
```

`verify:email-notice` was never in CI. It now guards the single delivery pass every send goes through (Task 11), so it joins the list.

- [ ] **Step 2: Correct the release log line**

In `.github/workflows/release.yml`, in the `MN_DELIVERY_RECIPIENTS` block, replace

```powershell
            Write-Host "Delivery recipients mode: organizer (code default; invitee fan-out OFF)"
```

with

```powershell
            Write-Host "Delivery recipients mode: ask (code default; the owner is asked before invitees are emailed). Kill switch: set the MN_DELIVERY_RECIPIENTS repo variable to organizer."
```

- [ ] **Step 3: Add the runbook entry**

In `docs/rollout-runbook.md`, add this section directly after the `## Auto-record trigger (v2.0.30+)` section:

```markdown
## Invitee email prompt (IN-488)

When notes are ready, the recording owner is asked **Email invitees** or
**Just me**, as a Windows toast and as a card on Home at the same time. Nothing
is saved to SharePoint or emailed until they answer. No answer in 2 minutes
counts as **Just me**. A "Just me" meeting keeps a **Send to N invitees**
button on its card; using it emails the invitees only, never the owner again.
If the app is closed while it is waiting, the question comes back as a card on
the next launch (meetings from the last 7 days).

`MN_DELIVERY_RECIPIENTS` is the delivery mode:

| Value | Behaviour |
|---|---|
| `ask` | Code default. The prompt flow above. |
| `organizer` | **Kill switch.** Never ask, owner only: exactly v2.0.29–v2.0.39. Also removes "Send to N invitees" and ignores any approval already stored. |
| `attendees` | Invitees always receive it; nobody is asked. |
| anything else, or blank | Treated as `organizer`. |

- **Kill switch, one machine, no release:** put `MN_DELIVERY_RECIPIENTS=organizer`
  in `%PROGRAMDATA%\Factor1\MeetingNotetaker\backend.env` and restart the app
  (the same layer as the auto-record trigger's kill switch).
- **Kill switch, fleet:** set the `MN_DELIVERY_RECIPIENTS` repo variable to
  `organizer` and cut a release. Flipping it back to `ask` restores any stored
  approvals.
- **Check on release day:** `gh variable list` must show no
  `MN_DELIVERY_RECIPIENTS` (or `ask`), otherwise the release ships with the
  prompt off. The release log prints the mode.
- **Field signal:** grep `[invitee-prompt]` in a problem report's `main.log`
  (`shown` / `answered` / `timeout` / `stale-click`). If `timeout` dominates,
  the toast is being missed or 2 minutes is too short; both are one constant.
```

- [ ] **Step 4: Full verification sweep**

```bash
npm run typecheck
npm run build
for h in toast-xml invitee-prompt invitee-cards email-notice join-watch call-signals call-watch-registrar recording-controls failure-chips backend-supervisor; do npm run verify:$h || break; done
cd backend
/c/Projects/meeting-notetaker-2/backend/.venv/Scripts/python.exe -m pytest tests --deselect tests/test_storage_api_meetings.py::StubMeetingDeliveryTests::test_stub_serializes_concurrent_exports_for_one_meeting -q 2>&1 | tail -15
uvx ruff check app tests
cd ..
git diff --check
```

Expected: every harness prints its "passed" line; backend failures, if any, are all names from the Task 0 baseline; ruff reports nothing new; `git diff --check` is silent.

- [ ] **Step 5: Record the evidence**

Append to `docs/jira-progress.md`:

```markdown
## IN-488 — Ask before emailing invitees (branch `feature/invitee-email-prompt`)

Spec `docs/superpowers/specs/2026-09-21-in488-invitee-prompt-design.md`, plan
`docs/superpowers/plans/2026-09-21-in488-invitee-prompt.md`.

- [x] Backend: `invitee_decision` + a separate `invitee_delivery_status` machine
  (D7); delivery mode `ask` / `organizer` / `attendees`; `GET /invitees`,
  `POST /invitees/decision`; held first send and an invitee-only later send.
  Tests: `test_invitee_candidates.py`, `test_invitee_decision.py`, plus
  additions to `test_email_idempotency.py`, `test_delivery_reliability.py`,
  `test_organizer_only_delivery.py`, `test_email_recipients.py`.
- [x] Pinned: a failed or interrupted invitee send never touches
  `delivery_status` / `delivery_recipients`, so the organiser is never
  re-emailed; the `organizer` kill switch blocks a stored approval.
- [x] Desktop: toast with `?meeting=` routing, pure prompt engine with a
  timeout that fires the safe default, pending / emailing / send-later cards,
  restart resurfacing. Harnesses `verify:invitee-prompt`,
  `verify:invitee-cards`, `verify:toast-xml`, `verify:email-notice` (all in CI).
- [x] Behaviour change, deliberate (D2): ad-hoc attendees are emailable once
  approved. `test_adhoc_recording_still_emails_recorder_only` was replaced.
- [ ] Live checks L1–L8 (Joseph + DA, packaged test build).
- [ ] Release: own version, FIC subject patched to the exact tag first.
```

- [ ] **Step 6: Commit and push the branch**

```bash
git diff --check && git diff --stat
git add .github/workflows/ci.yml .github/workflows/release.yml docs/rollout-runbook.md docs/jira-progress.md
git commit -m "chore(in-488): CI harnesses, release log line, runbook entry and evidence"
```

**Do not push.** This branch is stacked on the hardening, whose 16 commits have never left this machine; pushing it would publish them. Pushing is Joseph's call, after the hardening lands and this branch is rebased onto `main`. CI therefore has not run: the local sweep in Step 4 is the evidence.

- [ ] **Step 7: Hand off to Joseph — STOP here**

Do **not** merge, tag or release. Report the following to Joseph.

**Live checks** (Joseph as organiser, DA as invitee). Use a packaged test build with its own `--user-data-dir` profile, as on `docs/superpowers/plans/2026-08-19-join-trigger-live-run-sheet.md`, and fully quit the installed app first. Toast buttons only work in a packaged build: the `notetaker://` scheme is not registered in dev.

| # | Scenario | Pass looks like |
|---|---|---|
| L1 | Calendar meeting, **Email invitees** on the toast | One email to both; transcript in DA's "Shared with me" |
| L2 | **Just me** on the card, then **Send to invitees** | Joseph gets one email only; DA gets one later; nothing duplicated |
| L3 | Ignore the prompt | Organiser-only email at about 2:00; the card offers Send |
| L4 | Ad-hoc recording with DA picked as attendee | Prompt appears; Yes emails DA (the first time ad-hoc email exists) |
| L5 | Quit the app during the hold, relaunch | Pending card, no toast; deciding delivers |
| L6 | Solo ad-hoc, nobody picked | No prompt, immediate delivery |
| L7 | `MN_DELIVERY_RECIPIENTS=organizer` in the `%PROGRAMDATA%` layer | No prompt, organiser-only, no Send button |
| L8 | Signed out of Outlook, answer Yes | Failed card, Retry signs in, sent once |

After hardening, a Yes whose SharePoint privacy preflight fails still emails the invitees and shows the failed card with Retry; that is how the pass already treats the organiser (spec, "Behavioural overlap"). Watch for it on L1.

**Release ritual (Joseph's):**
1. Write the release plan in the `docs/v2.0.30-release-plan.md` format (Gate, Cut sequence, Post-release), named for the next version after `package.json`'s.
2. `gh variable list` on `Factor1-Accountants-Advisers/meeting-notetaker`: `MN_DELIVERY_RECIPIENTS` must be absent or `ask`.
3. **Patch the signing FIC subject to the exact new tag before pushing any `v*` tag** (the v2.0.31 trap, 25 Aug).
4. DA's team note: "You'll now be asked before invitees get the transcript. No answer within two minutes means only you get it; you can send it to them later from the app."
5. Jira: the MCP posts as David, so draft any IN-488 comment for Joseph to paste. DA's 21 Sep green light is still not on the ticket.
6. First week: grep `[invitee-prompt]` in problem-report logs.
