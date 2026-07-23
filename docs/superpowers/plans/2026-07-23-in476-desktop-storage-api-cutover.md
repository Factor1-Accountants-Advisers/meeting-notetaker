# IN-476 Desktop Storage API Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the packaged desktop enrolment flow over to the live authenticated Storage API using Entra object IDs while preserving email-keyed local behavior.

**Architecture:** Electron main extracts the tenant-local OID from the MSAL account, acquires the delegated Storage API token, and forwards email/OID/token headers to FastAPI only for enrolment routes. FastAPI uses email for local staff lookup and OID for central Storage API paths and records; public configuration defaults activate the live API in packaged builds with an explicit rollback switch.

**Tech Stack:** Electron, TypeScript, MSAL Node, Node assertion verification scripts, Python 3/FastAPI/Pydantic, unittest.

---

## File map

- Create `src/main/api-request-policy.ts` — pure request path, timeout, and
  Storage API route classification.
- Create `src/main/storage-api-identity.ts` — pure OID extraction,
  enable/disable policy, and internal header construction.
- Create `scripts/verify-storage-cutover.ts` — executable TypeScript assertions
  for the Electron-main cutover boundary.
- Modify `src/main/env.ts` — public Storage API defaults and override behavior.
- Modify `src/main/auth-msal.ts` — expose OID on sign-in and token results.
- Modify `src/main/auth-session.ts` — cache and expose the signed-in OID.
- Modify `src/main/api-proxy.ts` — use the pure route policy and attach
  email/OID/token headers.
- Modify `backend/app/config.py` — add the operational enable/disable switch.
- Modify `backend/app/services/storage_api.py` — make central activation honor
  that switch and remove provisional/email-era comments.
- Modify `backend/app/routers/people.py` — separate local email identity from
  central OID identity and add pre-provider fail-closed checks.
- Modify `backend/tests/test_central_enrolment.py` — backend regression coverage.
- Modify `package.json` — add `verify:storage-cutover`.
- Modify `backend.env.template` and `backend/.env.example` — document public
  configuration and rollback.
- Modify `docs/storage-api/rest-contract-v1.md` — update live endpoint status.
- Modify `docs/jira-progress.md` — record IN-476 implementation evidence.

### Task 1: Pure Electron cutover policy

**Files:**
- Create: `scripts/verify-storage-cutover.ts`
- Create: `src/main/api-request-policy.ts`
- Create: `src/main/storage-api-identity.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing verification script**

Create `scripts/verify-storage-cutover.ts`:

```ts
import assert from 'node:assert/strict'
import { isStorageRoute, timeoutMsFor } from '../src/main/api-request-policy'
import {
  getAccountOid,
  isStorageApiEnabled,
  storageIdentityHeaders
} from '../src/main/storage-api-identity'

assert.equal(getAccountOid({ idTokenClaims: { oid: ' oid-from-claim ' } }), 'oid-from-claim')
assert.equal(
  getAccountOid({ idTokenClaims: {}, localAccountId: ' cached-local-oid ' }),
  'cached-local-oid'
)
assert.equal(getAccountOid({ idTokenClaims: { oid: '   ' }, localAccountId: '   ' }), undefined)

assert.equal(isStorageApiEnabled({}), true)
assert.equal(isStorageApiEnabled({ MN_STORAGE_API_ENABLED: 'false' }), false)
assert.equal(isStorageApiEnabled({ MN_STORAGE_API_ENABLED: ' FALSE ' }), false)

assert.equal(
  isStorageRoute({ method: 'GET', path: '/api/v1/people/me/enrolment-status?refresh=1' }),
  true
)
assert.equal(
  isStorageRoute({ method: 'POST', path: '/api/v1/people/joseph%40factor1.com.au/enroll' }),
  true
)
assert.equal(
  isStorageRoute({ method: 'POST', path: '/api/v1/people/joseph%40factor1.com.au/flag-reenrollment' }),
  false
)
assert.equal(
  timeoutMsFor({ method: 'POST', path: '/api/v1/people/joseph%40factor1.com.au/enroll' }),
  180_000
)

