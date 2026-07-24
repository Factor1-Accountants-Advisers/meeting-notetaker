# IN-378 Meeting-Time Voiceprint Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an ordinary signed-in Notetaker retrieve only the active central voiceprints requested for one meeting and use them once in the local speaker-identification pipeline.

**Architecture:** Extend the Storage API with a scoped batch-read endpoint backed by a hashed email-to-OID index, while keeping the existing self-or-admin record endpoints unchanged. Electron main passes a fresh delegated Storage API token to the local FastAPI audio/retry request; the pipeline resolves central candidates once, keeps them in memory, and uses relevant local records only when the central request fails.

**Tech Stack:** Python 3.11, FastAPI, Pydantic v2, Azure Blob sync SDK, pytest, Electron, TypeScript, MSAL, unittest.

---

## Working locations and authority

- Approved design:
  `C:\Projects\meeting-notetaker-2\docs\superpowers\specs\2026-07-24-in378-meeting-time-voiceprint-retrieval-design.md`
- Storage API repository:
  `C:\Projects\notetaker-storage-api`
- Desktop repository:
  `C:\Projects\meeting-notetaker-2`
- Contract source:
  `C:\Projects\notetaker-storage-api\docs\rest-contract-v1.md`
- Contract mirror:
  `C:\Projects\meeting-notetaker-2\docs\storage-api\rest-contract-v1.md`

The Storage API branch must be `codex/in-378-meeting-voiceprints`. The desktop
branch already exists with the same name. Do not push either branch or mutate
production voiceprint data without a separate explicit instruction.

## File map

### Storage API

| File | Responsibility |
| --- | --- |
| `app/auth/tokens.py` | Expose exact delegated scopes on `Principal`. |
| `app/auth/dependencies.py` | Permit batch reads to `access_as_user` or admins. |
| `app/models.py` | Add optional email plus batch request/response models. |
| `app/routers/voiceprints.py` | Maintain the hashed index and resolve exact meeting candidates. |
| `tests/conftest.py` | Allow test tokens to carry `scp`. |
| `tests/test_tokens.py` | Prove scope parsing is exact. |
| `tests/test_auth_dependencies.py` | Prove regular reader/admin/forbidden behavior. |
| `tests/test_voiceprints.py` | Prove indexing, resolution, privacy, validation, and failures. |
| `docs/rest-contract-v1.md` | Publish the additive operation. |
| `docs/jira-progress.md` | Record evidence. |

### Desktop

| File | Responsibility |
| --- | --- |
| `src/main/api-request-policy.ts` | Classify audio upload and retry as Storage API routes. |
| `scripts/verify-storage-cutover.ts` | Lock token-injection route boundaries. |
| `backend/app/services/storage_api.py` | Implement the batch wire contract. |
| `backend/app/services/meeting_voiceprints.py` | Assemble candidates, resolve once, and apply outage fallback. |
| `backend/app/services/speaker_matching.py` | Consume an optional per-run candidate list. |
| `backend/app/services/pipeline.py` | Carry ephemeral auth and resolve before matching. |
| `backend/app/routers/meetings.py` | Receive private Storage headers on upload/retry. |
| `backend/tests/test_meeting_voiceprints.py` | Test central authority, fallback, and ordering. |
| `backend/tests/test_central_enrolment.py` | Test the new Storage API client method. |
| `backend/tests/test_meeting_processing_auth.py` | Prove upload/retry hand fresh private auth to the task. |
| `backend/tests/test_pipeline_voiceprints.py` | Prove one resolution per attempt and retryable failure. |
| `backend/tests/test_meeting_export.py` | Keep existing direct pipeline/kick calls compatible. |
| `docs/storage-api/rest-contract-v1.md` | Mirror the published source contract exactly. |
| `docs/jira-progress.md` | Record evidence. |

## Task 1: Parse delegated scopes and authorize meeting reads

**Files:**
- Modify: `C:\Projects\notetaker-storage-api\tests\conftest.py`
- Modify: `C:\Projects\notetaker-storage-api\tests\test_tokens.py`
- Modify: `C:\Projects\notetaker-storage-api\tests\test_auth_dependencies.py`
- Modify: `C:\Projects\notetaker-storage-api\app\auth\tokens.py`
- Modify: `C:\Projects\notetaker-storage-api\app\auth\dependencies.py`

- [ ] **Step 1: Create and switch to the Storage API feature branch**

```powershell
git -C C:\Projects\notetaker-storage-api switch -c codex/in-378-meeting-voiceprints
```

Expected: the clean repository switches from `main` to the new feature branch.

- [ ] **Step 2: Extend the test token factory and add failing scope tests**

Change `_make` in `tests/conftest.py` to accept an exact `scopes` string:

```python
def _make(
    oid="user-oid-1",
    roles=None,
    aud="test-audience",
    iss="https://login.microsoftonline.com/test-tenant/v2.0",
    exp_delta=3600,
    name="Test User",
    email="test@factor1.com.au",
    kid=TEST_KID,
    scopes="",
):
    now = int(time.time())
    claims = {
        "oid": oid,
        "aud": aud,
        "iss": iss,
        "iat": now,
        "exp": now + exp_delta,
        "name": name,
        "preferred_username": email,
        "roles": roles or [],
    }
    if scopes:
        claims["scp"] = scopes
    return pyjwt.encode(
        claims, private_key, algorithm="RS256", headers={"kid": kid}
    )
```

Append to `tests/test_tokens.py`:

```python
def test_delegated_scopes_are_split_and_deduplicated(make_token):
    principal = validate_token(
        make_token(scopes="User.Read access_as_user User.Read access_as_user")
    )
    assert principal.scopes == ("User.Read", "access_as_user")


def test_missing_scope_claim_defaults_to_empty_tuple(make_token):
    assert validate_token(make_token()).scopes == ()
```

Add `require_meeting_voiceprint_reader` to the import in
`tests/test_auth_dependencies.py`, then add:

```python
@_probe.get("/meeting-reader")
async def probe_meeting_reader(
    principal: Principal = Depends(require_meeting_voiceprint_reader),
) -> dict[str, str]:
    return {"status": "ok"}


def test_meeting_reader_allows_access_as_user(client, make_token):
    token = make_token(scopes="access_as_user")
    response = client.get(
        "/api/v1/probe/meeting-reader",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200


def test_meeting_reader_allows_admin_without_delegated_scope(client, make_token):
    token = make_token(roles=["StorageApi.Admin"])
    response = client.get(
        "/api/v1/probe/meeting-reader",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200


@pytest.mark.parametrize(
    "scopes",
    ["", "Access_As_User", "access_as_user.extra", "other access_as_userx"],
)
def test_meeting_reader_rejects_missing_or_near_miss_scope(client, make_token, scopes):
    token = make_token(scopes=scopes)
    response = client.get(
        "/api/v1/probe/meeting-reader",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 403
    _assert_error_shape(response.json(), "forbidden")
```

- [ ] **Step 3: Run the focused tests and verify RED**

```powershell
C:\Projects\notetaker-storage-api\.venv\Scripts\python.exe -m pytest tests/test_tokens.py tests/test_auth_dependencies.py -v
```

Expected: failures because `Principal.scopes` and
`require_meeting_voiceprint_reader` do not exist.

- [ ] **Step 4: Implement exact scope parsing and the reader dependency**

In `app/auth/tokens.py`, extend `Principal`:

```python
@dataclass(frozen=True)
class Principal:
    oid: str
    name: str = ""
    email: str = ""
    roles: tuple[str, ...] = ()
    scopes: tuple[str, ...] = ()

    @property
    def is_admin(self) -> bool:
        return ADMIN_ROLE in self.roles
```

Add:

```python
def _delegated_scopes(claims: dict) -> tuple[str, ...]:
    raw = claims.get("scp", "")
    if not isinstance(raw, str):
        return ()
    return tuple(dict.fromkeys(item for item in raw.split() if item))
```

Return the parsed value from `validate_token`:

```python
return Principal(
    oid=oid,
    name=claims.get("name", ""),
    email=claims.get("preferred_username", ""),
    roles=tuple(claims.get("roles", [])),
    scopes=_delegated_scopes(claims),
)
```

In `app/auth/dependencies.py`, add:

```python
def require_meeting_voiceprint_reader(
    principal: Principal = Depends(require_user),
) -> Principal:
    if not principal.is_admin and "access_as_user" not in principal.scopes:
        raise ApiError(
            403,
            "forbidden",
            "delegated access_as_user scope or StorageApi.Admin role required",
        )
    return principal
```

- [ ] **Step 5: Run the focused tests and verify GREEN**

```powershell
C:\Projects\notetaker-storage-api\.venv\Scripts\python.exe -m pytest tests/test_tokens.py tests/test_auth_dependencies.py -v
```

Expected: all focused tests pass.

- [ ] **Step 6: Commit the auth boundary**

```powershell
git -C C:\Projects\notetaker-storage-api add app/auth/tokens.py app/auth/dependencies.py tests/conftest.py tests/test_tokens.py tests/test_auth_dependencies.py
git -C C:\Projects\notetaker-storage-api commit -m "feat: authorize delegated meeting voiceprint reads"
```

## Task 2: Stamp email and maintain the private hashed index

**Files:**
- Modify: `C:\Projects\notetaker-storage-api\app\models.py`
- Modify: `C:\Projects\notetaker-storage-api\app\routers\voiceprints.py`
- Modify: `C:\Projects\notetaker-storage-api\tests\test_voiceprints.py`

- [ ] **Step 1: Add failing email/index tests**

Add `hashlib` to `tests/test_voiceprints.py`, extend the `auth` fixture to accept
`email` and `scopes`, and add:

```python
def email_index_name(email: str) -> str:
    digest = hashlib.sha256(email.strip().casefold().encode("utf-8")).hexdigest()
    return f"by-email/{digest}.json"


class TestVoiceprintEmailIndex:
    def test_self_put_stamps_token_email_and_writes_hashed_index(
        self, store, auth, frozen_now
    ):
        client = make_app_client()
        response = client.put(
            "/api/v1/voiceprints/user-oid-1",
            json=enrolment_body(email="attacker@example.com"),
            headers=auth(email=" Test.User@Factor1.com.au "),
        )
        assert response.status_code == 200
        assert response.json()["email"] == "test.user@factor1.com.au"
        index = email_index_name("test.user@factor1.com.au")
        assert store.data[(VOICEPRINTS, index)] == {"person_id": "user-oid-1"}
        assert "test.user@factor1.com.au" not in index
        assert "email" not in store.events[0]["details"]

    def test_admin_preserves_existing_target_email_when_body_omits_it(
        self, store, auth, frozen_now
    ):
        seed_prior_record(store)
        store.data[(VOICEPRINTS, "user-oid-1.json")]["email"] = "target@factor1.com.au"
        client = make_app_client()
        response = client.put(
            "/api/v1/voiceprints/user-oid-1",
            json=enrolment_body(),
            headers=auth(
                oid="admin-oid",
                roles=["StorageApi.Admin"],
                email="admin@factor1.com.au",
            ),
        )
        assert response.status_code == 200
        assert response.json()["email"] == "target@factor1.com.au"
        assert store.data[
            (VOICEPRINTS, email_index_name("target@factor1.com.au"))
        ] == {"person_id": "user-oid-1"}
```

Update the hostile-name test so it filters out `by-email/` entries before
asserting the OID blob name.

- [ ] **Step 2: Run the new tests and verify RED**

```powershell
C:\Projects\notetaker-storage-api\.venv\Scripts\python.exe -m pytest tests/test_voiceprints.py -v -k "EmailIndex or hostile"
```

Expected: failures because email is ignored and no index is written.

- [ ] **Step 3: Implement email normalization and index writes**

Add to `CentralEnrolment` in `app/models.py`:

```python
email: str | None = None
```

Add to `app/routers/voiceprints.py`:

```python
import hashlib


def _normalise_email(value: str | None) -> str | None:
    cleaned = (value or "").strip().casefold()
    return cleaned or None


def _email_index_name(email: str) -> str:
    digest = hashlib.sha256(email.encode("utf-8")).hexdigest()
    return f"by-email/{digest}.json"
```

In `put_voiceprint`, before `blob.put_json`, resolve the authoritative email:

```python
if principal.oid == person_oid:
    email = _normalise_email(principal.email)
else:
    email = _normalise_email(body.email) or _normalise_email(
        (existing or {}).get("email")
    )
record["email"] = email
```

