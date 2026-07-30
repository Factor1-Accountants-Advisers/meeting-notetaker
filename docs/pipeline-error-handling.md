# Pipeline error handling and status reporting (IN-391)

Reference for the failure taxonomy, per-concern state machines, retry rules,
and support logging shipped on `in391-error-reporting`. This documents
as-built behaviour, verified against code on this branch — not the original
spec's draft language where the two differ (noted inline).

Source: `docs/superpowers/specs/2026-07-29-in391-pipeline-error-handling-design.md`
(approved design) and `docs/superpowers/plans/2026-07-29-in391-pipeline-error-handling.md`
(implementation record, incl. amendments).

## 1. The four per-concern state machines

Processing and each delivery target are independent state machines. A
meeting can be `ready` with SharePoint `saved`, Blob `failed`, and email
`unconfirmed` all at once.

### `PipelineStatus` (`backend/app/schemas.py`)

| Value | Meaning |
| --- | --- |
| `pending_audio` | Meeting created, no recording uploaded yet. |
| `queued` | Audio stored, waiting for a pipeline task to start. |
| `processing` | Transcribe → diarize → match speakers → summarise is running. |
| `ready` | Pipeline finished; transcript/summary/action items available. |
| `failed` | Flagged for manual retry — from a caught exception, a startup interrupted-marking, or the stall watchdog. |

### `PipelineStage` (`backend/app/schemas.py`)

`pending_audio` → `audio_uploaded` → `queued` → `transcribing_diarizing` →
`identifying_speakers` → `extracting_notes` → `ready` (or `failed` from any
in-flight stage). Each transition also sets a user-safe
`pipeline_stage_message` (see §7 for one place this message and the
taxonomy sentence intentionally diverge).

### `BlobStatus` (`backend/app/schemas.py`)

| Value | Meaning |
| --- | --- |
| `pending` | Delivery to the Storage API is queued/in-flight. |
| `uploaded` | Export JSON (and audio, when requested) delivered. |
| `failed` | Delivery failed; `blob_error_code`/`blob_error_message` set; retryable. |

### `SharePointStatus` (`backend/app/schemas.py`)

| Value | Meaning |
| --- | --- |
| `not_started` | Save has not been attempted. |
| `saving` | Upload + view-grant in progress. |
| `saved` | File uploaded and view access granted (atomically — see §3). |
| `failed` | Save or grant failed; `sharepoint_error_code`/`sharepoint_error_message` set; retryable. |

### `DeliveryStatus` (`backend/app/schemas.py`, email)

| Value | Meaning |
| --- | --- |
| `not_started` | No send attempted. |
| `emailing` | Send in flight; persisted to disk *before* the send (IN-478) so a crash mid-send is recoverable. |
| `emailed` | Confirmed sent; `delivery_recipients`/`delivery_emailed_at` recorded for idempotent replay. |
| `unconfirmed` | Send outcome unknown (timeout/connection/5xx after the request, or a backend restart mid-send). |
| `failed` | Definitively did not send (e.g. a Graph 4xx, or no Graph token). |