assert.deepEqual(
  storageIdentityHeaders({
    email: ' joseph@factor1.com.au ',
    oid: ' oid-123 ',
    accessToken: ' token-value '
  }),
  {
    'X-MN-User-Email': 'joseph@factor1.com.au',
    'X-MN-User-Oid': 'oid-123',
    'X-MN-Storage-Token': 'token-value'
  }
)
assert.deepEqual(storageIdentityHeaders({ email: 'joseph@factor1.com.au' }), {
  'X-MN-User-Email': 'joseph@factor1.com.au'
})

console.log('Storage API cutover verification passed')
```

- [ ] **Step 2: Run it and verify RED**

Run:

```powershell
npx esbuild scripts/verify-storage-cutover.ts --bundle --platform=node --format=cjs --outfile=out/verify-storage-cutover.cjs --log-level=error
```

Expected: FAIL because `api-request-policy.ts` and
`storage-api-identity.ts` do not exist.

- [ ] **Step 3: Implement the pure request policy**

Create `src/main/api-request-policy.ts`:

```ts
export interface ApiRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
}

export function loggablePath(path: string): string {
  return path.split('?')[0]
}

export function timeoutMsFor(req: ApiRequest): number {
  const path = loggablePath(req.path)
  if (req.method === 'POST' && path.endsWith('/audio')) return 120_000
  if (req.method === 'POST' && path.endsWith('/email')) return 90_000
  if (req.method === 'POST' && path.endsWith('/enroll')) return 180_000
  if (req.method === 'POST') return 30_000
  return 15_000
}

export function isStorageRoute(req: Pick<ApiRequest, 'method' | 'path'>): boolean {
  const path = loggablePath(req.path)
  return (
    (req.method === 'GET' && path === '/api/v1/people/me/enrolment-status') ||
    (req.method === 'POST' && /^\/api\/v1\/people\/[^/]+\/enroll$/.test(path))
  )
}
```

- [ ] **Step 4: Implement the pure identity policy**

Create `src/main/storage-api-identity.ts`:

```ts
export interface MsalAccountIdentity {
  localAccountId?: string
  idTokenClaims?: Record<string, unknown>
}

export interface StorageIdentity {
  email?: string
  oid?: string
  accessToken?: string
}

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

export function getAccountOid(account: MsalAccountIdentity | null | undefined): string | undefined {
  return clean(account?.idTokenClaims?.oid) ?? clean(account?.localAccountId)
}

export function isStorageApiEnabled(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  return clean(env.MN_STORAGE_API_ENABLED)?.toLowerCase() !== 'false'
}

export function storageIdentityHeaders(identity: StorageIdentity): Record<string, string> {
  const headers: Record<string, string> = {}
  const email = clean(identity.email)
  const oid = clean(identity.oid)
  const accessToken = clean(identity.accessToken)
  if (email) headers['X-MN-User-Email'] = email
  if (oid) headers['X-MN-User-Oid'] = oid
  if (accessToken) headers['X-MN-Storage-Token'] = accessToken
  return headers
}
```

- [ ] **Step 5: Add and run the verification command**

Add to `package.json`:

```json
"verify:storage-cutover": "esbuild scripts/verify-storage-cutover.ts --bundle --platform=node --format=cjs --outfile=out/verify-storage-cutover.cjs --log-level=error && node out/verify-storage-cutover.cjs"
```

Run:

```powershell
npm run verify:storage-cutover
```

Expected: `Storage API cutover verification passed`.

- [ ] **Step 6: Commit**

```powershell
git add package.json scripts/verify-storage-cutover.ts src/main/api-request-policy.ts src/main/storage-api-identity.ts
git commit -m "test: define IN-476 desktop cutover policy"
```

### Task 2: Public production configuration

**Files:**
- Modify: `scripts/verify-storage-cutover.ts`
- Modify: `src/main/env.ts`

- [ ] **Step 1: Add failing public-config assertions**

Append imports and assertions to `scripts/verify-storage-cutover.ts`:

```ts
import { applyPublicEnvDefaults, PUBLIC_APP_CONFIG } from '../src/main/env'

