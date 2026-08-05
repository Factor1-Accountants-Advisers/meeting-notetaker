# Central People Directory for Attendee Suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The manual-recording attendee dropdown shows every colleague with an **active central voiceprint**, org-wide — fixing the empty dropdown left behind by the Slice-2 central-voiceprint cutover.

**Architecture:** Root cause (diagnosed live, 5 Aug): `AttendeePicker` filters to `enrollment === 'enrolled'`, but `GET /people` derives enrolment from the **local** `voiceprints.json` registry only; post-cutover every install's people store contains just the signed-in "me" with `enrolled=false`, so the filter yields nothing. The central contract deliberately blocks non-admin enumeration (`meeting-candidates` resolves only submitted candidates; the full list needs `StorageApi.Admin`), so the fix adds a **minimal-disclosure directory endpoint** to the Storage API — `GET /api/v1/voiceprints/directory`, any signed-in staff principal, returning only `{email, display_name}` of **active** enrolments — and merges it into the desktop backend's `GET /people` (marking `centrally_enrolled`), with the renderer treating `centrally_enrolled` as enrolled. Fail-soft everywhere: central unreachable / old server / signed-out ⇒ today's local-only behaviour, never an error.

**Tech Stack:** Two repos. `notetaker-storage-api` (FastAPI on Azure Functions; **merge to main = deploy** via `deploy.yml` — Joseph's call, work on a branch); `meeting-notetaker-2` (backend FastAPI + Electron main + React renderer).

**Sequencing / rollout:** Storage API deploys first (or whenever — the desktop degrades gracefully against an old server: 404 ⇒ local-only). Desktop ships as **v2.0.20** via the standard release ritual.

**Context you must know:**
- Storage-api route-order trap: `/voiceprints/{person_oid}` (voiceprints.py:338) is a catch-all — `/voiceprints/directory` MUST be registered before it or "directory" resolves as a person_oid and 403s. The repo already orders `/voiceprints/audit-events` above it for exactly this reason.
- `require_user` exists in `app/auth/dependencies.py` (it's what `require_admin` wraps) — the directory endpoint uses it bare.
- Storage blob layout: root `*.json` per person (filter `"/" not in name` excludes `by-email/` and `last-used/` — same filter as `list_voiceprints`, voiceprints.py:236-238).
- Desktop token plumbing: the main process injects `X-MN-Storage-Token` / `X-MN-User-Email` / `X-MN-User-Oid` only on routes matched by `isStorageRoute` (`src/main/api-request-policy.ts:31-42`); `GET /api/v1/people` is not currently matched.
- Desktop stub mode (`MN_STORAGE_API_URL` empty): `get_storage_api_client()` returns `StubStorageApiClient` (file-backed under the central voiceprint path) so dev exercises the same merge.
- Renderer mapping: `enrollmentState()` (`src/renderer/src/lib/api.ts:569-571`) currently ignores the `centrally_enrolled` field the backend already serialises.
- Conventions: backend tests via unittest discover; renderer logic via `scripts/verify-*.tsx` esbuild harnesses (`verify:ad-hoc-attendees` already covers `filterAttendeeSuggestions`); contract doc `docs/rest-contract-v1.md` is mirrored **byte-for-byte** into `meeting-notetaker-2/docs/storage-api/rest-contract-v1.md`; evidence to `docs/jira-progress.md`.
- Privacy stance for review pushback: the directory reveals only that a colleague is enrolled (name + work email) to authenticated staff — information the picker UI is *meant* to show; no oids, timestamps, counts, or voiceprint material. Admin surfaces remain admin-gated.

**File structure:**
- storage-api — Modify: `app/models.py` (+2 models), `app/routers/voiceprints.py` (+1 endpoint), `docs/rest-contract-v1.md`; Test: `tests/test_voiceprint_directory.py` (new).
- desktop — Modify: `backend/app/services/storage_api.py` (client seam +`list_directory`), `backend/app/routers/people.py` (merge), `src/main/api-request-policy.ts` (route), `src/renderer/src/lib/api.ts` (DTO + mapping); Test: `backend/tests/test_people_directory.py` (new), extend `scripts/verify-ad-hoc-attendees.tsx`; mirror contract doc; evidence ledger.

---

### Task 1 (storage-api): directory endpoint — failing tests

**Files:**
- Create: `tests/test_voiceprint_directory.py`

Read `tests/test_voiceprint_admin.py:33-96` first and reuse its EXACT harness: `make_app_client()` from `tests/conftest.py`, a test-file-local `store` fixture (dict with monkeypatched `blob.get_json`/`put_json`/`list_json`), and `auth(...)` headers built on conftest's `make_token`. Do NOT invent fixtures — there is no `client_user`/`seeded_blobs` in this repo. Cover:

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_voiceprint_directory.py — same harness as test_voiceprint_admin.py:
# make_app_client() + local blob-dict store fixture + auth() token headers.

def test_directory_requires_authentication(...):
    # No Authorization header → 401. NOTE: this test is GREEN even before
    # implementation (the /voiceprints/{person_oid} catch-all already 401s
    # unauthenticated calls) — it exists as a regression guard, not a red
    # signal.
    ...assert r.status_code == 401

def test_directory_lists_active_enrolments_for_non_admin(...):
    # store seeded with: one active (with email), one disabled, one deleted,
    # one active WITHOUT email, plus "by-email/…" and "last-used/…" noise
    # blobs. Non-admin token.
    ...assert r.status_code == 200
    # Only ACTIVE + has-email records appear; sorted by display_name:
    ...assert items == [{"email": "amy@factor1.com.au", "display_name": "Amy Active"}]

def test_directory_never_exposes_oids_or_voiceprint_material(...):
    ...for item in items: assert set(item.keys()) == {"email", "display_name"}
```

- [ ] **Step 2: Run and watch them fail — for the RIGHT reason**

Run (repo root): `python -m pytest tests/test_voiceprint_directory.py -v`
Expected: the list/shape tests FAIL with **403** — today `GET /voiceprints/directory` is swallowed by the `/voiceprints/{person_oid}` catch-all (voiceprints.py:338) with `person_oid="directory"`, and `require_self_or_admin` rejects a non-admin acting on a record that isn't theirs. NOT 404/405. The 401 test passes already (see its comment). If you see 403 you have confirmed the route-order trap this plan warns about.

- [ ] **Step 3: Commit the failing tests on a branch**

```bash
git checkout -b feature/voiceprint-directory
git add tests/test_voiceprint_directory.py
git commit -m "test: voiceprint directory endpoint (red)"
```

### Task 2 (storage-api): directory endpoint — implementation

**Files:**
- Modify: `app/models.py`, `app/routers/voiceprints.py`, `docs/rest-contract-v1.md`

- [ ] **Step 1: Models** (`app/models.py`, next to `VoiceprintAdminListResponse`)

```python
class DirectoryEntry(BaseModel):
    """Minimal-disclosure directory row: which colleagues can be picked as
    voiceprint-known attendees. Never carries oids, lifecycle timestamps,
    or voiceprint material."""
    email: str
    display_name: str


class VoiceprintDirectoryResponse(BaseModel):
    items: list[DirectoryEntry]
```

- [ ] **Step 2: Endpoint** (`app/routers/voiceprints.py` — register BEFORE the `/voiceprints/{person_oid}` catch-all; alongside `list_voiceprints` is fine since both precede it)

```python
@router.get(
    "/voiceprints/directory",
    response_model=VoiceprintDirectoryResponse,
)
def voiceprint_directory(
    principal: Principal = Depends(require_user),
) -> VoiceprintDirectoryResponse:
    """Active enrolments as a name+email directory for any signed-in staff
    caller (attendee suggestions in the desktop app). Deliberately NOT the
    admin list: no oids, no lifecycle metadata, no voiceprint values —
    enumeration beyond this minimal disclosure stays admin-only."""
    settings = get_settings()
    items = []
    for name, record in blob.list_json(settings.voiceprints_container):
        if "/" in name or not name.endswith(".json"):
            continue
        if not isinstance(record, dict) or record.get("status") != "active":
            continue
        email = _normalise_email(record.get("email"))
        display_name = record.get("display_name")
        if not email or not isinstance(display_name, str) or not display_name:
            continue
        items.append(DirectoryEntry(email=email, display_name=display_name))
    items.sort(key=lambda item: (item.display_name.casefold(), item.email))
    return VoiceprintDirectoryResponse(items=items)
```

Add `require_user` to the imports from `app.auth.dependencies` and the two new models to the `app.models` import. Do NOT audit-log directory reads (it is a low-value read of non-sensitive fields; the admin list doesn't audit reads either — confirm and match whatever `list_voiceprints` does).

- [ ] **Step 3: Contract doc** (`docs/rest-contract-v1.md`)

Add a §"`GET /api/v1/voiceprints/directory`" subsection under the voiceprints section (NOT under the admin subsection): auth = any authenticated principal; response shape; explicit note that active-only, email+display_name-only is the entire disclosure and everything else remains admin-gated. Bump the doc's version marker per its own convention (v1.0 → v1.1 with a one-line changelog if the doc has one; otherwise a dated note).

- [ ] **Step 4: Run lint + tests, then the full storage-api suite**

Run: `ruff check . && python -m pytest tests -v` (ci.yml runs ruff before pytest — lint locally or CI catches it).
Expected: new tests PASS; suite green; ruff clean.

- [ ] **Step 5: Commit**

```bash
git add app/models.py app/routers/voiceprints.py docs/rest-contract-v1.md
git commit -m "feat: non-admin voiceprint directory endpoint for attendee suggestions"
```

**Deploy note:** merging `feature/voiceprint-directory` to main deploys (deploy.yml). That is Joseph's call, per the repo's standing rule. The desktop work below does not depend on the deploy landing first.

### Task 3 (desktop backend): storage client `list_directory` — TDD

**Files:**
- Modify: `backend/app/services/storage_api.py`
- Create: `backend/tests/test_people_directory.py`

- [ ] **Step 1: Failing tests** (`backend/tests/test_people_directory.py`; copy fixture/idiom from `test_central_enrolment.py` — same store save/restore discipline as other suites)

```python
import unittest

from app.services import storage_api
from app.services.storage_api import DirectoryEntry


class StubDirectoryTests(unittest.TestCase):
    def test_stub_lists_active_enrolments_only(self):
        # Arrange stub central records via the stub client's own write path
        # (register/put), including one disabled record; assert only active
        # ones come back as DirectoryEntry(email, display_name).
        ...

    def test_rest_client_parses_directory_response(self):
        # Feed RestStorageApiClient a canned {"items":[...]} response through
        # the same transport-fake used by existing Rest client tests; assert
        # parsing + bearer header.
        ...

    def test_rest_client_maps_404_to_unavailable(self):
        # Old deployed server without the endpoint → StorageApiUnavailable
        # (callers degrade to local-only), NOT a contract error.
        ...
```

Flesh the `...` bodies out against the actual fixtures found in `test_central_enrolment.py` / existing storage_api tests — reuse their fakes, do not invent a parallel harness.

- [ ] **Step 2: Run, watch fail** (import error: `DirectoryEntry` missing).

- [ ] **Step 3: Implement in `storage_api.py`**

```python
class DirectoryEntry(BaseModel):
    email: str
    display_name: str
```

Protocol method on the client seam + both implementations. Signature matches the seam convention (`access_token: str | None`, like every other protocol method):
- `RestStorageApiClient.list_directory(access_token: str | None) -> list[DirectoryEntry]`: GET `{base}/api/v1/voiceprints/directory`, bearer token, parse `{"items": [...]}` via pydantic. **404 handling — do NOT just copy `get_enrolment`:** the shared `_request` maps 404 to `StorageApiRejected` unless called with `allow_not_found=True` (which yields `None`, storage_api.py:545-554). Call `_request(..., allow_not_found=True)` and on `None` raise `StorageApiUnavailable("directory endpoint not deployed")` — an old server must read as "temporarily can't consult", never as a rejection. **Timeout:** the shared request timeout is 30s but the main-process proxy aborts GETs at 15s (api-request-policy.ts:17) — a hung central API would take the whole `/people` response (and the LOCAL list) down with it. Pass a short per-request timeout override (5s) for this call; add a `timeout_s` parameter to `_request` if it doesn't already have one.
- `StubStorageApiClient.list_directory(access_token)`: iterate the stub's stored central records, return active-with-email ones (ignore the token, as the stub does elsewhere).

- [ ] **Step 4: Run new tests + full backend suite** — green.

- [ ] **Step 5: Commit** (`feat: storage client voiceprint directory seam`).

### Task 4 (desktop backend): merge directory into `GET /people` — TDD

**Files:**
- Modify: `backend/app/routers/people.py`
- Extend: `backend/tests/test_people_directory.py`

- [ ] **Step 1: Failing tests** (inject a fake storage client the way `test_central_enrolment.py` does)

```python
class ListPeopleDirectoryMergeTests(unittest.IsolatedAsyncioTestCase):
    async def test_directory_adds_unknown_people_as_centrally_enrolled(self):
        # directory: [amy@…] not in store.PEOPLE → response contains amy with
        # centrally_enrolled=True, enrolled=False, role "Factor1 staff".

    async def test_directory_marks_existing_person_centrally_enrolled(self):
        # "me" record exists enrolled=False → after merge centrally_enrolled=True.

    async def test_person_dropped_from_directory_loses_central_flag(self):
        # store has centrally_enrolled=True person; directory no longer lists
        # them → flag cleared (voiceprint disabled/deleted upstream), person
        # NOT removed from the list.

    async def test_directory_failure_leaves_local_list_untouched(self):
        # client raises StorageApiError → response equals pre-merge store,
        # no exception, no flag changes (fail-soft: better stale than broken).

    async def test_no_storage_identity_skips_central_call_when_required(self):
        # central required + missing token/oid → client not called at all.
```

- [ ] **Step 2: Run, watch fail** (list_people has no headers/merge yet).

- [ ] **Step 3: Implement in `people.py`**

`list_people` gains the same optional identity headers the gate endpoint uses (`UserEmail`, `UserOid`, `StorageToken`) and, after `_sync_people_with_voiceprint_registry()`:

```python
def _merge_central_directory(entries: list[DirectoryEntry]) -> None:
    """Fold the central directory into the people store. Successful fetch =
    authoritative for the centrally_enrolled flag (set for listed emails,
    cleared for unlisted); people are never REMOVED — local records and the
    signed-in 'me' must survive central hiccups and offboarding alike."""
    listed = {e.email: e for e in entries}
    changed = False
    for person in store.PEOPLE:
        should = person.employee_id in listed
        if person.centrally_enrolled != should:
            person.centrally_enrolled = should
            changed = True
    for email, entry in listed.items():
        if not any(p.employee_id == email for p in store.PEOPLE):
            store.PEOPLE.append(
                PersonEnrollment(
                    employee_id=email,
                    display_name=entry.display_name,
                    role="Factor1 staff",
                    enrolled=False,
                    model_version=None,
                    reenrollment_required=False,
                    centrally_enrolled=True,
                )
            )
            changed = True
    if changed:
        store.save_snapshot()
```

Call-site logic in `list_people`: if `central_enrolment_required()` — only attempt when both oid and token are present; otherwise (stub mode) always attempt. Wrap the fetch in `try/except StorageApiError: pass` (fail-soft). No audit entries for the merge itself (it is a read-projection, not a user mutation — deviating from the every-mutation-audits rule is justified because the authoritative audit lives centrally; note this in a comment).

The new header parameters on `list_people` MUST default to `None` — `backend/tests/test_seeded_enrollment_sync.py:35` calls `asyncio.run(list_people())` bare and is the direct collision (not `test_central_enrolment.py`): under "stub mode always attempts" it now runs the directory merge, so it needs clean stub state (`storage_api.reset_stub_for_tests()` or equivalent) to avoid order-dependence on stub records leaked by other suites — update it accordingly.

- [ ] **Step 4: Run new tests + FULL backend suite** — green (watch `test_seeded_enrollment_sync.py` especially, per the note above).

- [ ] **Step 5: Commit** (`feat: merge central voiceprint directory into people list`).

### Task 5 (desktop main + renderer): token route + enrolled mapping

**Files:**
- Modify: `src/main/api-request-policy.ts:31-42`, `src/renderer/src/lib/api.ts`
- Extend: `scripts/verify-ad-hoc-attendees.tsx`

- [ ] **Step 1: Extend the verify harness first** (read it; it already covers `filterAttendeeSuggestions`). Add assertions: a `StaffMember` produced from a DTO with `centrally_enrolled: true, enrolled: false` has `enrollment === 'enrolled'` and appears in suggestions; `reenrollment_required: true` still wins (`'reenroll_required'`, filtered out). If the harness doesn't currently import `enrollmentState`'s surrounding mapper, export a small pure helper from `api.ts` (e.g. make `enrollmentState` exported) rather than duplicating logic. Run → FAIL.

- [ ] **Step 2: Implement**

`api.ts`: add `centrally_enrolled?: boolean` to `PersonEnrollmentDto`;

```ts
function enrollmentState(dto: PersonEnrollmentDto): EnrollmentState {
  if (dto.reenrollment_required) return 'reenroll_required'
  return dto.enrolled || dto.centrally_enrolled ? 'enrolled' : 'not_enrolled'
}
```

`api-request-policy.ts` — add to `isStorageRoute`'s disjunction:

```ts
    (req.method === 'GET' && path === '/api/v1/people') ||
```

(Confirm in `src/main/api-proxy.ts` that `isStorageRoute` is what triggers storage-token + email/oid header injection — it is the only consumer; if injection also needs the route in another list, mirror it.)

- [ ] **Step 3: Run** `npm run verify:ad-hoc-attendees && npm run typecheck && npm run build` — green.

- [ ] **Step 4: Commit** (`feat: attendee suggestions treat central enrolment as known (per-machine registry superseded)`).

### Task 6: full verification, evidence, release

- [ ] **Step 1: Gates** — desktop: full backend suite + `npm run verify:ad-hoc-attendees && npm run typecheck && npm run build && git diff --check`; storage-api: `ruff check . && python -m pytest tests -v`. All green.
- [ ] **Step 2: Live smoke (Joseph):** with the storage-api branch deployed (or `func start` locally against the desktop's `MN_STORAGE_API_URL` override), open the manual-recording screen → the dropdown lists centrally enrolled colleagues (Joseph, David, Daniel, Jose at minimum). Against the OLD deployed server: dropdown behaves as today (no errors in backend log beyond one warn).
- [ ] **Step 3: Evidence** in `docs/jira-progress.md` (root-cause narrative, both-repo changes, fallback matrix, test counts). Mirror the updated contract doc byte-for-byte into `meeting-notetaker-2/docs/storage-api/rest-contract-v1.md`.
- [ ] **Step 4: Release** — bump desktop to **v2.0.20**, standard ritual (FIC subject PATCH to `refs/tags/v2.0.20` before tag push; Joseph runs the classifier-blocked commands). Storage-api: Joseph merges `feature/voiceprint-directory` (merge = deploy).
