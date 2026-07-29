# IN-391 Pipeline Error Handling & Status Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-stage failure taxonomy (category + plain user sentence) applied at all four failure points, with `Failed: [category]` UI chips, per-concern retry-failed-only semantics, structured support logging, and a behaviour doc — per the approved spec `docs/superpowers/specs/2026-07-29-in391-pipeline-error-handling-design.md`.

**Architecture:** One new pure module (`failure_reasons.py`) provides `FailureCategory`, `FailureReason`, `classify(exc)`, `FailureReason.for_category(...)`, and `log_delivery_failure(...)`. The four existing failure sites (pipeline catch-all, blob `_finish` callers, SharePoint save, email send) call into it instead of formatting ad-hoc strings. Three new nullable `*_error_code` schema fields carry categories to the renderer. No status-machine or retry-endpoint changes.

**Tech Stack:** Python 3.12 / FastAPI / Pydantic v2 (backend, `unittest`), Electron + React + TypeScript (renderer, `npm run verify:*` esbuild scripts).

**Read first:** the spec (path above); `backend/app/schemas.py:26-66,155-194`; `backend/app/services/pipeline.py:101-136,170-260,380-408`; `backend/app/services/blob_delivery.py:105-147,174-324`; `backend/app/routers/meetings.py:540-620,630-715`.

**Branch:** work on `in391-error-reporting` off `main` (repo convention, cf. `in387-sharepoint-permissions`). Do not push or merge; merging is the release decision.

**Test commands (repo conventions — Windows paths):**
- Backend, one module: `PYTHONPATH=backend backend/.venv/Scripts/python.exe -m unittest tests.test_failure_reasons -v`
- Backend, full: `PYTHONPATH=backend backend/.venv/Scripts/python.exe -m unittest discover -s backend/tests -t backend`
- Renderer: `npm run typecheck && npm run build`, plus the new `npm run verify:failure-chips` (Task 7)
- Known pre-existing flake: `test_stub_serializes_concurrent_exports_for_one_meeting` may fail regardless of this work — it is NOT caused by these changes (verified failing on clean main 29 Jul).

---

### Task 0: Branch

- [ ] **Step 1:** `git checkout -b in391-error-reporting` (from `main`, clean tree).

---

### Task 1: `failure_reasons` module (taxonomy + classifier + logging)

**Files:**
- Create: `backend/app/services/failure_reasons.py`
- Test: `backend/tests/test_failure_reasons.py`

- [ ] **Step 1: Write the failing tests**