assert.equal(
  PUBLIC_APP_CONFIG.MN_STORAGE_API_URL,
  'https://func-innov-nt-storage-prod-eqg7dzf8gfbqawea.australiaeast-01.azurewebsites.net'
)
assert.equal(
  PUBLIC_APP_CONFIG.MN_STORAGE_API_SCOPE,
  'api://13298042-714a-4d57-a1c5-481c22753087/access_as_user'
)

const emptyEnv: NodeJS.ProcessEnv = {}
applyPublicEnvDefaults(emptyEnv)
assert.equal(emptyEnv.MN_STORAGE_API_URL, PUBLIC_APP_CONFIG.MN_STORAGE_API_URL)
assert.equal(emptyEnv.MN_STORAGE_API_SCOPE, PUBLIC_APP_CONFIG.MN_STORAGE_API_SCOPE)

const overrideEnv: NodeJS.ProcessEnv = {
  MN_STORAGE_API_URL: 'https://override.example',
  MN_STORAGE_API_SCOPE: 'api://override/scope',
  MN_STORAGE_API_ENABLED: 'false'
}
applyPublicEnvDefaults(overrideEnv)
assert.equal(overrideEnv.MN_STORAGE_API_URL, 'https://override.example')
assert.equal(overrideEnv.MN_STORAGE_API_SCOPE, 'api://override/scope')
assert.equal(overrideEnv.MN_STORAGE_API_ENABLED, 'false')
```

- [ ] **Step 2: Run and verify RED**

Run `npm run verify:storage-cutover`.

Expected: FAIL because `PUBLIC_APP_CONFIG` and `applyPublicEnvDefaults` are not
exported.

- [ ] **Step 3: Implement public defaults**

In `src/main/env.ts`, replace `PUBLIC_ENTRA_CONFIG` with:

```ts
export const PUBLIC_APP_CONFIG = {
  MN_ENTRA_CLIENT_ID: '3e3f3422-d4fa-4ebe-9b22-148439e84cc3',
  MN_ENTRA_TENANT_ID: '891d380b-39a6-4eb4-aca5-4ffe1d3c25ac',
  MN_STORAGE_API_URL:
    'https://func-innov-nt-storage-prod-eqg7dzf8gfbqawea.australiaeast-01.azurewebsites.net',
  MN_STORAGE_API_SCOPE:
    'api://13298042-714a-4d57-a1c5-481c22753087/access_as_user'
} as const
```

Change `setDefaultEnv` to accept an environment object:

```ts
function setDefaultEnv(
  key: string,
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (!hasUsableEnvValue(env[key]) && hasUsableEnvValue(value)) env[key] = value
}

export function applyPublicEnvDefaults(env: NodeJS.ProcessEnv = process.env): void {
  setDefaultEnv('MN_ENTRA_CLIENT_ID', env.AZURE_AD_CLIENT_ID, env)
  setDefaultEnv('MN_ENTRA_TENANT_ID', env.AZURE_AD_TENANT_ID, env)
  for (const [key, value] of Object.entries(PUBLIC_APP_CONFIG)) {
    setDefaultEnv(key, value, env)
  }
}
```

Finish `loadPublicEnv()` with:

```ts
applyPublicEnvDefaults()
```

- [ ] **Step 4: Run and verify GREEN**

Run:

```powershell
npm run verify:storage-cutover
npm run typecheck:node
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit**

```powershell
git add scripts/verify-storage-cutover.ts src/main/env.ts
git commit -m "feat: configure live Storage API defaults"
```

### Task 3: Electron MSAL OID propagation

**Files:**
- Modify: `src/main/auth-msal.ts`
- Modify: `src/main/auth-session.ts`
- Modify: `src/main/api-proxy.ts`