After writing the record and before auditing:

```python
if email:
    blob.put_json(
        settings.voiceprints_container,
        _email_index_name(email),
        {"person_id": person_oid},
    )
```

- [ ] **Step 4: Run all voiceprint tests and verify GREEN**

```powershell
C:\Projects\notetaker-storage-api\.venv\Scripts\python.exe -m pytest tests/test_voiceprints.py -v
```

Expected: all tests pass, including existing GET/PUT authorization tests.

- [ ] **Step 5: Commit the index**

```powershell
git -C C:\Projects\notetaker-storage-api add app/models.py app/routers/voiceprints.py tests/test_voiceprints.py
git -C C:\Projects\notetaker-storage-api commit -m "feat: index central voiceprints by normalized email"
```

## Task 3: Add the bounded meeting-candidate batch endpoint

**Files:**
- Modify: `C:\Projects\notetaker-storage-api\app\models.py`
- Modify: `C:\Projects\notetaker-storage-api\app\routers\voiceprints.py`
- Modify: `C:\Projects\notetaker-storage-api\tests\test_voiceprints.py`

- [ ] **Step 1: Add failing batch model and endpoint tests**

Add imports for the new models and append tests that use this helper:

```python
def candidate(email: str, source: str = "invitee") -> dict:
    return {"email": email, "source": source}
```

Add:

```python
class TestMeetingCandidates:
    def test_regular_delegated_user_gets_only_requested_active_records(
        self, store, auth
    ):
        active = enrolment_body(
            person_id="david-oid",
            email="david@factor1.com.au",
            display_name="David",
        )
        store.data[(VOICEPRINTS, "david-oid.json")] = active
        store.data[
            (VOICEPRINTS, email_index_name("david@factor1.com.au"))
        ] = {"person_id": "david-oid"}
        client = make_app_client()
        response = client.post(
            "/api/v1/voiceprints/meeting-candidates",
            json={
                "meeting_id": "b6accba2-c5e1-447f-a999-63f6330658fb",
                "candidates": [
                    candidate(" DAVID@factor1.com.au "),
                    candidate("missing@factor1.com.au", "controlled_expansion"),
                ],
            },
            headers=auth(scopes="access_as_user"),
        )
        assert response.status_code == 200
        body = response.json()
        assert [record["person_id"] for record in body["records"]] == ["david-oid"]
        assert body["missing"] == [
            candidate("missing@factor1.com.au", "controlled_expansion")
        ]
        assert store.events == []

    def test_duplicate_email_keeps_first_source(self, store, auth):
        client = make_app_client()
        response = client.post(
            "/api/v1/voiceprints/meeting-candidates",
            json={
                "meeting_id": "b6accba2-c5e1-447f-a999-63f6330658fb",
                "candidates": [
                    candidate("same@factor1.com.au", "invitee"),
                    candidate(" SAME@factor1.com.au ", "controlled_expansion"),
                ],
            },
            headers=auth(scopes="access_as_user"),
        )
        assert response.status_code == 200
        assert response.json()["missing"] == [candidate("same@factor1.com.au")]

    @pytest.mark.parametrize("status_value", ["disabled", "deleted"])
    def test_inactive_and_stale_records_are_reported_only_as_missing(
        self, store, auth, status_value
    ):
        record = enrolment_body(
            person_id="target-oid",
            email="target@factor1.com.au",
            status=status_value,
        )
        store.data[(VOICEPRINTS, "target-oid.json")] = record
        store.data[
            (VOICEPRINTS, email_index_name("target@factor1.com.au"))
        ] = {"person_id": "target-oid"}
        client = make_app_client()
        response = client.post(
            "/api/v1/voiceprints/meeting-candidates",
            json={
                "meeting_id": "b6accba2-c5e1-447f-a999-63f6330658fb",
                "candidates": [candidate("target@factor1.com.au")],
            },
            headers=auth(scopes="access_as_user"),
        )
        assert response.status_code == 200
        assert response.json()["records"] == []
        assert response.json()["missing"] == [candidate("target@factor1.com.au")]

    def test_batch_requires_exact_scope_or_admin(self, store, auth):
        client = make_app_client()
        payload = {
            "meeting_id": "b6accba2-c5e1-447f-a999-63f6330658fb",
            "candidates": [candidate("target@factor1.com.au")],
        }
        assert client.post(
            "/api/v1/voiceprints/meeting-candidates",
            json=payload,
            headers=auth(),
        ).status_code == 403
        assert client.post(
            "/api/v1/voiceprints/meeting-candidates",
            json=payload,
            headers=auth(roles=["StorageApi.Admin"]),
        ).status_code == 200

    def test_empty_or_more_than_fifty_candidates_returns_422(self, store, auth):
        client = make_app_client()
        for values in [[], [candidate(f"p{i}@factor1.com.au") for i in range(51)]]:
            response = client.post(
                "/api/v1/voiceprints/meeting-candidates",
                json={
                    "meeting_id": "b6accba2-c5e1-447f-a999-63f6330658fb",
                    "candidates": values,
                },
                headers=auth(scopes="access_as_user"),
            )
            assert response.status_code == 422
            assert response.json()["error"]["code"] == "validation_error"
```

- [ ] **Step 2: Run the endpoint tests and verify RED**

```powershell
C:\Projects\notetaker-storage-api\.venv\Scripts\python.exe -m pytest tests/test_voiceprints.py -v -k MeetingCandidates
```

Expected: 405 or validation failures because the POST route/models do not exist.

- [ ] **Step 3: Implement request/response models**

Add to `app/models.py`:

```python
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

CandidateSource = Literal[
    "invitee", "organizer", "recorder", "controlled_expansion"
]


class MeetingVoiceprintCandidate(BaseModel):
    email: str
    source: CandidateSource

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        cleaned = value.strip().casefold()
        if not cleaned or "@" not in cleaned or cleaned.startswith("@"):
            raise ValueError("a valid email is required")
        return cleaned


class MeetingVoiceprintRequest(BaseModel):
    meeting_id: UUID
    candidates: Annotated[
        list[MeetingVoiceprintCandidate], Field(min_length=1, max_length=50)
    ]


class MeetingVoiceprintResponse(BaseModel):
    meeting_id: UUID
    records: list[CentralEnrolment]
    missing: list[MeetingVoiceprintCandidate]
```

