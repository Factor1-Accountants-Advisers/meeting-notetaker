# IN-391 — Pipeline error handling and status reporting (design)

**Date:** 2026-07-29
**Jira:** IN-391 (Slice 2, IN-375)
**Status:** Approved design, pre-implementation

## Problem

Local processing and delivery failures are handled, but inconsistently:
error text shown to users is sometimes a raw exception
(`routers/meetings.py:697` interpolates `{exc}` into
`sharepoint_error_message`; the email path does the same at `:611`), failure
"codes" are exception class names, retry semantics differ by concern and are
undocumented, and there is no defined behaviour statement for partial
delivery success (SharePoint saved, Blob failed, or vice versa).

The durable machinery itself already exists and is NOT rebuilt here:
per-concern status enums (`PipelineStatus`/`PipelineStage`,
`DeliveryStatus`, `BlobStatus`, `SharePointStatus`), per-concern
`*_error_message` fields, startup interrupted-marking, the stall watchdog,
and `store.json` + retained local audio as durable failed-job storage.

## Decisions (agreed 29 Jul 2026)

1. **Retry policy: manual only.** Failures land in a retryable state with a
   clear reason; the user retries. No automatic/background retries.
2. **Partial success: independent targets, retry-failed-only.** A succeeded
   target is never re-run by a retry of another target.
3. **Failure UX: category + plain sentence.** `Failed: [category]` chip on
   the meeting card; category + action-oriented sentence + per-concern Retry
   on the review screen. Raw technical detail never renders in the UI.
4. **Implementation shape: Approach A** — a thin failure-taxonomy layer over
   the existing state machines. No orchestrator refactor, no failure-event
   ledger (can bolt on later if support forensics demand it).

## 1. Failure taxonomy and classifier

New module `backend/app/services/failure_reasons.py`.

```python
class FailureCategory(str, Enum):
    network = "network"
    azure_signin = "azure_signin"
    service_unavailable = "service_unavailable"
    audio_problem = "audio_problem"
    processing_error = "processing_error"
    interrupted = "interrupted"
    stalled = "stalled"

@dataclass(frozen=True)
class FailureReason:
    category: FailureCategory
    user_sentence: str      # rendered in UI; from the fixed table below
    technical_detail: str   # logs / Report Problem only; truncated to 500

def classify(exc: BaseException, *, stage: str) -> FailureReason: ...
```

Classification rules (first match wins):

| Signal | Category |
| --- | --- |
| Transport errors (`httpx.TransportError`, `urllib.error.URLError`, `ConnectionError`, `TimeoutError`, DNS) | `network` |
| HTTP 401/403 from Graph or Storage API; missing/expired token conditions (e.g. the existing "sign-in required" branches) | `azure_signin` |
| HTTP 408/429/5xx from Graph, Storage API, pyannoteAI, or OpenAI | `service_unavailable` |
| ffmpeg merge/probe failures, duration/coverage validation, unreadable audio | `audio_problem` |
| Existing startup interruption marking | `interrupted` (assigned directly at the marking site, not via `classify(exc)` — there is no exception object there) |
| Existing watchdog marking | `stalled` (same: assigned directly at the marking site) |
| Anything else | `processing_error` |

User-sentence table (DRAFT — product-voice review requested from Joseph
during spec review; one sentence per category, action-oriented):

| Category | User sentence |
| --- | --- |
| `network` | "Couldn't reach the network. Check your connection and retry." |
| `azure_signin` | "Microsoft sign-in is needed. Sign in again, then retry." |
| `service_unavailable` | "A cloud service is temporarily unavailable. Retry in a few minutes." |
| `audio_problem` | "There was a problem with the recorded audio. Retry, and report a problem if it happens again." |
| `processing_error` | "Processing failed. The recording is saved — retry to try again." |
| `interrupted` | "The app restarted while this meeting was processing. Retry to continue." |
| `stalled` | "Processing stalled before finishing. The recording is saved — retry to try again." |

## 2. Hook points

The four existing failure sites call `classify()` and store
`(category, user_sentence)` instead of ad-hoc strings. No status-machine
changes.

| Site | Change |
| --- | --- |
| Pipeline — `services/pipeline.py` catch-all (~:395) | `error_code=<category>`, `error_message=<user sentence>`; raw detail to log only. Startup/watchdog branches keep their behaviour, codes become `interrupted`/`stalled`. |
| Blob — `services/blob_delivery.py` (`BlobStatus.failed` sites) | Same treatment; new `blob_error_code` field carries category. Implementation note: several blob failure branches are condition checks with no bound exception (sign-in / prerequisite constants through `_finish()`, ~:200-322). Those map to categories directly (sign-in → `azure_signin`, prerequisite → `processing_error`) via a `FailureReason.for_category(...)` constructor; `classify(exc)` is only for branches that actually catch an exception, which must be bound (`except Exception as exc:`). |
| SharePoint — `routers/meetings.py` (~:697) | Replace `f"SharePoint save failed: {exc}"` with user sentence; new `sharepoint_error_code`. The existing explicit sign-in branch (~:661-662) maps to `azure_signin` with its current message retained. |
| Email — `routers/meetings.py` (~:611) | Replace `f"Email delivery failed: {exc}"` with user sentence; new `delivery_error_code`. `DeliveryStatus.unconfirmed` semantics and its check-your-inbox wording are unchanged (IN-478 outcome). |