- [ ] **Step 1: Make API proxy consume the tested pure policy**

Import:

```ts
import { isStorageRoute, loggablePath, timeoutMsFor, type ApiRequest } from './api-request-policy'
import { isStorageApiEnabled, storageIdentityHeaders } from './storage-api-identity'
```

Delete the local `ApiRequest`, `loggablePath`, and `timeoutMsFor`
implementations.

- [ ] **Step 2: Add OID to MSAL results**

In `auth-msal.ts`, import `getAccountOid` and add `accountOid?: string` to
`MsalTokenResult` and `oid?: string` to `MsalSignInResult`.

Return `oid: getAccountOid(currentAccount)` from interactive sign-in, export:

```ts
export function getCurrentMsalAccountOid(): string | undefined {
  return getAccountOid(currentAccount)
}
```

and include:

```ts
accountOid: getAccountOid(result.account)
```

in `toTokenResult`.

- [ ] **Step 3: Cache OID in the auth session**

In `auth-session.ts`, add:

```ts
let currentUserOid: string | undefined

export function getCurrentUserOid(): string | undefined {
  return currentUserOid ?? getCurrentMsalAccountOid()
}
```

Populate `currentUserOid` from silent token results and interactive sign-in.
Clear it on `auth:set-user` and sign-out, just as email is cleared.

- [ ] **Step 4: Attach storage identity headers**

In `api-proxy.ts`, replace the current substring-based storage block with:

```ts
if (isStorageRoute(req)) {
  const scope = process.env.MN_STORAGE_API_SCOPE
  const token =
    scope && isStorageApiEnabled(process.env)
      ? await getStorageApiAccessToken(scope)
      : null
  Object.assign(
    headers,
    storageIdentityHeaders({
      email: getCurrentUserEmail(),
      oid: getCurrentUserOid(),
      accessToken: token ?? undefined
    })
  )
}
```

Email and OID remain attached when the rollback switch is false so local
enrolment-status lookup still works; only delegated token acquisition is
disabled. Keep the existing 180-second timeout through `timeoutMsFor`.

- [ ] **Step 5: Verify the integration**

Run:

```powershell
npm run verify:storage-cutover
npm run verify:graph
npm run typecheck:node
```

Expected: all exit 0.

- [ ] **Step 6: Commit**

```powershell
git add src/main/auth-msal.ts src/main/auth-session.ts src/main/api-proxy.ts
git commit -m "feat: propagate Entra OID to enrolment backend"
```

### Task 4: Backend status cutover and rollback switch

**Files:**
- Modify: `backend/tests/test_central_enrolment.py`
- Modify: `backend/app/config.py`
- Modify: `backend/app/services/storage_api.py`
- Modify: `backend/app/routers/people.py`

- [ ] **Step 1: Add failing status and switch tests**

Add tests that use a capturing client:

```python
class _CapturingStorageApiClient:
    def __init__(self):
        self.calls = []

    def get_enrolment(self, person_id, access_token=None):
        self.calls.append((person_id, access_token))
        return _enrolment().model_copy(update={"person_id": person_id})
```

Assert:

```python
async def test_required_status_uses_email_locally_and_oid_centrally(self):
    self._seed_person(enrolled=True)
    client = _CapturingStorageApiClient()
    with patch("app.routers.people.central_enrolment_required", return_value=True), \
            patch("app.routers.people.get_storage_api_client", return_value=client):
        result = await enrolment_status(
            user_email="joseph@factor1.com.au",
            user_oid="oid-123",
            storage_token="token-123",
        )
    self.assertTrue(result.enrolled_locally)
    self.assertTrue(result.centrally_enrolled)
    self.assertEqual(client.calls, [("oid-123", "token-123")])
```

Add separate missing-OID and missing-token cases asserting `client.calls == []`
and `centrally_enrolled is False`.

Add a seam test that patches settings with
`storage_api_url="https://api.example"` and `storage_api_enabled=False`, then
asserts `central_enrolment_required()` is false.

- [ ] **Step 2: Run and verify RED**