- [ ] **Step 4: Implement exact indexed resolution**

Import the models and `require_meeting_voiceprint_reader` in
`app/routers/voiceprints.py`, then add:

```python
@router.post(
    "/voiceprints/meeting-candidates",
    response_model=MeetingVoiceprintResponse,
)
def get_meeting_candidates(
    body: MeetingVoiceprintRequest,
    principal: Principal = Depends(require_meeting_voiceprint_reader),
) -> MeetingVoiceprintResponse:
    settings = get_settings()
    seen: set[str] = set()
    ordered = []
    for item in body.candidates:
        if item.email not in seen:
            seen.add(item.email)
            ordered.append(item)

    records: list[CentralEnrolment] = []
    missing = []
    for item in ordered:
        index = blob.get_json(
            settings.voiceprints_container,
            _email_index_name(item.email),
        )
        person_id = (index or {}).get("person_id")
        record = (
            blob.get_json(
                settings.voiceprints_container,
                _blob_name(person_id),
            )
            if isinstance(person_id, str) and person_id
            else None
        )
        valid = (
            isinstance(record, dict)
            and _normalise_email(record.get("email")) == item.email
            and record.get("status") == "active"
        )
        if not valid:
            missing.append(item)
            continue
        try:
            records.append(CentralEnrolment.model_validate(record))
        except ValueError:
            missing.append(item)

    return MeetingVoiceprintResponse(
        meeting_id=body.meeting_id,
        records=records,
        missing=missing,
    )
```

- [ ] **Step 5: Run the full Storage API suite**

```powershell
C:\Projects\notetaker-storage-api\.venv\Scripts\python.exe -m ruff check app tests
C:\Projects\notetaker-storage-api\.venv\Scripts\python.exe -m pytest -v
```

Expected: ruff passes and all tests pass.

- [ ] **Step 6: Commit the endpoint**

```powershell
git -C C:\Projects\notetaker-storage-api add app/models.py app/routers/voiceprints.py tests/test_voiceprints.py
git -C C:\Projects\notetaker-storage-api commit -m "feat: resolve active voiceprints for a meeting"
```

## Task 4: Publish and mirror the Storage API contract

**Files:**
- Modify: `C:\Projects\notetaker-storage-api\docs\rest-contract-v1.md`
- Modify: `C:\Projects\notetaker-storage-api\docs\jira-progress.md`
- Modify: `C:\Projects\meeting-notetaker-2\docs\storage-api\rest-contract-v1.md`

- [ ] **Step 1: Document the additive email field, index semantics, endpoint, auth, errors, and migration**

Add an IN-378 subsection to contract §5 with the exact request/response shapes
from the approved design. State explicitly:

```text
POST /api/v1/voiceprints/meeting-candidates
regular auth = exact delegated access_as_user scope
admin auth = StorageApi.Admin
1..50 candidates
only exact requested active records are returned
disabled/deleted/stale/missing collapse into missing
the operation writes no audit event until IN-381
existing email-less records require re-enrolment/PUT or an approved backfill
```

Add optional `email` to the `CentralEnrolment` table and the private hashed
index path. Copy the completed source contract byte-for-byte to the desktop
mirror:

```powershell
Copy-Item -LiteralPath C:\Projects\notetaker-storage-api\docs\rest-contract-v1.md -Destination C:\Projects\meeting-notetaker-2\docs\storage-api\rest-contract-v1.md
```

- [ ] **Step 2: Record server verification evidence**

Add the branch commits, focused tests, full pytest count, ruff result, and
deployment ordering to both evidence ledgers. Do not claim a production smoke
until it actually runs.

- [ ] **Step 3: Verify exact mirror and clean diffs**

```powershell
$source = Get-FileHash C:\Projects\notetaker-storage-api\docs\rest-contract-v1.md
$mirror = Get-FileHash C:\Projects\meeting-notetaker-2\docs\storage-api\rest-contract-v1.md
if ($source.Hash -ne $mirror.Hash) { throw 'REST contract mirror differs' }
git -C C:\Projects\notetaker-storage-api diff --check
git -C C:\Projects\meeting-notetaker-2 diff --check
```

Expected: hashes match and both diff checks are silent.

- [ ] **Step 4: Commit documentation in each repository**

```powershell
git -C C:\Projects\notetaker-storage-api add docs/rest-contract-v1.md docs/jira-progress.md
git -C C:\Projects\notetaker-storage-api commit -m "docs: publish IN-378 meeting voiceprint contract"
git -C C:\Projects\meeting-notetaker-2 add docs/storage-api/rest-contract-v1.md
git -C C:\Projects\meeting-notetaker-2 commit -m "docs: mirror IN-378 storage contract"
```

## Task 5: Attach fresh Storage API identity to audio and retry routes

**Files:**
- Modify: `C:\Projects\meeting-notetaker-2\scripts\verify-storage-cutover.ts`
- Modify: `C:\Projects\meeting-notetaker-2\src\main\api-request-policy.ts`

- [ ] **Step 1: Add failing route-policy assertions**

Add:

```typescript
assert.equal(
  isStorageRoute({
    method: 'POST',
    path: '/api/v1/meetings/b6accba2-c5e1-447f-a999-63f6330658fb/audio'
  }),
  true
)
assert.equal(
  isStorageRoute({
    method: 'POST',
    path: '/api/v1/meetings/b6accba2-c5e1-447f-a999-63f6330658fb/retry'
  }),
  true
)
assert.equal(
  isStorageRoute({
    method: 'GET',
    path: '/api/v1/meetings/b6accba2-c5e1-447f-a999-63f6330658fb'
  }),
  false
)
```

- [ ] **Step 2: Run and verify RED**

```powershell
npm run verify:storage-cutover
```

Expected: the two POST assertions fail.

- [ ] **Step 3: Extend the storage-route policy**

In `isStorageRoute`, add:

```typescript
const meetingProcessingRoute =
  req.method === 'POST' &&
  /^\/api\/v1\/meetings\/[^/]+\/(?:audio|retry)$/.test(path)
```

Return it alongside the existing enrolment routes:

```typescript
return (
  meetingProcessingRoute ||
  (req.method === 'GET' && path === '/api/v1/people/me/enrolment-status') ||
  (req.method === 'POST' && /^\/api\/v1\/people\/[^/]+\/enroll$/.test(path))
)
```