**`unconfirmed` is not a failure** (IN-478 rationale, `pipeline.py`
`reconcile_interrupted_pipelines` and `routers/meetings.py`
`email_notes`'s `EmailDeliveryUnconfirmed` handler): the message may already
have reached the recipient, so treating it as `failed` would invite exactly
the duplicate-resend bug IN-478 fixed. `delivery_error_code` is explicitly
`None` on this transition. The UI never renders a `Failed:` chip for it — see
§6.

## 2. Failure taxonomy

Module: `backend/app/services/failure_reasons.py`. Eight categories, each
with one fixed, product-voice user sentence. User-facing fields only ever
carry these sentences; raw exception text is confined to
`technical_detail` (truncated to 500 chars) and the support log line (§5).

| Category | User sentence |
| --- | --- |
| `network` | "Couldn't reach the network. Check your connection and retry." |
| `azure_signin` | "Microsoft sign-in is needed. Sign in again, then retry." |
| `provider_credentials` | "A processing service credential needs attention. Ask an administrator to update it, then retry." |
| `service_unavailable` | "A cloud service is temporarily unavailable. Retry in a few minutes." |
| `audio_problem` | "There was a problem with the recorded audio. Retry, and report a problem if it happens again." |
| `processing_error` | "Processing failed. The recording is saved — retry to try again." |
| `interrupted` | "The app restarted while this meeting was processing. Retry to continue." |
| `stalled` | "Processing stalled before finishing. The recording is saved — retry to try again." |

### Classification rules (`classify(exc, *, stage)`), first match wins

1. **Cause unwrapping.** Walk `exc.__cause__` up to 5 hops (bounded, avoids
   cycles) to a `root` exception. A wrapper raised with `raise ... from
   cause` (e.g. `MeetingVoiceprintsUnavailable` in
   `meeting_voiceprints.py:178`) classifies by what actually failed
   underneath, not by the wrapper's own text. `technical_detail` still names
   the outer wrapper, plus `" (cause: {root})"` when unwrapping changed
   anything, newline-flattened and truncated to 500 chars.
2. **HTTP status detection.** `_status_code(root)` probes, in order,
   `status_code` / `status` / `code` int attributes, then
   `root.response.status_code`. This `.code` probe is what makes a real
   `urllib.error.HTTPError` (pyannoteAI, Graph via `urllib`) classify
   correctly — `HTTPError.code` is where the status lives.
3. Status in `{401, 403}` with a `StorageApiError` anywhere in the cause
   chain → `azure_signin`, regardless of stage. Storage API calls (e.g.
   voiceprint resolution, which runs inside the pipeline try block)
   authenticate with the user's delegated Microsoft token, so signing in
   again is the correct remediation.
4. Otherwise, status in `{401, 403}` at `stage="pipeline"` →
   `provider_credentials`. This covers pyannoteAI and OpenAI application
   credentials; retrying Microsoft sign-in cannot repair these failures.
5. Status in `{401, 403}` at a delivery stage (`blob`, `sharepoint`, or
   `email`) → `azure_signin`, preserving the delegated Microsoft-token
   guidance on those surfaces.
6. Status in `{408, 429}` or `status >= 500` → `service_unavailable`.
7. **File-error exclusion, then network.** `_FILE_ERROR_TYPES`
   (`FileNotFoundError`, `PermissionError`, `IsADirectoryError`,
   `NotADirectoryError`, `FileExistsError`) are *never* `network`, checked
   before anything else — these are local file-op errors even though they
   subclass `OSError` and may carry no `filename` (e.g.
   `FileNotFoundError(local_path)` is a valid single-arg raise that leaves
   `filename` as `None`, indistinguishable from a socket error by that
   attribute alone). Otherwise, `isinstance(root, OSError) and
   root.filename is None` → `network` — this covers `ConnectionError`,
   `TimeoutError`, and `urllib.error.URLError`, all of which subclass
   `OSError` and carry no `filename`.
8. Anything else → `processing_error`.
9. **`StorageApiUnavailable` (blob only, explicit, not via `classify()`).**
   `storage_api.py` raises this from three sites with three different cause
   chains: `:544` (5xx status check) has no active exception, so no
   `__cause__`; `:551` (`except http.client.HTTPException:`) raises `from
   None`, an explicit no-cause; `:552-553` (`except OSError as exc:`) raises
   `from exc`, carrying the OSError as `__cause__`. Generic `classify()`
   would therefore be inconsistent across the three variants —
   `processing_error` for the first two (no useful cause, no HTTP status),
   `network` for the third (the unwrapped OSError) — silently downgrading
   what is always actually a Storage API outage. Every blob call site
   instead catches `StorageApiUnavailable` before the generic `except
   Exception` and maps all three variants explicitly via
   `FailureReason.for_category(service_unavailable, ...)`, logged with
   `code="StorageApiUnavailable"`.
9. **`interrupted` / `stalled` are never produced by `classify()`.** They
   are assigned directly via `FailureReason.for_category(...)` at the two
   marking sites that have no exception object: startup reconcile
   (`pipeline.py` `reconcile_interrupted_pipelines`) and the stall watchdog
   (`pipeline.py` `sweep_stuck_pipelines`).
10. **`audio_problem` is reserved and currently unreachable.** The category
   and its sentence exist, but no call site in the codebase produces it —
   `classify()`'s generic rules deliberately don't sniff for
   ffmpeg/audio-shaped errors (brittle), and no pipeline or blob branch
   currently has a distinct catch site for audio-preparation failures that
   would call `FailureReason.for_category(audio_problem, ...)`. Any
   ffmpeg/audio-validation failure that reaches the pipeline's generic
   catch-all today classifies as `processing_error`. This is deliberate
   (plan Task 1/3), not a bug — the category is wired end-to-end (schema,
   renderer label `Audio problem`) and ready for a future site to use.

## 3. Retry rules and partial-success

- **Manual only, per concern.** No automatic/background retries. Retrying
  processing re-runs the pipeline from stored local audio; retrying a
  delivery target re-attempts only that target.
- **Retry-failed-only; independent targets.** A succeeded target is never
  re-run by a retry of another target.

| SharePoint | Blob | Behaviour |
| --- | --- | --- |
| saved | failed | Meeting stays `ready`; Blob retry re-attempts only Blob. SharePoint untouched. |
| failed | uploaded | Mirror image: SharePoint retry re-attempts only SharePoint. Blob untouched. |
| failed | failed | Both retried independently. |

- **Blob export idempotency (IN-386).** The Storage API export `PUT` is
  write-once with automatic history snapshotting server-side (verified:
  Storage API `in386-meeting-blob-delivery` merged to `main` at `4dc0736`,
  deployed to production, GitHub Actions `Deploy` run `30335569135` — see
  `docs/jira-progress.md` IN-386 entry). A duplicate export from a Blob
  retry can never destroy data.
- **SharePoint retry re-runs both file uploads + grants atomically
  (IN-385/IN-387).**
  `routers/meetings.py` `save_transcript_to_sharepoint` performs
  transcript upload/grant followed by summary upload/grant inside one `try`
  block and one `SharePointStatus` transition. The transcript uses the stable
  `Title-YYYY-MM-DD.txt` name; the summary and action items use
  `Title-YYYY-MM-DD-summary.txt`. Both files use the IN-387 owner-implicit
  access plus Graph `grant_view` invite (`read`, `requireSignIn`) semantics.
  Any upload failure, grant failure, or HTTP-200 partial grant on either file
  marks the whole delivery `failed` through the IN-391 taxonomy. A retry
  redoes all four operations from scratch using the same deterministic names;
  the local locked-folder stand-in mirrors the two-file behavior. This is
  status-level atomicity: a remote first file may exist after a later step
  fails, but the meeting never reports `saved`, and retry safely overwrites
  the deterministic pair.

## 4. Audio preservation and failed-job durability

- **Never deleted on failure.** No failure-handling code path in
  `pipeline.py` or `blob_delivery.py` deletes a meeting's stored audio
  (`backend/app/services/pipeline.py:audio_path_for`). Blob delivery only
  ever copies a temporary snapshot for upload (`_snapshot_audio`) and
  removes *that copy* in a `finally` block — never the original. Pinned by
  `backend/tests/test_pipeline_failures.py`
  `test_pipeline_exception_is_classified_and_audio_preserved`
  (`audio_path.exists()` after a classified failure).
- **Retention is status-gated, then age-based.** The only thing that deletes
  audio is `backend/app/services/retention.py` `sweep_once`, which runs
  hourly. It deletes a canonical meeting audio file only when the owning
  meeting is `ready` and the file mtime is older than
  `settings.audio_retention_days` (default 30). A failed, queued, processing,
  or pending meeting keeps its source audio regardless of age, as does a file
  whose meeting cannot be identified. Retrying a failed meeting does not
  reset the mtime clock: if the original audio is already older than 30 days
  when the retry reaches `ready`, the next sweep may remove it.
- **Permanently failed means retained under the current schema.**
  `PipelineStatus.failed` is retryable and there is no separate terminal
  failure state or terminal-failure timestamp. Treating it as terminal would
  risk deleting valid retry audio, so failed audio is retained indefinitely.
  If a future product flow adds an explicit terminal-failure decision, it
  should also add a durable timestamp; retention can then start a separate
  30-day clock from that transition.
- **Failed-job storage** is the existing durable model, unchanged by
  IN-391: `store.json` (`store.save_snapshot()`, called from every failure
  site), startup interrupted-marking
  (`reconcile_interrupted_pipelines`, `reconcile_interrupted_blob_deliveries`),
  and the stall watchdog (`pipeline_watchdog_loop`, `WATCHDOG_INTERVAL_S=30s`;
  `QUEUE_STALL_S=120s`; processing limit =
  `pyannote_poll_timeout_seconds + PROCESSING_STALL_BUFFER_S(600s)`).

## 5. Support log line

Every hook point calls `log_delivery_failure(meeting_id, stage, reason,
code=...)` (`failure_reasons.py`), emitting one line via
`logging.getLogger("app.services.failure_reasons").warning(...)`:

```
delivery_failure meeting=<uuid> stage=<pipeline|blob|sharepoint|email> category=<category> code=<ExceptionClass|branch-name> detail=<truncated 500>
```

`code=` is the exception class name (`exc.__class__.__name__`) for branches
that caught a real exception, or a stable branch name for exception-less
condition checks:

| `code=` value | Site(s) |
| --- | --- |
| `signin_check` | Blob missing-token check (`blob_delivery.py:225`); SharePoint missing-token check (`meetings.py:681`); email missing-token check (`meetings.py:554`) |
| `prerequisite_check` | Blob "not ready / no export" check (`blob_delivery.py:206`) |
| `startup_reconcile` | Pipeline startup interrupted-marking (`pipeline.py` `reconcile_interrupted_pipelines`); Blob startup reconcile (`blob_delivery.py` `reconcile_interrupted_blob_deliveries`) |
| `watchdog` | Pipeline stall watchdog (`pipeline.py` `sweep_stuck_pipelines`) |
| `StorageApiUnavailable` | Every blob call site's explicit `StorageApiUnavailable` catch (rule 8 in §2) |

Python's default logging writes this to stderr; the Electron backend
supervisor (`src/main/backend-supervisor.ts`) pipes the child process's
stderr into the main-process logger (`electron-log`, `src/main/logger.ts`),
which writes to `main.log`. When the user submits the IN-473 "Report
Problem" form, `src/main/api-proxy.ts:63-66` reads that `main.log` file and
takes its last 30 lines (`.split('\n').slice(-30)`), base64-encoding them
into an `X-MN-Recent-Logs` header on the outgoing request; the backend
(`backend/app/routers/support.py:44-51`) just decodes and inlines that
header into the emailed report body under "Recent logs (main.log, last ~30
lines)". So a `delivery_failure` line rides into the bundle automatically
*if* it's still within the last 30 lines of `main.log` at report time —
`main.log` is the whole app's log, not filtered to delivery failures, so a
busy session can scroll an older failure out of that window before the
user gets around to reporting it.