Run:

```powershell
$env:PYTHONPATH='backend'
& 'C:\Projects\meeting-notetaker-2\.worktrees\.venvs\in-476\Scripts\python.exe' -m unittest backend.tests.test_central_enrolment -v
```

Expected: FAIL because the route has no `user_oid` parameter and configuration
has no `storage_api_enabled` field.

- [ ] **Step 3: Implement the rollback switch**

In `backend/app/config.py` add:

```python
storage_api_enabled: bool = True
```

In `backend/app/services/storage_api.py` change:

```python
def central_enrolment_required() -> bool:
    settings = get_settings()
    return settings.storage_api_enabled and bool(settings.storage_api_url)
```

- [ ] **Step 4: Implement OID-keyed status**

Define header aliases with `Annotated` so direct unit-test calls receive `None`
rather than FastAPI `Header` marker objects:

```python
UserEmail = Annotated[str | None, Header(alias="X-MN-User-Email")]
UserOid = Annotated[str | None, Header(alias="X-MN-User-Oid")]
StorageToken = Annotated[str | None, Header(alias="X-MN-Storage-Token")]
```

Use `user_email: UserEmail = None`, `user_oid: UserOid = None`, and
`storage_token: StorageToken = None` on the relevant routes.

Add `X-MN-User-Oid` to `enrolment_status`. Normalize email and OID separately.
Only call:

```python
get_storage_api_client().get_enrolment(oid, access_token=storage_token)
```

when central storage is required and both OID and token are non-empty.

- [ ] **Step 5: Run and verify GREEN**

Run the focused unittest command from Step 2.

Expected: all central-enrolment tests pass.

- [ ] **Step 6: Commit**

```powershell
git add backend/app/config.py backend/app/services/storage_api.py backend/app/routers/people.py backend/tests/test_central_enrolment.py
git commit -m "feat: key central enrolment status by Entra OID"
```

### Task 5: Backend enrolment write cutover

**Files:**
- Modify: `backend/tests/test_central_enrolment.py`
- Modify: `backend/app/routers/people.py`

- [ ] **Step 1: Add failing enrolment-write tests**

Extend central registration tests so successful central enrolment calls:

```python
result = await enroll(
    "joseph@factor1.com.au",
    body,
    actor="Joseph",
    user_email="joseph@factor1.com.au",
    user_oid="oid-123",
    storage_token="token-123",
)
```

and assert the captured central record has `person_id == "oid-123"` while the
local person still has `employee_id == "joseph@factor1.com.au"`.

Add separate tests asserting that missing OID, missing token, and a
path/header-email mismatch return before `PyannoteAIClient` is constructed.
Expect 502 for missing OID/token and 403 for email mismatch.

- [ ] **Step 2: Run and verify RED**

Run the focused central-enrolment test module.

Expected: FAIL because `enroll` has no `user_email` or `user_oid` parameters and
still sets `CentralEnrolment.person_id` to email.

- [ ] **Step 3: Implement pre-provider identity guards**

Add the two headers to `enroll`. After consent and clip-shape validation, when
central storage is required:

```python
signed_in_email = (user_email or "").strip().lower()
person_oid = (user_oid or "").strip()
token = (storage_token or "").strip()
if not signed_in_email or signed_in_email != employee_id:
    raise HTTPException(status.HTTP_403_FORBIDDEN, "Signed-in user does not match enrolment target")
if not person_oid or not token:
    raise HTTPException(
        status.HTTP_502_BAD_GATEWAY,
        "Central voiceprint registration requires a signed-in Storage API identity",
    )
```

Store the validated values for the later central call.

- [ ] **Step 4: Use OID in the central record**

Change:

```python
person_id=employee_id
```

to:

```python
person_id=person_oid
```

and pass the validated token to `register_voiceprint`.

- [ ] **Step 5: Run and verify GREEN**

Run:

```powershell
$env:PYTHONPATH='backend'
& 'C:\Projects\meeting-notetaker-2\.worktrees\.venvs\in-476\Scripts\python.exe' -m unittest backend.tests.test_central_enrolment -v
```