- [ ] **Step 4: Run and verify GREEN**

```powershell
npm run verify:storage-cutover
npm run typecheck
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

```powershell
git add scripts/verify-storage-cutover.ts src/main/api-request-policy.ts
git commit -m "feat: authorize meeting processing with Storage API token"
```

## Task 6: Implement the desktop batch wire client

**Files:**
- Modify: `C:\Projects\meeting-notetaker-2\backend\tests\test_central_enrolment.py`
- Modify: `C:\Projects\meeting-notetaker-2\backend\app\services\storage_api.py`

- [ ] **Step 1: Add failing client tests**

Add this helper below `_FakeHttpResponse`:

```python
def _capturing_opener(payload: dict, captured: list):
    def opener(req, timeout=30):
        captured.append(req)
        return _FakeHttpResponse(json.dumps(payload).encode("utf-8"))

    return opener
```

Import `UUID` and `MeetingVoiceprintCandidate`, then append this test class:

```python
class RestStorageApiMeetingVoiceprintsTests(unittest.TestCase):
    MEETING_ID = UUID("b6accba2-c5e1-447f-a999-63f6330658fb")

    def _candidate(self, email="david@factor1.com.au", source="invitee"):
        return MeetingVoiceprintCandidate(email=email, source=source)

    def test_posts_once_and_validates_response(self):
        captured = []
        record = _enrolment("david-oid").model_copy(
            update={"email": "david@factor1.com.au"}
        )
        payload = {
            "meeting_id": str(self.MEETING_ID),
            "records": [record.model_dump(mode="json")],
            "missing": [
                {
                    "email": "missing@factor1.com.au",
                    "source": "controlled_expansion",
                }
            ],
        }
        client = RestStorageApiClient(
            "https://storage.example",
            opener=_capturing_opener(payload, captured),
        )
        result = client.get_meeting_voiceprints(
            meeting_id=self.MEETING_ID,
            candidates=[
                self._candidate(),
                self._candidate(
                    "missing@factor1.com.au", "controlled_expansion"
                ),
            ],
            access_token="token",
        )
        self.assertEqual(len(captured), 1)
        self.assertEqual(captured[0].method, "POST")
        self.assertTrue(
            captured[0].full_url.endswith(
                "/api/v1/voiceprints/meeting-candidates"
            )
        )
        self.assertEqual(result.records[0].person_id, "david-oid")
        self.assertEqual(result.records[0].email, "david@factor1.com.au")

    def test_malformed_response_raises_storage_api_error(self):
        client = RestStorageApiClient(
            "https://storage.example",
            opener=_capturing_opener(
                {"meeting_id": str(self.MEETING_ID), "records": "bad"},
                [],
            ),
        )
        with self.assertRaises(StorageApiError):
            client.get_meeting_voiceprints(
                meeting_id=self.MEETING_ID,
                candidates=[self._candidate()],
                access_token="token",
            )

    def test_wrong_meeting_id_raises_storage_api_error(self):
        client = RestStorageApiClient(
            "https://storage.example",
            opener=_capturing_opener(
                {
                    "meeting_id": str(UUID(int=0)),
                    "records": [],
                    "missing": [],
                },
                [],
            ),
        )
        with self.assertRaises(StorageApiError):
            client.get_meeting_voiceprints(
                meeting_id=self.MEETING_ID,
                candidates=[self._candidate()],
                access_token="token",
            )
```

- [ ] **Step 2: Run and verify RED**

```powershell
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest backend.tests.test_central_enrolment -v
```

Expected: import/attribute failures for the missing batch models and method.

- [ ] **Step 3: Implement wire models and protocol method**

Add to `storage_api.py`:

```python
from uuid import UUID

CandidateSource = Literal[
    "invitee", "organizer", "recorder", "controlled_expansion"
]


class MeetingVoiceprintCandidate(BaseModel):
    email: str
    source: CandidateSource


class MeetingVoiceprintBatch(BaseModel):
    meeting_id: UUID
    records: list[CentralEnrolment]
    missing: list[MeetingVoiceprintCandidate]
```

Add `email: str | None = None` to `CentralEnrolment`.

Extend the protocol:

```python
def get_meeting_voiceprints(
    self,
    meeting_id: UUID,
    candidates: list[MeetingVoiceprintCandidate],
    access_token: str | None,
) -> MeetingVoiceprintBatch: ...
```

Implement the REST method:

```python
def get_meeting_voiceprints(
    self,
    meeting_id: UUID,
    candidates: list[MeetingVoiceprintCandidate],
    access_token: str | None,
) -> MeetingVoiceprintBatch:
    raw = self._request(
        "POST",
        "/api/v1/voiceprints/meeting-candidates",
        access_token,
        {
            "meeting_id": str(meeting_id),
            "candidates": [
                candidate.model_dump(mode="json") for candidate in candidates
            ],
        },
    )
    try:
        result = MeetingVoiceprintBatch.model_validate(raw)
    except pydantic.ValidationError as exc:
        raise StorageApiError(
            "storage API returned malformed meeting voiceprints"
        ) from exc
    if result.meeting_id != meeting_id:
        raise StorageApiError("storage API returned the wrong meeting id")
    return result
```

Implement the stub with the same normalized-email semantics by loading all
stub records, selecting exact active emails, and returning ordered
records/missing. The stub must make no live request and must not migrate data.

- [ ] **Step 4: Run and verify GREEN**

```powershell
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest backend.tests.test_central_enrolment -v
```

Expected: all central-enrolment tests pass.

- [ ] **Step 5: Commit**

```powershell
git add backend/app/services/storage_api.py backend/tests/test_central_enrolment.py
git commit -m "feat: add meeting voiceprint Storage API client"
```

## Task 7: Resolve central candidates once with a local outage fallback

**Files:**
- Create: `C:\Projects\meeting-notetaker-2\backend\app\services\meeting_voiceprints.py`
- Create: `C:\Projects\meeting-notetaker-2\backend\tests\test_meeting_voiceprints.py`
- Modify: `C:\Projects\meeting-notetaker-2\backend\app\services\speaker_matching.py`
- Modify: `C:\Projects\meeting-notetaker-2\backend\tests\test_speaker_identity_matching.py`

- [ ] **Step 1: Write failing resolver tests**

Create `backend/tests/test_meeting_voiceprints.py`:

```python
import unittest
from datetime import datetime, timezone
from uuid import UUID