## 6. UI surfacing

**Live surfaces: `HomeScreen`'s notice cards**, fed from `App.tsx`
(`postCaptureNotice`, `blobDeliveryNotices`). Both notice types carry an
optional `errorCode` field with **tri-state semantics**:

| `errorCode` | Meaning | Rendered |
| --- | --- | --- |
| a category string (e.g. `"network"`) | Known classified failure | `Failed: <Category label>` via `categoryLabel()` |
| `null` | Failed, but no specific category available at that call site (e.g. client-side give-up on a long poll, `App.tsx:907`; SharePoint-only failure surfaced under the shared `email_failed` state where no fresh `sharepoint_error_code` is in scope, `App.tsx:837`) | `Failed: Processing error` (generic fallback) |
| `undefined` (key omitted) | Not actually a failure — the email-unconfirmed sub-case of `email_failed` (IN-478, `App.tsx:849-854,866-871`) | No `Failed:` label at all; the existing check-your-inbox message renders instead |

`HomeScreen.tsx` renders the label with `failed && notice.errorCode !==
undefined` (both the blob-delivery notice and the post-capture notice use
the identical pattern), and `categoryLabel()` (`lib/failureDisplay.ts`)
falls back to `'Processing error'` for `null` or any code not in
`CATEGORY_LABELS`.