**Schema delta:** add `blob_error_code`, `sharepoint_error_code`,
`delivery_error_code` (`str | None = None`) to the meeting model.
Backward-compatible: old `store.json` entries load with `None` codes.
`processing_error_code` already exists and is reused.

## 3. User-visible surfacing (renderer)

- `MeetingsScreen` card: one compact chip `Failed: <Category label>` when
  any concern is `failed`. If several concerns failed, show the worst-first
  order: processing → blob → sharepoint → email (processing failure makes
  downstream statuses meaningless). The card shows only the top chip; the
  full set of failed concerns is visible on `MeetingReviewScreen` (one row
  per failed concern, below).
- `DeliveryStatus.unconfirmed` is **not** a failure and never renders a
  `Failed:` chip: the send may already have been delivered (IN-478), and a
  "Failed" label would invite exactly the duplicate resend that state
  exists to prevent. It gets its own distinct chip, `Email unconfirmed`,
  and keeps the existing check-your-inbox wording and no
  `delivery_error_code` on the review screen. A failed chip and the
  unconfirmed chip can co-exist on one card (e.g. blob failed + email
  unconfirmed).
- `MeetingReviewScreen`: one row per failed concern — category label, user
  sentence, and that concern's existing Retry action only.
- Category labels for display: Network, Microsoft sign-in, Service
  unavailable, Audio problem, Processing error, Interrupted, Stalled.
- No raw exception text, HTTP bodies, or stack traces in any renderer
  surface.

## 4. Retry and partial-success semantics (behavioural contract)

- Manual retry only, per concern. Retrying processing re-runs the pipeline
  from stored local audio; retrying a delivery target re-attempts only that
  target.
- Partial-success matrix (documented behaviour, already representable
  today):

| SharePoint | Blob | Behaviour |
| --- | --- | --- |
| saved | failed | Meeting stays `ready`; Blob row shows Failed + Retry; SharePoint untouched by Blob retry. |
| failed | uploaded | Mirror image; SharePoint retry re-runs upload+grant atomically (IN-387 contract), Blob untouched. |
| failed | failed | Both rows failed; each retried independently. |

- Blob re-upload is idempotent server-side: the Storage API export PUT is
  write-once with automatic history snapshotting (IN-386 — merged to
  storage-api `main` at `4dc0736` and deployed to production 28 Jul 2026,
  Deploy run `30335569135`; see the IN-386 release addendum in
  `docs/jira-progress.md`), so a duplicate export can never destroy data.
  SharePoint retry re-runs upload + grant from scratch by design (IN-387 —
  Done, live-verified against the real Transcriptions library 29 Jul
  2026).
- **Audio preservation guarantee:** local audio is never deleted because of
  a failure; only the retention policy after a successful pipeline
  (`ready`) may remove it. This is stated behaviour, and a test pins it.
- Failed-job storage is the existing durable model (`store.json` +
  retained audio + startup recovery + stall watchdog); nothing new is
  added.

## 5. Support logging

At every hook point, one structured line to the backend logger (surfaces in
`main.log`, therefore in the IN-473 Report Problem bundle automatically):

```
delivery_failure meeting=<uuid> stage=<pipeline|blob|sharepoint|email>
category=<category> code=<ExceptionClass|branch-name> detail=<truncated 500>
```

For exception-less branches (`FailureReason.for_category(...)` sites and the
startup/watchdog markings), `code=` carries a stable branch name (e.g.
`code=signin_check`, `code=watchdog`) instead of an exception class, so the
log format stays uniform and greppable.

Existing guidance from IN-386 review is preserved: where a provider error
could embed sensitive material (e.g. SAS URLs), log the class and a
sanitised detail, not the full exception repr.

## 6. Testing

- Table-driven classifier tests: representative exception per rule row →
  expected category and sentence; unknown exception → `processing_error`.
- Per hook point: a failure-injection test asserting (a) status becomes
  `failed`, (b) `*_error_code` is a valid category, (c) `*_error_message`
  contains no raw exception text.
- Backward-load test: legacy meeting dict without the new `_code` fields
  loads with `None`.
- Audio-preservation test: failed pipeline leaves the meeting's audio files
  on disk.
- Renderer: chip rendering (single and multi-failure ordering), per-concern
  sentence + Retry wiring.
- Full suite green (known pre-existing
  `test_stub_serializes_concurrent_exports_for_one_meeting` flake
  excepted).

## 7. Documentation deliverable

`docs/pipeline-error-handling.md`: the four state machines, the taxonomy
and sentence table, classification rules, retry rules, the partial-success
matrix, the audio-preservation guarantee, and the support-log line format.
Referenced from the IN-391 Jira closing comment.

## Out of scope

- Automatic/background retries or retry queues (revisit only if manual
  retry proves insufficient in the field).
- Failure-event history ledger (Approach B; bolt-on later if needed).
- Any change to `DeliveryStatus.unconfirmed` semantics (IN-478 outcome).
- Pipeline stage consolidation (IN-390) and its error surfaces — IN-390
  should adopt this taxonomy when it lands, not the reverse.