from app.config import Settings
from app.schemas import (
    GraphMeetingAttendeeMetadata,
    GraphMeetingMetadata,
    Meeting,
    MeetingSource,
)
from app.services.meeting_voiceprints import (
    MeetingVoiceprintsUnavailable,
    build_meeting_candidates,
    resolve_meeting_voiceprints,
)
from app.services.storage_api import (
    CentralEnrolment,
    MeetingVoiceprintBatch,
    StorageApiError,
)
from app.services.voiceprints import Voiceprint

MEETING_ID = UUID("b6accba2-c5e1-447f-a999-63f6330658fb")


def scheduled_meeting() -> Meeting:
    return Meeting(
        id=MEETING_ID,
        title="Central candidate test",
        source=MeetingSource.online,
        owner_id="Recorder",
        created_at=datetime.now(timezone.utc),
        graph_metadata=GraphMeetingMetadata(
            meeting_id="graph-event-1",
            organizer_email="organizer@factor1.com.au",
            attendees=[
                GraphMeetingAttendeeMetadata(
                    email="attendee@factor1.com.au",
                    name="Attendee",
                )
            ],
        ),
    )


def local_record(email: str) -> Voiceprint:
    return Voiceprint(
        employee_id=email,
        display_name=email.split("@", 1)[0].title(),
        voiceprints=[f"vp-{email}"],
        model_version="precision-2",
        enrolled_at="2026-07-24T00:00:00+00:00",
    )


def central_record(email: str) -> CentralEnrolment:
    now = datetime.now(timezone.utc)
    return CentralEnrolment(
        person_id="central-oid",
        email=email,
        display_name="David Ahlhaus",
        voiceprints=["central-vp"],
        sample_sources=["recorded"],
        status="active",
        model_version="precision-2",
        consent_recorded_at=now,
        created_at=now,
        updated_at=now,
    )


def central_settings() -> Settings:
    return Settings(
        storage_api_url="https://storage.example",
        storage_api_enabled=True,
        voiceprint_expansion_employee_ids="expansion@factor1.com.au",
        voiceprint_expansion_cap=5,
    )


class SuccessfulClient:
    def __init__(self, records):
        self.records = records
        self.calls = 0

    def get_meeting_voiceprints(self, meeting_id, candidates, access_token):
        self.calls += 1
        return MeetingVoiceprintBatch(
            meeting_id=meeting_id,
            records=self.records,
            missing=[],
        )


class FailingClient:
    def get_meeting_voiceprints(self, meeting_id, candidates, access_token):
        raise StorageApiError("unavailable")


class MeetingVoiceprintResolverTests(unittest.TestCase):
    def test_candidate_order_is_attendees_organizer_recorder_then_expansion(self):
        candidates = build_meeting_candidates(
            scheduled_meeting(),
            recorder_email="recorder@factor1.com.au",
            expansion_emails=[
                "expansion@factor1.com.au",
                "ATTENDEE@factor1.com.au",
            ],
        )
        self.assertEqual(
            [(c.email, c.source) for c in candidates],
            [
                ("attendee@factor1.com.au", "invitee"),
                ("organizer@factor1.com.au", "organizer"),
                ("recorder@factor1.com.au", "recorder"),
                ("expansion@factor1.com.au", "controlled_expansion"),
            ],
        )

    def test_central_success_is_authoritative_and_called_once(self):
        client = SuccessfulClient([central_record("david@factor1.com.au")])
        result = resolve_meeting_voiceprints(
            meeting=scheduled_meeting(),
            recorder_email="recorder@factor1.com.au",
            access_token="token",
            client=client,
            local_records=[local_record("someone@factor1.com.au")],
            settings=central_settings(),
        )
        self.assertFalse(result.degraded)
        self.assertEqual(
            [record.employee_id for record in result.records],
            ["david@factor1.com.au"],
        )
        self.assertEqual(result.request_count, 1)
        self.assertEqual(client.calls, 1)

    def test_successful_missing_does_not_revive_local_legacy_record(self):
        result = resolve_meeting_voiceprints(
            meeting=scheduled_meeting(),
            recorder_email="recorder@factor1.com.au",
            access_token="token",
            client=SuccessfulClient([]),
            local_records=[local_record("attendee@factor1.com.au")],
            settings=central_settings(),
        )
        self.assertEqual(result.records, [])
        self.assertFalse(result.degraded)

    def test_central_failure_uses_only_relevant_local_candidates(self):
        result = resolve_meeting_voiceprints(
            meeting=scheduled_meeting(),
            recorder_email="recorder@factor1.com.au",
            access_token="token",
            client=FailingClient(),
            local_records=[
                local_record("attendee@factor1.com.au"),
                local_record("unrelated@factor1.com.au"),
            ],
            settings=central_settings(),
        )
        self.assertTrue(result.degraded)
        self.assertEqual(
            [record.employee_id for record in result.records],
            ["attendee@factor1.com.au"],
        )

    def test_central_failure_without_local_candidate_is_retryable(self):
        with self.assertRaises(MeetingVoiceprintsUnavailable):
            resolve_meeting_voiceprints(
                meeting=scheduled_meeting(),
                recorder_email="recorder@factor1.com.au",
                access_token="token",
                client=FailingClient(),
                local_records=[],
                settings=central_settings(),
            )


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run and verify RED**

```powershell
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest backend.tests.test_meeting_voiceprints -v
```

Expected: module import failure because the service does not exist.

- [ ] **Step 3: Implement the resolver**

Create `meeting_voiceprints.py` with:

```python
from __future__ import annotations

import logging
from dataclasses import dataclass

from app.config import Settings, get_settings
from app.schemas import Meeting
from app.services.speaker_matching import (
    _candidate_voiceprints_for_meeting,
    _controlled_expansion_ids_from_settings,
)
from app.services.storage_api import (
    MeetingVoiceprintCandidate,
    StorageApiClient,
    StorageApiError,
    central_enrolment_required,
    get_storage_api_client,
)
from app.services.voiceprints import Voiceprint, get_voiceprint_repository

logger = logging.getLogger(__name__)


class MeetingVoiceprintsUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class MeetingVoiceprintResolution:
    records: list[Voiceprint] | None
    degraded: bool
    request_count: int


def build_meeting_candidates(
    meeting: Meeting,
    recorder_email: str | None,
    expansion_emails: list[str],
) -> list[MeetingVoiceprintCandidate]:
    values: list[tuple[str | None, str]] = []
    if meeting.graph_metadata:
        values.extend(
            (attendee.email, "invitee")
            for attendee in meeting.graph_metadata.attendees
        )
        values.append((meeting.graph_metadata.organizer_email, "organizer"))
    values.append((recorder_email, "recorder"))
    values.extend(
        (email, "controlled_expansion") for email in expansion_emails
    )
    seen: set[str] = set()
    result: list[MeetingVoiceprintCandidate] = []
    for value, source in values:
        email = (value or "").strip().casefold()
        if not email or email in seen:
            continue
        seen.add(email)
        result.append(MeetingVoiceprintCandidate(email=email, source=source))
    return result[:50]


def _as_voiceprint(record) -> Voiceprint:
    return Voiceprint(
        employee_id=record.email or record.person_id,
        display_name=record.display_name,
        voiceprints=list(record.voiceprints),
        model_version=record.model_version or "",
        enrolled_at=record.updated_at.isoformat(),
    )


def resolve_meeting_voiceprints(
    meeting: Meeting,
    recorder_email: str | None,
    access_token: str | None,
    *,
    client: StorageApiClient | None = None,
    local_records: list[Voiceprint] | None = None,
    settings: Settings | None = None,
) -> MeetingVoiceprintResolution:
    settings = settings or get_settings()
    if not settings.storage_api_enabled or not settings.storage_api_url:
        return MeetingVoiceprintResolution(None, False, 0)
    expansion = _controlled_expansion_ids_from_settings(settings)
    candidates = build_meeting_candidates(
        meeting, recorder_email, expansion
    )
    if not candidates:
        return MeetingVoiceprintResolution([], False, 0)
    try:
        batch = (client or get_storage_api_client()).get_meeting_voiceprints(
            meeting.id,
            candidates,
            access_token,
        )
        records = [
            _as_voiceprint(record)
            for record in batch.records
            if record.status == "active" and record.email
        ]
        return MeetingVoiceprintResolution(records, False, 1)
    except StorageApiError as exc:
        available = (
            local_records
            if local_records is not None
            else get_voiceprint_repository().get_all()
        )
        fallback = _candidate_voiceprints_for_meeting(
            available,
            meeting,
            controlled_expansion_employee_ids=expansion,
            max_controlled_expansion=settings.voiceprint_expansion_cap,
        )
        if not fallback:
            raise MeetingVoiceprintsUnavailable(
                "central meeting voiceprints unavailable; sign in and retry"
            ) from exc
        logger.warning(
            "central voiceprint retrieval degraded for meeting %s "
            "(candidates=%s fallback=%s)",
            meeting.id,
            len(candidates),
            len(fallback),
        )
        return MeetingVoiceprintResolution(fallback, True, 1)
```

`CentralEnrolment.updated_at` is a `datetime` with a default factory in the
desktop client model, so `_as_voiceprint` uses `record.updated_at.isoformat()`
exactly as shown.

- [ ] **Step 4: Make the matcher accept one resolved list**

Extend the protocol and both implementations:

```python
async def match_speakers(
    self,
    segments: list[TranscriptSegment],
    meeting: Meeting,
    audio_path: Path,
    enrolled_voiceprints: list[Voiceprint] | None = None,
) -> tuple[list[TranscriptSegment], list[MeetingParticipant], int]:
```

In `PyannoteAIVoiceprintMatcher`, replace:

```python
repo = get_voiceprint_repository()
enrolled = repo.get_all()
```

with:

```python
enrolled = (
    get_voiceprint_repository().get_all()
    if enrolled_voiceprints is None
    else enrolled_voiceprints
)
```

An empty list must mean “central lookup succeeded but no requested person is
enrolled”; it must not fall back to the local repository.

Add a test that passes `[]` and verifies the matcher returns
`no_enrolled_voiceprints` without reading the local repository.

- [ ] **Step 5: Run resolver and matcher tests**

```powershell
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest backend.tests.test_meeting_voiceprints backend.tests.test_speaker_identity_matching -v
```

Expected: all focused tests pass.

- [ ] **Step 6: Commit**

```powershell
git add backend/app/services/meeting_voiceprints.py backend/app/services/speaker_matching.py backend/tests/test_meeting_voiceprints.py backend/tests/test_speaker_identity_matching.py
git commit -m "feat: resolve central voiceprints once per meeting"
```

## Task 8: Carry ephemeral auth through upload, retry, and the pipeline

**Files:**
- Modify: `C:\Projects\meeting-notetaker-2\backend\app\routers\meetings.py`
- Modify: `C:\Projects\meeting-notetaker-2\backend\app\services\pipeline.py`
- Create: `C:\Projects\meeting-notetaker-2\backend\tests\test_meeting_processing_auth.py`
- Create: `C:\Projects\meeting-notetaker-2\backend\tests\test_pipeline_voiceprints.py`
- Modify: `C:\Projects\meeting-notetaker-2\backend\tests\test_meeting_export.py`

- [ ] **Step 1: Add failing upload/retry/pipeline tests**

Create `test_meeting_processing_auth.py` as an
`unittest.IsolatedAsyncioTestCase`. Seed one editable meeting, patch
`_prepare_uploaded_audio`, `audio_path_for`, and `kick_pipeline`, then assert
the exact ephemeral values:

```python
await upload_audio(
    meeting_id,
    body,
    actor=owner,
    storage_token="fresh-upload-token",
    user_email="recorder@factor1.com.au",
)
kick.assert_called_once_with(
    meeting_id,
    expected_path,
    storage_token="fresh-upload-token",
    recorder_email="recorder@factor1.com.au",
)
```

For retry:

```python
await retry_pipeline(
    meeting_id,
    actor=owner,
    storage_token="fresh-retry-token",
    user_email="recorder@factor1.com.au",
)
kick.assert_called_once_with(
    meeting_id,
    expected_path,
    storage_token="fresh-retry-token",
    recorder_email="recorder@factor1.com.au",
)
```