`CATEGORY_LABELS` includes `provider_credentials` as `Provider credentials`;
the label is data-driven after that shared map entry. The removed meetings
list and review screens are not renderer consumers.

## 7. Known notes / open items

- **Startup-interrupted stage message intentionally differs from the
  taxonomy sentence.** `reconcile_interrupted_pipelines` sets
  `pipeline_stage_message` to "Processing was interrupted by a backend
  restart. Retry processing when ready." but `processing_error_message` to
  `USER_SENTENCES[interrupted]` ("The app restarted while this meeting was
  processing. Retry to continue.") — two different fixed strings for two
  different UI surfaces (stage banner vs. failure sentence), not a bug. The
  watchdog's `stalled` marking uses the same string for both fields, so
  this asymmetry is specific to `interrupted`.
- **Processing-provider 401/403 is distinct from Microsoft sign-in.**
  `pyannote_client.py` wraps `urllib.error.HTTPError` as
  `PyannoteAIError(...) from exc`; `classify()` unwraps it, reads the HTTP
  status, and maps pipeline-stage authentication failures to
  `provider_credentials`. Delivery-stage 401/403 responses still map to
  `azure_signin`, as do Storage-API-sourced 401/403s at any stage (the
  `StorageApiError` provenance check in rule 3) — those authenticate with
  the user's delegated Microsoft token, not an application credential.
