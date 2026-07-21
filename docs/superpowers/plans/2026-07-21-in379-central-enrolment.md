# IN-379 Central Voiceprint Enrolment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-point self-service voiceprint enrolment at the central store via a stubbed Storage API client, record server-stamped consent, add a clip-upload path, and enforce the config-flagged cutover gate.

**Architecture:** Backend-proxied registration through a new `StorageApiClient` provider seam (stub activates on empty `MN_STORAGE_API_URL`, matching every provider in `backend/app/services/`). The renderer wizard keeps the validated 3-clip capture; the sign-in gate consumes a new enrolment-status endpoint whose identity comes from an `X-MN-User-Email` header injected by the Electron main process.

**Tech Stack:** FastAPI + Pydantic v2, Python `unittest` (native `.venv-win`), raw `urllib` (no Azure SDK), Electron main `api-proxy.ts`, React renderer.

**Spec:** `docs/superpowers/specs/2026-07-21-in379-enrolment-design.md` — read it first. Also read `AGENTS.md` and `CLAUDE.md`.

**Verification battery (run at every task's end unless a step says otherwise):**

```powershell
$env:PYTHONPATH='backend'
backend\.venv-win\Scripts\python.exe -m unittest backend.tests.test_central_enrolment -v
```

Full battery in Task 8.

---

### Task 1: Storage API provider seam (config, models, stub, factory)

**Files:**
- Modify: `backend/app/config.py` (add two settings)
- Modify: `backend/app/paths.py` (add `central_voiceprint_path()`)
- Create: `backend/app/services/storage_api.py`
- Test: `backend/tests/test_central_enrolment.py`

- [ ] **Step 1: Write failing tests** — new file `backend/tests/test_central_enrolment.py`:

```python
"""IN-379: central voiceprint enrolment through the Storage API seam."""

import unittest
from datetime import datetime, timezone

from app.services import storage_api
from app.services.storage_api import (
    CentralEnrolment,
    StorageApiError,
    StubStorageApiClient,
    central_enrolment_required,
    get_storage_api_client,
)


def _enrolment(person_id="joseph@factor1.com.au") -> CentralEnrolment:
    return CentralEnrolment(
        person_id=person_id,
        display_name="Joseph Guerrero",
        voiceprints=["vp1", "vp2", "vp3"],
        sample_sources=["recorded", "recorded", "uploaded"],
        model_version="precision-2",
        consent_recorded_at=datetime.now(timezone.utc),
    )


class StorageApiSeamTests(unittest.TestCase):
    def setUp(self):
        storage_api.reset_stub_for_tests()

    def test_central_enrolment_not_required_when_url_empty(self):
        self.assertFalse(central_enrolment_required())

    def test_factory_returns_stub_when_url_empty(self):
        self.assertIsInstance(get_storage_api_client(), StubStorageApiClient)

    def test_stub_register_and_get_roundtrip_upserts(self):
        client = get_storage_api_client()
        client.register_voiceprint(_enrolment(), access_token=None)
        first = client.get_enrolment("joseph@factor1.com.au", access_token=None)
        self.assertEqual(first.status, "active")
        self.assertEqual(len(first.voiceprints), 3)
        client.register_voiceprint(_enrolment(), access_token=None)  # upsert
        again = client.get_enrolment("joseph@factor1.com.au", access_token=None)
        self.assertEqual(again.created_at, first.created_at)
        self.assertGreaterEqual(again.updated_at, first.updated_at)

    def test_stub_get_unknown_person_returns_none(self):
        self.assertIsNone(get_storage_api_client().get_enrolment("x@factor1.com.au", access_token=None))

    def test_stub_failure_injection_raises_storage_api_error(self):
        client = get_storage_api_client()
        client.fail_next = True
        with self.assertRaises(StorageApiError):
            client.register_voiceprint(_enrolment(), access_token=None)
```

- [ ] **Step 2: Run to verify failure** — `ModuleNotFoundError: app.services.storage_api`. Command above; expect FAIL/ERROR.
- [ ] **Step 3: Implement.**

`config.py` — add to `Settings` next to the other provider config:

```python
    # IN-471 Storage API (Slice 2). Empty = stub mode AND central enrolment
    # not yet required (config-flagged cutover). MN_STORAGE_API_SCOPE is also
    # read by the Electron main process for MSAL token acquisition — both
    # processes must see these MN_* variables.
    storage_api_url: str = ""
    storage_api_scope: str = ""
```

`paths.py` — add beside `voiceprint_path()`:

```python
def central_voiceprint_path() -> Path:
    """Stub central store (real one is Azure Blob behind the IN-471 API)."""
    return data_root() / "central-voiceprints.json"
```

(`data_root()` is the existing resolver `voiceprint_path()` uses — mirror it exactly.)

`storage_api.py` (new, complete):

```python
"""IN-471 Storage API client seam (IN-379 first consumer).

RestStorageApiClient talks to the authenticated Azure Functions Storage API
when MN_STORAGE_API_URL is configured; endpoint paths are provisional until
the IN-471 REST contract is published. StubStorageApiClient activates when
the URL is empty — file-backed so dev exercises the full flow. Central-store
audit events are written server-side by the Function (brief §5, IN-381): the
stub deliberately writes none. Stub data never migrates to the real store.

Never log tokens or voiceprint values.
"""

import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Literal, Protocol

from pydantic import BaseModel, Field

from app.config import get_settings
from app.paths import central_voiceprint_path


class StorageApiError(RuntimeError):
    """Central registration/lookup failed; caller maps to a retryable 502."""


class CentralEnrolment(BaseModel):
    person_id: str  # email today; Entra object id once IN-471 validates tokens
    display_name: str
    voiceprints: list[str]
    sample_sources: list[Literal["recorded", "uploaded"]]
    status: Literal["active", "disabled", "deleted"] = "active"
    model_version: str | None = None
    consent_recorded_at: datetime
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class StorageApiClient(Protocol):
    def register_voiceprint(self, enrolment: CentralEnrolment, access_token: str | None) -> CentralEnrolment: ...
    def get_enrolment(self, person_id: str, access_token: str | None) -> CentralEnrolment | None: ...


def central_enrolment_required() -> bool:
    return bool(get_settings().storage_api_url)


class StubStorageApiClient:
    def __init__(self) -> None:
        self.fail_next = False

    def _load(self) -> dict:
        path = central_voiceprint_path()
        if not path.exists():
            return {}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _save(self, data: dict) -> None:
        path = central_voiceprint_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data), encoding="utf-8")
        tmp.replace(path)

    def register_voiceprint(self, enrolment: CentralEnrolment, access_token: str | None) -> CentralEnrolment:
        if self.fail_next:
            self.fail_next = False
            raise StorageApiError("injected stub failure")
        data = self._load()
        existing = data.get(enrolment.person_id)
        record = enrolment.model_copy(update={"updated_at": datetime.now(timezone.utc)})
        if existing is not None:
            record = record.model_copy(update={"created_at": CentralEnrolment.model_validate(existing).created_at})
        data[enrolment.person_id] = record.model_dump(mode="json")
        self._save(data)
        return record

    def get_enrolment(self, person_id: str, access_token: str | None) -> CentralEnrolment | None:
        raw = self._load().get(person_id)
        return CentralEnrolment.model_validate(raw) if raw is not None else None


class RestStorageApiClient:
    """Provisional REST binding for IN-471 (contract not yet published)."""

    def __init__(self, base_url: str, opener=urllib.request.urlopen) -> None:
        self._base = base_url.rstrip("/")
        self._opener = opener

    def _request(self, method: str, path: str, access_token: str | None, payload: dict | None = None):
        if not access_token:
            raise StorageApiError("central enrolment requires a signed-in user token")
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(
            f"{self._base}{path}",
            data=body,
            method=method,
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with self._opener(req, timeout=30) as res:
                text = res.read().decode("utf-8")
                return json.loads(text) if text else None
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            raise StorageApiError(f"storage API returned {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            raise StorageApiError(f"storage API unreachable: {exc}") from exc

    def register_voiceprint(self, enrolment: CentralEnrolment, access_token: str | None) -> CentralEnrolment:
        raw = self._request("PUT", f"/api/v1/voiceprints/{urllib.parse.quote(enrolment.person_id)}", access_token, enrolment.model_dump(mode="json"))
        return CentralEnrolment.model_validate(raw) if raw else enrolment

    def get_enrolment(self, person_id: str, access_token: str | None) -> CentralEnrolment | None:
        raw = self._request("GET", f"/api/v1/voiceprints/{urllib.parse.quote(person_id)}", access_token)
        return CentralEnrolment.model_validate(raw) if raw is not None else None


_STUB = StubStorageApiClient()


def reset_stub_for_tests() -> None:
    _STUB.fail_next = False
    central_voiceprint_path().unlink(missing_ok=True)


def get_storage_api_client() -> StorageApiClient:
    settings = get_settings()
    if settings.storage_api_url:
        return RestStorageApiClient(settings.storage_api_url)
    return _STUB
```

- [ ] **Step 4: Run tests — expect PASS** (same command).
- [ ] **Step 5: Commit** — `git add backend/app/config.py backend/app/paths.py backend/app/services/storage_api.py backend/tests/test_central_enrolment.py && git commit -m "feat: add Storage API client seam with file-backed stub (IN-379)"`

---

### Task 2: Consent enforcement + schema fields

**Files:**
- Modify: `backend/app/schemas.py` (`EnrollRequest`, `PersonEnrollment`)
- Modify: `backend/app/routers/people.py:110-122` (consent 422 before any provider call)
- Test: `backend/tests/test_central_enrolment.py`

- [ ] **Step 1: Write failing tests** (append; follow the store save/restore fixture pattern from `test_meeting_export.py` — snapshot `store.PEOPLE` and `AUDIT_LOG` in setUp, restore in tearDown):

```python
class ConsentEnforcementTests(unittest.IsolatedAsyncioTestCase):
    # setUp/tearDown: save & restore store.PEOPLE, store.AUDIT_LOG; append a
    # PersonEnrollment(employee_id="joseph@factor1.com.au", display_name="Joseph Guerrero",
    # role="Factor1 staff", enrolled=False) in setUp.

    async def test_enroll_without_consent_returns_422_before_any_provider_call(self):
        from fastapi import HTTPException
        from app.routers.people import enroll
        from app.schemas import EnrollRequest
        body = EnrollRequest(clips_b64=["QUJD" * 400] * 3, consent_confirmed=False)
        with self.assertRaises(HTTPException) as ctx:
            await enroll("joseph@factor1.com.au", body, actor="Joseph")
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertIn("consent", ctx.exception.detail.lower())

    def test_person_enrollment_defaults_are_backward_compatible(self):
        from app.schemas import PersonEnrollment
        person = PersonEnrollment(employee_id="x@factor1.com.au", display_name="X", enrolled=False)
        self.assertFalse(person.centrally_enrolled)
        self.assertIsNone(person.consent_recorded_at)
```

- [ ] **Step 2: Run — expect FAIL** (`consent_confirmed` unexpected / missing attribute).
- [ ] **Step 3: Implement.** `schemas.py`: `EnrollRequest` gains `consent_confirmed: bool = False` and `sample_sources: list[Literal["recorded", "uploaded"]] | None = None` (import `Literal`); `PersonEnrollment` gains `centrally_enrolled: bool = False` and `consent_recorded_at: datetime | None = None`. `people.py` `enroll`, immediately after the person lookup:

```python
    if not body.consent_confirmed:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Consent must be confirmed before voiceprint enrolment",
        )
```

- [ ] **Step 4: Run — expect PASS.** Also run the full existing suite; the pyannote 503 guard means existing enroll tests (if any construct `EnrollRequest`) need `consent_confirmed=True` — fix only test data, never the guard.
- [ ] **Step 5: Commit** — `feat: require confirmed consent before enrolment (IN-379)`

---

### Task 3: Central registration in the enroll endpoint

**Files:**
- Modify: `backend/app/routers/people.py` (token header, registration after local write)
- Test: `backend/tests/test_central_enrolment.py`

- [ ] **Step 1: Write failing tests.** Patch `people.get_settings`-independent seams: monkeypatch `storage_api.central_enrolment_required` is wrong — patch `settings` via env is heavy; instead the endpoint must call `storage_api.central_enrolment_required()` and `storage_api.get_storage_api_client()` so tests patch those two module attributes on `app.routers.people`. Tests (pyannote must be bypassed — patch `people.PyannoteAIClient` with a fake whose `extract_voiceprint_from_audio` returns `"vp"`; set `MN_PYANNOTE_API_KEY` via `unittest.mock.patch.dict` on env + `get_settings.cache_clear()` if settings are cached — check `config.py` for the cache decorator and mirror what existing tests do):

```python
    async def test_enroll_registers_centrally_with_server_stamped_consent(self):
        # central required, stub client captured; assert client.get_enrolment(email)
        # has consent_recorded_at within 60s of now(UTC), sample_sources from body,
        # person.centrally_enrolled True, person.consent_recorded_at set.

    async def test_central_registration_failure_returns_502_and_no_false_success(self):
        # client.fail_next = True → HTTPException 502; person.centrally_enrolled False.

    async def test_enroll_without_central_requirement_skips_registration(self):
        # central not required → stub store stays empty; centrally_enrolled False.
```

Write these as real tests, not comments — the three behaviours above are the assertions. House them in a new `CentralRegistrationTests(unittest.IsolatedAsyncioTestCase)` using the same store save/restore fixture as Task 2.

- [ ] **Step 2: Run — expect FAIL** (no central registration occurs).
- [ ] **Step 3: Implement** in `people.py` `enroll` after `voiceprint_repo.enroll(voiceprint)` and before the person-state update; add `storage_token: str | None = Header(None, alias="X-MN-Storage-Token")` to the signature:

```python
    consent_recorded_at = datetime.now(timezone.utc)  # server-stamped
    centrally_registered = False
    if central_enrolment_required():
        enrolment = CentralEnrolment(
            person_id=employee_id,
            display_name=person.display_name,
            voiceprints=provider_voiceprints,
            sample_sources=body.sample_sources or ["recorded"] * 3,
            model_version=settings.pyannote_model_version,
            consent_recorded_at=consent_recorded_at,
        )
        try:
            get_storage_api_client().register_voiceprint(enrolment, access_token=storage_token)
        except StorageApiError as exc:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                f"Central voiceprint registration failed — retry enrolment: {exc}",
            ) from exc
        centrally_registered = True
    person.centrally_enrolled = centrally_registered
    person.consent_recorded_at = consent_recorded_at
```

Import `CentralEnrolment`, `StorageApiError`, `central_enrolment_required`, `get_storage_api_client` from `app.services.storage_api` at module top. Extend the existing audit `after=` string with `centrally_enrolled={centrally_registered}`.

- [ ] **Step 4: Run — expect PASS** (module + full suite).
- [ ] **Step 5: Commit** — `feat: register enrolments in the central store when required (IN-379)`

---

### Task 4: Enrolment-status endpoint (the gate's source of truth)

**Files:**
- Modify: `backend/app/schemas.py` (add `EnrolmentStatus`)
- Modify: `backend/app/routers/people.py` (new GET route)
- Test: `backend/tests/test_central_enrolment.py`

- [ ] **Step 1: Failing tests** — the four-state gate matrix plus fail-closed:

```python
class EnrolmentStatusTests(unittest.IsolatedAsyncioTestCase):
    # Matrix: (central_required × locally/centrally enrolled). Assert exact
    # {enrolled_locally, centrally_enrolled, central_required} per state.
    # Plus: missing X-MN-User-Email → enrolled_locally False, centrally_enrolled
    # False, central_required still accurate (fail closed).
```

Write all five as real tests.

- [ ] **Step 2: Run — expect FAIL** (route missing).
- [ ] **Step 3: Implement.** `schemas.py`:

```python
class EnrolmentStatus(BaseModel):
    enrolled_locally: bool
    centrally_enrolled: bool
    central_required: bool
```

`people.py` (place ABOVE `/{employee_id}/enroll` so FastAPI doesn't route `me` into the path param):

```python
@router.get("/me/enrolment-status", response_model=EnrolmentStatus)
async def enrolment_status(
    user_email: str | None = Header(None, alias="X-MN-User-Email"),
    storage_token: str | None = Header(None, alias="X-MN-Storage-Token"),
) -> EnrolmentStatus:
    """Gate source of truth. Identity comes from the authenticated main
    process, never the renderer; a missing header fails closed."""
    required = central_enrolment_required()
    if not user_email:
        return EnrolmentStatus(enrolled_locally=False, centrally_enrolled=False, central_required=required)
    email = user_email.strip().lower()
    _sync_people_with_voiceprint_registry()
    person = next((p for p in store.PEOPLE if p.employee_id == email), None)
    enrolled_locally = bool(person and person.enrolled)
    centrally = False
    if required:
        try:
            centrally = get_storage_api_client().get_enrolment(email, access_token=storage_token) is not None
        except StorageApiError:
            centrally = False  # unreachable store fails closed; wizard offers retry
    return EnrolmentStatus(enrolled_locally=enrolled_locally, centrally_enrolled=centrally, central_required=required)
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat: add enrolment-status endpoint with fail-closed identity (IN-379)`

---

### Task 5: Electron main — token + email headers

**Files:**
- Modify: `src/main/api-proxy.ts:46-58`

No unit harness exists for `api-proxy.ts` (verify scripts don't cover it); correctness is typecheck + the Task 8 native smoke.

- [ ] **Step 1: Implement.** After the Graph-token injections in `registerApiProxyIpc`:

```typescript
      // IN-379: identity + delegated Storage API token for enrolment routes.
      // Email identifies "me" server-side (X-MN-User carries the display name).
      const storageRoute =
        (req.path.includes('/enroll') && req.method === 'POST') ||
        req.path.includes('/people/me/enrolment-status')
      if (storageRoute) {
        const email = getCurrentUserEmail()
        if (email) headers['X-MN-User-Email'] = email
        const scope = process.env.MN_STORAGE_API_SCOPE
        if (scope) {
          const token = await getStorageApiAccessToken(scope)
          if (token) headers['X-MN-Storage-Token'] = token
        }
      }
```

Import `getCurrentUserEmail` from `./auth-session`. For `getStorageApiAccessToken`: add a thin helper in `auth-session.ts` delegating to the existing silent-acquisition path with `[scope]` (mirror `getGraphAccessToken` — read it first and copy its shape). If `MN_STORAGE_API_SCOPE` is unset (stub mode), no token header is sent — the stub ignores it.

- [ ] **Step 2: Verify** — `npm run typecheck` passes.
- [ ] **Step 3: Commit** — `feat: attach identity and storage token headers for enrolment routes (IN-379)`

---

### Task 6: Renderer — API layer + gate

**Files:**
- Modify: `src/renderer/src/lib/api.ts:426-434` (`enrollPerson` sends `consent_confirmed` + `sample_sources`; new `fetchEnrolmentStatus`)
- Modify: `src/renderer/src/App.tsx:226,843,882` (gate consumes enrolment status)

- [ ] **Step 1: Implement `api.ts`.** `enrollPerson` gains `sampleSources: ('recorded' | 'uploaded')[]` param, body gains `consent_confirmed: true, sample_sources: sampleSources`. Add:

```typescript
export interface EnrolmentStatus {
  enrolled_locally: boolean
  centrally_enrolled: boolean
  central_required: boolean
}

export async function fetchEnrolmentStatus(): Promise<EnrolmentStatus | null> {
  return call<EnrolmentStatus>('GET', '/people/me/enrolment-status')
}
```

- [ ] **Step 2: Implement the gate.** In `App.tsx`, where `currentPerson?.enrollment !== 'enrolled'` gates (lines 226, 843, 882), fetch `EnrolmentStatus` alongside the person (same retry-with-backoff wrapper used today) and derive one boolean:

```typescript
const enrolmentSatisfied = status
  ? (status.central_required ? status.centrally_enrolled : status.enrolled_locally)
  : currentPerson?.enrollment === 'enrolled' // offline fallback: unchanged Slice 1 behaviour
```

Replace the three checks with `enrolmentSatisfied`; re-fetch status in `onEnrolled`.

- [ ] **Step 3: Verify** — `npm run typecheck && npm run build`.
- [ ] **Step 4: Commit** — `feat: gate on central enrolment when required (IN-379)`

---

### Task 7: Renderer — wizard upload path + consent copy

**Files:**
- Modify: `src/renderer/src/components/EnrollmentModal.tsx`
- Possibly modify: `src/renderer/src/lib/recorder.ts` (duration probe for uploaded files)

- [ ] **Step 1: Implement upload path.** Each `sample-N` step gets an "Upload a clip instead" control (`<input type="file" accept="audio/*">`). On selection: reuse the existing `recorder.ts` helpers — `audioDurationSeconds(blob)` for the duration probe and `analyzeVoiceSample(blob, MIN_CLIP_SECONDS, MAX_CLIP_SECONDS)` which already enforces the 5–20 s bounds; do NOT add a duplicate probe helper. Reject out-of-bounds files with the same error styling; on accept, store the clip with `source: 'uploaded'`. Track `sampleSources: ('recorded' | 'uploaded')[]` alongside `clips` and pass through `enrollPerson`.
- [ ] **Step 2: Extend consent copy** on the existing `consent` step (draft for David's review — keep sentence case per design system):

> Your voice samples are used only to create a voiceprint that identifies you in meeting transcripts. The original recordings are deleted immediately after the voiceprint is created — only the voiceprint reference is stored, centrally and securely, so any Factor1 Notetaker can recognise you. You can ask an administrator to disable or delete your voiceprint at any time. If you enrolled before central storage was introduced, this enrolment replaces that one.

The checkbox (`consented`) maps to `consent_confirmed: true` in the request; the Continue button stays disabled until checked (existing behaviour).

- [ ] **Step 3: Verify** — `npm run typecheck && npm run build`; manual dev smoke: `npm run dev`, run the wizard end-to-end with record AND upload paths against the stub (backend running with empty `MN_STORAGE_API_URL` → gate uses local; then set `MN_STORAGE_API_URL=http://stub-cutover-test` temporarily to watch the gate demand re-enrolment and fail without the store — set it back after).
- [ ] **Step 4: Commit** — `feat: add clip upload and central-storage consent to enrolment wizard (IN-379)`

---

### Task 8: Full verification + evidence

- [ ] **Step 1: Full battery**

```powershell
$env:PYTHONPATH='backend'
backend\.venv-win\Scripts\python.exe -m unittest discover -s backend/tests -t backend -v
npm run verify:graph
npm run typecheck
npm run build
git diff --check
```

All must pass; fix regressions before proceeding (never weaken existing tests).

- [ ] **Step 2: Native smoke** — packaged-dev flow per Task 7 Step 3 if not already done; confirm clips never appear on disk (`backend/var/` contains no clip audio; only `central-voiceprints.json` with provider references).
- [ ] **Step 3: Evidence** — append an IN-379 entry to `docs/jira-progress.md` under "Slice 2 implementation evidence" (mirror the IN-384 entry: what shipped, decisions, verification commands).
- [ ] **Step 4: Commit** — `docs: record IN-379 implementation evidence`. Do not push, update Jira, or touch Azure without Joseph's say-so.

---

## Explicit exclusions (repeat of spec)

No admin screen (IN-380), no audit-view (IN-381 — local `store.add_audit` continues, central events are the Function's job), no offboarding (IN-382), no meeting-time retrieval (IN-378), no Blob JSON/audio writes (IN-386), no real Azure calls, no migration of Slice 1 or stub voiceprints.