Add a pipeline test that patches `resolve_meeting_voiceprints` and the matcher:

```python
resolver.assert_called_once_with(
    meeting,
    recorder_email="recorder@factor1.com.au",
    access_token="attempt-token",
)
matcher.match_speakers.assert_awaited_once_with(
    raw_segments,
    meeting,
    audio_path,
    enrolled_voiceprints=resolved_records,
)
```

Add a failure test where the resolver raises
`MeetingVoiceprintsUnavailable`; assert `PipelineStatus.failed`, preserved
audio, and an error message containing `retry`.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest backend.tests.test_meeting_processing_auth backend.tests.test_pipeline_voiceprints backend.tests.test_meeting_export -v
```

Expected: signature/assertion failures because auth context is not carried.

- [ ] **Step 3: Add private headers to upload and retry**

In `meetings.py`, define:

```python
StorageToken = Annotated[str | None, Header(alias="X-MN-Storage-Token")]
UserEmail = Annotated[str | None, Header(alias="X-MN-User-Email")]
```

Update both handlers:

```python
async def upload_audio(
    meeting_id: UUID,
    body: UploadAudioRequest,
    actor: str = Actor,
    storage_token: StorageToken = None,
    user_email: UserEmail = None,
) -> Meeting:
```

```python
async def retry_pipeline(
    meeting_id: UUID,
    actor: str = Actor,
    storage_token: StorageToken = None,
    user_email: UserEmail = None,
) -> Meeting:
```

Pass only stripped in-memory values:

```python
kick_pipeline(
    meeting_id,
    path,
    storage_token=(storage_token or "").strip() or None,
    recorder_email=(user_email or "").strip().casefold() or None,
)
```

- [ ] **Step 4: Carry context through the background task**

Change pipeline signatures:

```python
async def run_pipeline(
    meeting_id: UUID,
    audio_path: Path,
    *,
    storage_token: str | None = None,
    recorder_email: str | None = None,
) -> None:
```

```python
def kick_pipeline(
    meeting_id: UUID,
    audio_path: Path,
    *,
    storage_token: str | None = None,
    recorder_email: str | None = None,
) -> None:
```

At the identifying-speakers stage:

```python
resolution = resolve_meeting_voiceprints(
    meeting,
    recorder_email=recorder_email,
    access_token=storage_token,
)
segments, participants, unknown_count = await matcher.match_speakers(
    raw_segments,
    meeting,
    audio_path,
    enrolled_voiceprints=resolution.records,
)
```

Create the task with keyword-only auth context:

```python
task = asyncio.create_task(
    run_pipeline(
        meeting_id,
        audio_path,
        storage_token=storage_token,
        recorder_email=recorder_email,
    )
)
```

Never add either value to `Meeting`, `store`, snapshot fields, export models, or
logs.

- [ ] **Step 5: Run focused and full backend tests**

```powershell
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest discover -s backend/tests -t backend -v
```

Expected: every backend test passes.

- [ ] **Step 6: Commit**

```powershell
git add backend/app/routers/meetings.py backend/app/services/pipeline.py backend/tests
git commit -m "feat: use central voiceprints during meeting processing"
```

## Task 9: Verify, document, and prepare the read-only smoke

**Files:**
- Modify: `C:\Projects\meeting-notetaker-2\docs\jira-progress.md`
- Modify: `C:\Projects\notetaker-storage-api\docs\jira-progress.md`

- [ ] **Step 1: Run the complete Storage API verification battery**

```powershell
C:\Projects\notetaker-storage-api\.venv\Scripts\python.exe -m ruff check app tests
C:\Projects\notetaker-storage-api\.venv\Scripts\python.exe -m pytest -v
git -C C:\Projects\notetaker-storage-api diff --check
git -C C:\Projects\notetaker-storage-api status --short --branch
```

Expected: ruff clean, all tests green, no diff errors, only intentional
documentation evidence changes uncommitted.

- [ ] **Step 2: Run the complete desktop verification battery**

```powershell
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest discover -s backend/tests -t backend -v
npm run verify:storage-cutover
npm run verify:graph
npm run typecheck
npm run build
git diff --check
git status --short --branch
```

Expected: every command passes.

- [ ] **Step 3: Perform a native local processing smoke**

Restart Electron completely. Use an isolated `MN_DATA_DIR` and a stub/fake
meeting-candidate response. Confirm:

```text
one central retrieval for the processing attempt
central records used for attendee-first matching
missing candidates remain Speaker N
central failure with one relevant local record logs degraded counts
central failure without a local record leaves audio and enters retryable failed
retry acquires and passes a new token
```

Do not record token, email, OID, or voiceprint values in the evidence.

- [ ] **Step 4: Prepare—but do not perform—the production smoke**

After an authorized merge/deploy, the read-only smoke is:

```http
POST /api/v1/voiceprints/meeting-candidates
```

with a generated meeting UUID and the signed-in user's email. Record only HTTP
status, records count, missing count, and correlation ID. A 200 with either a
record or `missing` proves the endpoint and delegated authorization. Do not PUT,
re-enrol, or backfill production data without a separate explicit approval.

- [ ] **Step 5: Update evidence with only observed results**

Record exact commit hashes and command results in both `docs/jira-progress.md`
files. State production smoke as pending unless it actually ran.

- [ ] **Step 6: Commit final evidence**

```powershell
git -C C:\Projects\notetaker-storage-api add docs/jira-progress.md
git -C C:\Projects\notetaker-storage-api commit -m "docs: record IN-378 server evidence"
git -C C:\Projects\meeting-notetaker-2 add docs/jira-progress.md
git -C C:\Projects\meeting-notetaker-2 commit -m "docs: record IN-378 desktop evidence"
```

- [ ] **Step 7: Final repository review**

```powershell
git -C C:\Projects\notetaker-storage-api log --oneline main..HEAD
git -C C:\Projects\notetaker-storage-api diff --stat main...HEAD
git -C C:\Projects\notetaker-storage-api status --short --branch
git -C C:\Projects\meeting-notetaker-2 log --oneline main..HEAD
git -C C:\Projects\meeting-notetaker-2 diff --stat main...HEAD
git -C C:\Projects\meeting-notetaker-2 status --short --branch
```

Expected: both feature branches are clean, contain only IN-378 work, and have
not been pushed.