```python
"""Tests for the IN-391 failure taxonomy and classifier."""
import logging
import unittest
from urllib.error import URLError

from app.services.failure_reasons import (
    FailureCategory,
    FailureReason,
    classify,
    log_delivery_failure,
)


class _FakeHttpError(Exception):
    def __init__(self, status_code: int) -> None:
        super().__init__(f"HTTP {status_code}")
        self.status_code = status_code


class ClassifyTests(unittest.TestCase):
    def test_transport_errors_classify_as_network(self) -> None:
        for exc in (
            URLError("dns failure"),
            ConnectionError("reset"),
            TimeoutError("timed out"),
        ):
            with self.subTest(exc=exc):
                reason = classify(exc, stage="blob")
                self.assertIs(reason.category, FailureCategory.network)

    def test_http_401_and_403_classify_as_azure_signin(self) -> None:
        for code in (401, 403):
            reason = classify(_FakeHttpError(code), stage="sharepoint")
            self.assertIs(reason.category, FailureCategory.azure_signin)

    def test_http_408_429_5xx_classify_as_service_unavailable(self) -> None:
        for code in (408, 429, 500, 503):
            reason = classify(_FakeHttpError(code), stage="blob")
            self.assertIs(reason.category, FailureCategory.service_unavailable)

    def test_unknown_exception_falls_back_to_processing_error(self) -> None:
        reason = classify(ValueError("boom"), stage="pipeline")
        self.assertIs(reason.category, FailureCategory.processing_error)

    def test_user_sentence_never_contains_exception_text(self) -> None:
        reason = classify(ValueError("SECRET sas token"), stage="pipeline")
        self.assertNotIn("SECRET", reason.user_sentence)
        self.assertIn("SECRET", reason.technical_detail)

    def test_technical_detail_truncated_to_500(self) -> None:
        reason = classify(ValueError("x" * 2000), stage="pipeline")
        self.assertLessEqual(len(reason.technical_detail), 500)

    def test_every_category_has_a_user_sentence(self) -> None:
        for category in FailureCategory:
            reason = FailureReason.for_category(category, detail="branch")
            self.assertTrue(reason.user_sentence)


class LogDeliveryFailureTests(unittest.TestCase):
    def test_log_line_is_structured_and_greppable(self) -> None:
        reason = FailureReason.for_category(
            FailureCategory.azure_signin, detail="signin_check"
        )
        with self.assertLogs("app.services.failure_reasons", level=logging.WARNING) as captured:
            log_delivery_failure("00000000-0000-0000-0000-000000000001", "blob", reason, code="signin_check")
        line = captured.output[0]
        for fragment in ("delivery_failure", "stage=blob", "category=azure_signin", "code=signin_check"):
            self.assertIn(fragment, line)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `PYTHONPATH=backend backend/.venv/Scripts/python.exe -m unittest tests.test_failure_reasons -v`
Expected: ERROR — `ModuleNotFoundError: No module named 'app.services.failure_reasons'`

- [ ] **Step 3: Implement the module**

```python
"""IN-391 failure taxonomy: one category + user sentence per failure.

The four delivery/processing failure sites map exceptions (or exception-less
condition branches) onto a small fixed vocabulary. User-facing fields only
ever carry the fixed sentences below; raw exception text goes to logs.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import Enum

logger = logging.getLogger(__name__)

_DETAIL_LIMIT = 500


class FailureCategory(str, Enum):
    network = "network"
    azure_signin = "azure_signin"
    service_unavailable = "service_unavailable"
    audio_problem = "audio_problem"
    processing_error = "processing_error"
    interrupted = "interrupted"
    stalled = "stalled"


# Product-voice sentences (spec §1; DRAFT table ratified at spec review).
USER_SENTENCES: dict[FailureCategory, str] = {
    FailureCategory.network: "Couldn't reach the network. Check your connection and retry.",
    FailureCategory.azure_signin: "Microsoft sign-in is needed. Sign in again, then retry.",
    FailureCategory.service_unavailable: "A cloud service is temporarily unavailable. Retry in a few minutes.",
    FailureCategory.audio_problem: "There was a problem with the recorded audio. Retry, and report a problem if it happens again.",
    FailureCategory.processing_error: "Processing failed. The recording is saved — retry to try again.",
    FailureCategory.interrupted: "The app restarted while this meeting was processing. Retry to continue.",
    FailureCategory.stalled: "Processing stalled before finishing. The recording is saved — retry to try again.",
}


@dataclass(frozen=True)
class FailureReason:
    category: FailureCategory
    user_sentence: str
    technical_detail: str

    @classmethod
    def for_category(cls, category: FailureCategory, *, detail: str = "") -> "FailureReason":
        """Build a reason for exception-less branches (condition checks)."""
        return cls(category, USER_SENTENCES[category], detail[:_DETAIL_LIMIT])


_NETWORK_TYPES = (ConnectionError, TimeoutError)
_SIGNIN_STATUSES = {401, 403}
_UNAVAILABLE_STATUSES = {408, 429}


def _status_code(exc: BaseException) -> int | None:
    for attribute in ("status_code", "status", "code"):
        value = getattr(exc, attribute, None)
        if isinstance(value, int):
            return value
    response = getattr(exc, "response", None)
    value = getattr(response, "status_code", None)
    return value if isinstance(value, int) else None


def _is_network_error(exc: BaseException) -> bool:
    if isinstance(exc, _NETWORK_TYPES):
        return True
    # urllib.error.URLError without importing urllib at module scope for
    # every caller; OSError covers DNS/socket failures raised by urllib.
    return exc.__class__.__name__ == "URLError" or isinstance(exc, OSError)


def classify(exc: BaseException, *, stage: str) -> FailureReason:
    """Map a caught exception to a fixed category + user sentence.

    `interrupted`/`stalled` are never produced here — those categories are
    assigned directly at the startup/watchdog marking sites, which have no
    exception object.
    """
    detail = f"{exc.__class__.__name__}: {exc}"[:_DETAIL_LIMIT]
    status = _status_code(exc)
    if status in _SIGNIN_STATUSES:
        category = FailureCategory.azure_signin
    elif status is not None and (status in _UNAVAILABLE_STATUSES or status >= 500):
        category = FailureCategory.service_unavailable
    elif _is_network_error(exc):
        category = FailureCategory.network
    else:
        category = FailureCategory.processing_error
    return FailureReason(category, USER_SENTENCES[category], detail)


def log_delivery_failure(
    meeting_id: object,
    stage: str,
    reason: FailureReason,
    *,
    code: str,
) -> None:
    """One structured, greppable line per failure (rides into main.log and
    therefore the IN-473 Report Problem bundle). `code` is the exception
    class name, or a stable branch name for exception-less branches."""
    logger.warning(
        "delivery_failure meeting=%s stage=%s category=%s code=%s detail=%s",
        meeting_id,
        stage,
        reason.category.value,
        code,
        reason.technical_detail,
    )
```

Note for the implementer: `audio_problem` is intentionally not produced by
`classify()`'s generic rules — ffmpeg/audio-validation failures are raised and
caught inside the pipeline/blob audio branches, which pass
`FailureReason.for_category(FailureCategory.audio_problem, ...)` explicitly
(Tasks 3-4). Keep it that way; sniffing "ffmpeg" in messages is brittle.

- [ ] **Step 4: Run tests, verify they pass**

Run: `PYTHONPATH=backend backend/.venv/Scripts/python.exe -m unittest tests.test_failure_reasons -v`
Expected: all PASS. (If `test_transport_errors_classify_as_network` fails on `URLError`: `URLError` subclasses `OSError`, so `_is_network_error` covers it — check rule ordering, HTTP-status checks must come first.)

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/failure_reasons.py backend/tests/test_failure_reasons.py
git commit -m "feat: add IN-391 failure taxonomy, classifier, and support log line"
```

---

### Task 2: Schema — three `*_error_code` fields

**Files:**
- Modify: `backend/app/schemas.py` (Meeting model, lines ~174-185)
- Test: `backend/tests/test_failure_reasons.py` (append)

- [ ] **Step 1: Write the failing test** (append to `test_failure_reasons.py`)

```python
from app.schemas import Meeting  # add at top with other imports
from datetime import datetime, timezone
from uuid import uuid4


class SchemaBackCompatTests(unittest.TestCase):
    def _legacy_payload(self) -> dict:
        return {
            "id": str(uuid4()),
            "title": "Legacy",
            "source": "online",
            "owner_id": "user-1",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

    def test_legacy_meeting_loads_with_none_error_codes(self) -> None:
        meeting = Meeting.model_validate(self._legacy_payload())
        self.assertIsNone(meeting.blob_error_code)
        self.assertIsNone(meeting.sharepoint_error_code)
        self.assertIsNone(meeting.delivery_error_code)
```

- [ ] **Step 2: Run, verify fails** — `AttributeError: 'Meeting' object has no attribute 'blob_error_code'`

- [ ] **Step 3: Add the fields** in `schemas.py`, each next to its sibling `_error_message`:

```python
    blob_status: BlobStatus = BlobStatus.pending
    blob_error_message: str | None = None
    blob_error_code: str | None = None  # FailureCategory value (IN-391)
    delivery_status: DeliveryStatus = DeliveryStatus.not_started
    delivery_error_message: str | None = None
    delivery_error_code: str | None = None  # FailureCategory value (IN-391)
```
and after `sharepoint_error_message`:
```python
    sharepoint_error_code: str | None = None  # FailureCategory value (IN-391)
```

- [ ] **Step 4: Run module tests, verify pass**; also run the full backend suite (expected: green apart from the known flake).

- [ ] **Step 5: Commit** — `git commit -m "feat: carry failure categories on meeting delivery fields (IN-391)"`

---

### Task 3: Pipeline hook

**Files:**
- Modify: `backend/app/services/pipeline.py` (catch-all ~:395-404; startup marking ~:196-207; watchdog ~:240-250)
- Test: `backend/tests/test_pipeline_failures.py` (create; model on existing pipeline tests — check `backend/tests/` for the current pipeline test module and follow its fixture style)

- [ ] **Step 1: Write the failing test** — inject a `ValueError("boom SECRET")` into the pipeline (monkeypatch the first processing step, per existing pipeline-test fixtures) and assert:
  - `pipeline_status == failed`, `processing_error_code == "processing_error"`;
  - `"SECRET" not in meeting.processing_error_message`;
  - a `delivery_failure` line was logged (assertLogs on `app.services.failure_reasons`).

- [ ] **Step 2: Run, verify fails** (today `processing_error_code` is `"ValueError"` and the message contains the exception text).

- [ ] **Step 3: Implement.** In the catch-all (~:395), replace the `set_pipeline_state(...)` call:

```python
    except Exception as exc:
        logger.exception("pipeline failed for %s", meeting_id)
        reason = classify(exc, stage="pipeline")
        log_delivery_failure(meeting_id, "pipeline", reason, code=exc.__class__.__name__)
        set_pipeline_state(
            meeting_id,
            PipelineStatus.failed,
            PipelineStage.failed,
            reason.user_sentence,
            error_code=reason.category.value,
            error_message=reason.user_sentence,
        )
```

Startup marking (~:203): `error_code="Interrupted"` → `error_code=FailureCategory.interrupted.value`, message → `USER_SENTENCES[FailureCategory.interrupted]`, plus `log_delivery_failure(meeting_id, "pipeline", FailureReason.for_category(FailureCategory.interrupted, detail="startup_reconcile"), code="startup_reconcile")`. Watchdog (~:247): same shape with `stalled` / `code="watchdog"` (keep the existing "No pipeline progress for over Ns" text as the `detail`). Audio-specific failures raised by the merge/probe steps: where the pipeline catches them distinctly (if it does not, leave to the generic catch-all — do NOT invent new catch sites), use `FailureReason.for_category(FailureCategory.audio_problem, detail=...)`.

- [ ] **Step 4: Run** the new test module + full backend suite. Expected: green (known flake excepted). Grep check: `grep -n "Interrupted\|Stalled" backend/app/services/pipeline.py` returns no remaining PascalCase codes.

- [ ] **Step 5: Commit** — `git commit -m "feat: classify pipeline failures with IN-391 taxonomy"`

---

### Task 4: Blob hooks

**Files:**
- Modify: `backend/app/services/blob_delivery.py` (`_finish` ~:105; failure sites ~:202-322; message constants near top of file)
- Test: `backend/tests/test_blob_delivery.py` (or the existing blob test module — locate with `grep -rln "deliver_meeting_to_blob" backend/tests/`; extend it, don't create a parallel one if it exists)

- [ ] **Step 1: Write failing tests** asserting, for (a) a raised `ConnectionError` in the export upload and (b) the missing-token sign-in branch:
  - `blob_status == failed`;
  - `blob_error_code == "network"` / `"azure_signin"` respectively;
  - `blob_error_message` equals the fixed sentence (no exception text);
  - a `delivery_failure stage=blob` log line.

- [ ] **Step 2: Run, verify fails** (no `blob_error_code` set today).

- [ ] **Step 3: Implement.**
  1. `_finish` gains a keyword `error_code: str | None = None` and writes `meeting.blob_error_code = error_code` next to `blob_error_message` (~:129).
  2. Exception branches bind the exception and classify — e.g. the export branch (~:295):
     ```python
     except Exception as exc:
         reason = classify(exc, stage="blob")
         log_delivery_failure(meeting_id, "blob", reason, code=exc.__class__.__name__)
         return _finish(
             ...,
             status=BlobStatus.failed,
             error_message=reason.user_sentence,
             error_code=reason.category.value,
             actor=actor,
         )
     ```
     Same for the audio branch (~:271, category via `classify`, but if the caught error is the audio-snapshot copy failure, prefer `for_category(audio_problem)`) and the outer catch-all (~:313).
  3. Condition branches (no exception): sign-in (~:216) → `for_category(azure_signin, detail="signin_check")`, `code="signin_check"`; prerequisite (~:202) → `for_category(processing_error, detail="prerequisite_check")`, `code="prerequisite_check"`. Keep the existing `SIGN_IN_FAILURE`/`PREREQUISITE_FAILURE`/`AUDIO_FAILURE`/`EXPORT_FAILURE` constants only if their text is reused as the category sentences; otherwise delete them and their imports.
  4. Success `_finish` call passes `error_code=None`.

- [ ] **Step 4: Run** blob tests + full suite. Expected: green (known flake excepted).

- [ ] **Step 5: Commit** — `git commit -m "feat: classify blob delivery failures with IN-391 taxonomy"`

---

### Task 5: SharePoint + email hooks

**Files:**
- Modify: `backend/app/routers/meetings.py` (email ~:544-616; sharepoint ~:655-712); `backend/app/services/pipeline.py` `set_delivery_state` (~:139, add `error_code` keyword) — check where `sharepoint_*` updates are written (inline `model_copy` in the router) and extend those dicts.
- Test: extend `backend/tests/test_delivery_reliability.py` (existing module covering these paths)

- [ ] **Step 1: Write failing tests:**
  - SharePoint provider raising `_FakeHttpError(503)` → `sharepoint_status == failed`, `sharepoint_error_code == "service_unavailable"`, message is the fixed sentence, `delivery_failure stage=sharepoint` logged.
  - SharePoint missing-token branch → `sharepoint_error_code == "azure_signin"` and the existing sign-in message retained (spec: that branch keeps its current wording).
  - Email provider raising a plain `Exception` → `delivery_status == failed`, `delivery_error_code == "processing_error"` (or per classification), fixed sentence, log line.
  - Email missing-token branch → `delivery_error_code == "azure_signin"`, existing wording retained.
  - `EmailDeliveryUnconfirmed` → status `unconfirmed`, `delivery_error_code is None`, wording unchanged (regression pin for IN-478).

- [ ] **Step 2: Run, verify fails.**

- [ ] **Step 3: Implement.** `set_delivery_state` gains `error_code: str | None = None` writing `delivery_error_code`; `unconfirmed` transition explicitly passes `error_code=None`. Email generic handler (~:609): classify, log, store sentence + category; keep the raised `HTTPException` detail as-is (it feeds the renderer toast today — the stored fields are what the chips read). SharePoint generic handler (~:696): same, replacing `f"SharePoint save failed: {exc}"`. Both sign-in branches: `for_category(azure_signin, ...)` but keep their existing user-visible strings (assert in tests). Set `sharepoint_error_code`/`delivery_error_code = None` on the success paths that already null the messages.

- [ ] **Step 4: Run** `tests.test_delivery_reliability` + full suite. Expected: green (known flake excepted).

- [ ] **Step 5: Commit** — `git commit -m "feat: classify sharepoint/email failures with IN-391 taxonomy"`

---

### Task 6: API surface to renderer

**Files:**
- Modify: `src/renderer/src/lib/api.ts` (meeting mapping — find the existing `pipelineStatus`/`sharepointStatus` snake→camel mapping and add the three codes)
- Test: covered by Task 7's verify script + `npm run typecheck`

- [ ] **Step 1:** Add `blobErrorCode`, `sharepointErrorCode`, `deliveryErrorCode` (and `processingErrorCode` if not already mapped) as `string | null` to the renderer Meeting type and its mapper.
- [ ] **Step 2:** `npm run typecheck` — expected PASS.
- [ ] **Step 3: Commit** — `git commit -m "feat: expose failure categories to renderer (IN-391)"`

---

### Task 7: Renderer chips and per-concern failure rows

**Files:**
- Create: `src/renderer/src/lib/failureDisplay.ts` (pure logic: category → label, worst-first chip selection, unconfirmed handling)
- Modify: `src/renderer/src/screens/MeetingsScreen.tsx` (~:134 — replace the bare `Failed` pill), `src/renderer/src/screens/MeetingReviewScreen.tsx` (~:331 `FailedCard` area — per-concern rows reusing the existing retry handlers)
- Create: `scripts/verify-failure-chips.tsx` + `package.json` script `verify:failure-chips` (copy the esbuild pattern of `verify:recording-controls`, `package.json:18`)

- [ ] **Step 1: Write `failureDisplay.ts`** (pure, testable):

```typescript
export type FailureCategory =
  | 'network' | 'azure_signin' | 'service_unavailable' | 'audio_problem'
  | 'processing_error' | 'interrupted' | 'stalled'

export const CATEGORY_LABELS: Record<FailureCategory, string> = {
  network: 'Network',
  azure_signin: 'Microsoft sign-in',
  service_unavailable: 'Service unavailable',
  audio_problem: 'Audio problem',
  processing_error: 'Processing error',
  interrupted: 'Interrupted',
  stalled: 'Stalled',
}

export interface FailureChipInput {
  pipelineStatus: string
  processingErrorCode: string | null
  blobStatus: string
  blobErrorCode: string | null
  sharepointStatus: string
  sharepointErrorCode: string | null
  deliveryStatus: string
  deliveryErrorCode: string | null
}

// Worst-first (spec §3): processing → blob → sharepoint → email.
// Returns the single card chip label, or null when nothing has failed.
// `unconfirmed` is NOT a failure and never yields a Failed chip.
export function failedChipLabel(m: FailureChipInput): string | null {
  const ordered: Array<[string, string | null]> = [
    [m.pipelineStatus, m.processingErrorCode],
    [m.blobStatus, m.blobErrorCode],
    [m.sharepointStatus, m.sharepointErrorCode],
    [m.deliveryStatus, m.deliveryErrorCode],
  ]
  for (const [status, code] of ordered) {
    if (status === 'failed') {
      const label = code && code in CATEGORY_LABELS ? CATEGORY_LABELS[code as FailureCategory] : 'Processing error'
      return `Failed: ${label}`
    }
  }
  return null
}

export function showUnconfirmedChip(m: FailureChipInput): boolean {
  return m.deliveryStatus === 'unconfirmed'
}
```

- [ ] **Step 2: Write `scripts/verify-failure-chips.tsx`** asserting (node-side, no DOM — same style as the other verify scripts): single failure → correct label; multi-failure → processing wins; legacy `null` code → `Failed: Processing error` fallback; `unconfirmed` → no Failed chip + unconfirmed chip true; unconfirmed + blob failed → both chips. Add the `verify:failure-chips` script entry to `package.json`. Run `npm run verify:failure-chips` — expected: failures until Step 1's module exists, then PASS.

- [ ] **Step 3: Wire the screens.**
  - `MeetingsScreen.tsx:134`: replace `{meeting.pipelineStatus === 'failed' && <Pill tone="danger">Failed</Pill>}` with the `failedChipLabel(...)` chip plus, independently, `showUnconfirmedChip(...) && <Pill tone="warning">Email unconfirmed</Pill>`.
  - `MeetingReviewScreen.tsx`: extend the `FailedCard` area into one row per failed concern — category label + the meeting's stored `*_error_message` sentence + that concern's existing retry action (processing retry exists at ~:229; blob/sharepoint/email retries are the existing re-POST actions on this screen — reuse those handlers, do not add endpoints). Unconfirmed email keeps its existing notice (`lib/deliveryNotice.ts`) untouched.
- [ ] **Step 4:** `npm run typecheck && npm run build && npm run verify:failure-chips` — all PASS. Also `npm run verify:email-notice` (guards the unconfirmed notice untouched).
- [ ] **Step 5: Commit** — `git commit -m "feat: Failed:[category] chips and per-concern failure rows (IN-391)"`

---

### Task 8: Behaviour doc + evidence

**Files:**
- Create: `docs/pipeline-error-handling.md`
- Modify: `docs/jira-progress.md` (new IN-391 ledger entry)

- [ ] **Step 1:** Write `docs/pipeline-error-handling.md` from spec §§1-5: the four state machines (enumerate the enum values), taxonomy + sentence table, classification rules, manual-retry rules, the partial-success matrix, the audio-preservation guarantee ("local audio is never deleted because of a failure; only post-`ready` retention removes it"), and the `delivery_failure` log-line format with the branch-name convention.
- [ ] **Step 2:** Add the `- [ ] IN-391` ledger entry in `docs/jira-progress.md` following the house style: what shipped, file-level evidence, verification commands + counts, explicit "no Jira transition/merge/push performed".
- [ ] **Step 3: Commit** — `git commit -m "docs: pipeline error handling behaviour reference (IN-391)"`

---

### Task 9: Full verification sweep

- [ ] **Step 1:** `PYTHONPATH=backend backend/.venv/Scripts/python.exe -m unittest discover -s backend/tests -t backend` — expected: all pass except (possibly) the documented `test_stub_serializes_concurrent_exports_for_one_meeting` flake. Any OTHER failure blocks completion.
- [ ] **Step 2:** `npm run typecheck && npm run build && npm run verify:failure-chips && npm run verify:email-notice && npm run verify:storage-cutover` — all PASS.
- [ ] **Step 3:** `git diff --check` (no whitespace errors); `git log --oneline main..HEAD` shows the task commits.
- [ ] **Step 4:** Update the `docs/jira-progress.md` entry with final test counts; commit any amendments.
- [ ] **Step 5:** STOP. Do not merge to `main`, do not push, do not transition Jira — integration is the user's call (and Jira writes are blocked on re-authentication; see memory `jira-mcp-authenticated-as-david`).