Expected: all focused tests pass.

- [ ] **Step 6: Commit**

```powershell
git add backend/app/routers/people.py backend/tests/test_central_enrolment.py
git commit -m "feat: register central voiceprints with Entra OID"
```

### Task 6: Configuration and contract documentation

**Files:**
- Modify: `backend.env.template`
- Modify: `backend/.env.example`
- Modify: `docs/storage-api/rest-contract-v1.md`
- Modify: `docs/jira-progress.md`

- [ ] **Step 1: Document configuration**

Add the exact public URL and scope as commented examples to both environment
templates. Document `MN_STORAGE_API_ENABLED=false` as the rollback switch and
state that no Blob credential or client secret is used.

- [ ] **Step 2: Correct the contract status**

Update the contract introduction and section 5 to state that the voiceprint
GET/PUT endpoints are implemented and live as of 23 July 2026. Remove the stale
sentence predicting disable/flag operations in IN-377; keep `require_admin`
reserved for future admin-only operations.

- [ ] **Step 3: Add implementation evidence**

Add an IN-476 entry to `docs/jira-progress.md` describing:

- Electron OID propagation;
- public URL/scope defaults and rollback;
- email-local/OID-central separation;
- fail-closed pre-provider guards;
- automated verification commands;
- authenticated production-smoke status, or an explicit pending marker if user
  interaction is still required.

- [ ] **Step 4: Verify documentation hygiene**

Run:

```powershell
git diff --check
rg -n "not yet built|Status: contract only|IN-377's disable" docs/storage-api/rest-contract-v1.md
```

Expected: `git diff --check` exits 0 and the stale-text search returns no
matches.

- [ ] **Step 5: Commit**

```powershell
git add backend.env.template backend/.env.example docs/storage-api/rest-contract-v1.md docs/jira-progress.md
git commit -m "docs: record IN-476 cutover configuration"
```

### Task 7: Full verification and authenticated smoke

**Files:**
- Modify: `docs/jira-progress.md`

- [ ] **Step 1: Run the complete static and automated battery**

```powershell
npm run verify:storage-cutover
npm run verify:graph
npm run typecheck
npm run build
$env:PYTHONPATH='backend'
& 'C:\Projects\meeting-notetaker-2\.worktrees\.venvs\in-476\Scripts\python.exe' -m unittest discover -s backend/tests -t backend -v
git diff --check
git status --short
```

Expected: both Node verification scripts pass, typecheck/build exit 0, the full
backend suite reports `OK`, and diff hygiene is clean.

- [ ] **Step 2: Inspect the exact changed files**

Run:

```powershell
git diff main...HEAD --stat
git diff main...HEAD -- src/main backend/app backend/tests scripts package.json backend.env.template docs
```

Confirm no renderer token exposure, no secret, no storage credential, and no
unrelated change.

- [ ] **Step 3: Run the native authenticated read smoke**

Restart Electron fully. Use the signed-in session to call
`GET /api/v1/people/me/enrolment-status`. Confirm the flow silently acquires the
Storage API scope and the live Storage API returns either:

- 200 with a contract-valid record; or
- 404 for the signed-in OID with the contract error envelope.

Record only status, response classification, and correlation ID.

- [ ] **Step 4: Gate any production write**

If GET returns 404 and end-to-end write proof is required, stop and show Joseph
the exact operation and target OID. Do not send PUT until Joseph explicitly
approves the production mutation.

- [ ] **Step 5: Final evidence commit**

If the smoke adds evidence to `docs/jira-progress.md`:

```powershell
git add docs/jira-progress.md
git commit -m "docs: record IN-476 authenticated smoke"
```

- [ ] **Step 6: Update Jira**

Add a concise comment to IN-476 with commit hashes, automated verification,
read-smoke evidence, and any still-pending production write or native UI check.
Do not transition the issue to Done unless every acceptance criterion is
verified.
