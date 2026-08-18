# SharePoint Transcript Permission Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Break broad SharePoint inheritance on each recording owner's folder before uploading future transcripts, while preserving that user's upload/write access, existing management access, and meeting-specific read grants.

**Architecture:** Electron main supplies the authenticated owner's email alongside the delegated Graph token. The backend prepares the owner folder as a fail-closed privacy preflight: resolve/create the folder, use the owner's first invite with `retainInheritedPermissions: false`, grant the existing management Entra group, list the effective ACL, and reject broad staff principals. Only a verified folder is eligible for transcript and summary uploads; recipient grants remain per file afterward.

**Tech Stack:** Electron 33, TypeScript 5.7, MSAL Node, FastAPI, Python 3, Pydantic Settings, Microsoft Graph Files API, `unittest`, esbuild verification scripts.

---

## File map

- Create `src/main/sharepoint-identity.ts`: pure construction of the trusted SharePoint owner-email header.
- Create `scripts/verify-sharepoint-privacy.ts`: Node verification for the owner identity header and request-policy wiring.
- Modify `src/main/api-proxy.ts`: attach the owner email to SharePoint delivery requests.
- Modify `package.json`: expose `npm run verify:sharepoint-privacy`.
- Modify `backend/app/config.py`: configure the existing management Entra group.
- Modify `backend/.env.example`: document direct-backend development configuration.
- Modify `backend.env.template`: document the packaged override.
- Modify `backend/app/services/sharepoint.py`: prepare, harden, verify, and cache the owner folder before upload.
- Modify `backend/app/routers/meetings.py`: require owner identity in live mode and run the privacy preflight before content upload.
- Modify `backend/tests/test_sharepoint_provider.py`: provider-level Graph order, payload, ACL, idempotency, and failure coverage.
- Modify `backend/tests/test_delivery_reliability.py`: route-level ordering, owner preservation, fail-closed, and stub coverage.
- Modify `docs/jira-progress.md`: add verified implementation evidence only after all automated checks pass.

## Task 1: Trusted owner identity and management configuration

**Files:**
- Create: `src/main/sharepoint-identity.ts`
- Create: `scripts/verify-sharepoint-privacy.ts`
- Modify: `src/main/api-proxy.ts:45-58`
- Modify: `package.json:8-40`
- Modify: `backend/app/config.py:55-64`
- Modify: `backend/.env.example:35-55`
- Modify: `backend.env.template:42-60`
- Test: `backend/tests/test_sharepoint_provider.py:213-229`

- [ ] **Step 1: Write the failing TypeScript verification**

Create `scripts/verify-sharepoint-privacy.ts`:

```ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sharePointIdentityHeaders } from '../src/main/sharepoint-identity'

assert.deepEqual(sharePointIdentityHeaders(' Joseph@Factor1.com.au '), {
  'X-MN-User-Email': 'joseph@factor1.com.au'
})
assert.deepEqual(sharePointIdentityHeaders(undefined), {
  'X-MN-User-Email': ''
})

const proxySource = readFileSync(join(process.cwd(), 'src/main/api-proxy.ts'), 'utf8')
assert.match(
  proxySource,
  /sharePointIdentityHeaders\(getCurrentUserEmail\(\)\)/,
  'SharePoint POSTs must receive the authenticated owner email from Electron main'
)

console.log('SharePoint privacy verification passed')
```

Add this script to `package.json`:

```json
"verify:sharepoint-privacy": "esbuild scripts/verify-sharepoint-privacy.ts --bundle --platform=node --format=cjs --outfile=out/verify-sharepoint-privacy.cjs --log-level=error && node out/verify-sharepoint-privacy.cjs"
```

- [ ] **Step 2: Add the failing backend configuration assertion**

Add to `SharePointProviderTests` in `backend/tests/test_sharepoint_provider.py`:

```python
def test_management_group_default_uses_existing_innovations_group(self):
    from app.config import Settings

    self.assertEqual(
        Settings().sharepoint_management_group_id,
        "b25cba77-70a4-45e3-96d6-b6146ecbeed0",
    )
```

- [ ] **Step 3: Run both checks and verify they fail**

Run:

```powershell
npm run verify:sharepoint-privacy
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest backend.tests.test_sharepoint_provider.SharePointProviderTests.test_management_group_default_uses_existing_innovations_group -v
```

Expected: the TypeScript build fails because `sharepoint-identity.ts` does not exist, and the Python test fails because `sharepoint_management_group_id` is not defined.

- [ ] **Step 4: Implement the pure owner-header helper and wire it into the proxy**

Create `src/main/sharepoint-identity.ts`:

```ts
export function sharePointIdentityHeaders(email?: string | null): Record<string, string> {
  return {
    'X-MN-User-Email': email?.trim().toLowerCase() ?? ''
  }
}
```

Import and use it in `src/main/api-proxy.ts`:

```ts
import { sharePointIdentityHeaders } from './sharepoint-identity'
```

Replace the SharePoint branch with:

```ts
if (req.path.includes('/sharepoint') && req.method === 'POST') {
  const token = await getGraphAccessToken(GRAPH_SHAREPOINT_SCOPES)
  if (token) headers['X-MN-Graph-Token'] = token
  Object.assign(headers, sharePointIdentityHeaders(getCurrentUserEmail()))
}
```

- [ ] **Step 5: Add the backend setting and template documentation**

Add beside the existing SharePoint settings in `backend/app/config.py`:

```python
# Existing Entra-backed Innovations and Systems management group. The app
# re-grants this group after breaking owner-folder inheritance.
sharepoint_management_group_id: str = "b25cba77-70a4-45e3-96d6-b6146ecbeed0"
```

Add to both `backend/.env.example` and `backend.env.template` in their SharePoint sections:

```dotenv
# Existing Entra group retained on secured owner folders. This is a public
# directory object ID, not a credential.
# MN_SHAREPOINT_MANAGEMENT_GROUP_ID=b25cba77-70a4-45e3-96d6-b6146ecbeed0
```

- [ ] **Step 6: Run focused checks and verify they pass**

Run:

```powershell
npm run verify:sharepoint-privacy
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest backend.tests.test_sharepoint_provider.SharePointProviderTests.test_management_group_default_uses_existing_innovations_group -v
npm run typecheck:node
```

Expected: `SharePoint privacy verification passed`, one Python test passes, and TypeScript reports no errors.

- [ ] **Step 7: Commit the identity/configuration seam**

```powershell
git add -- src/main/sharepoint-identity.ts scripts/verify-sharepoint-privacy.ts src/main/api-proxy.ts package.json backend/app/config.py backend/.env.example backend.env.template backend/tests/test_sharepoint_provider.py
git commit -m "feat: pass trusted owner identity to SharePoint delivery"
```

## Task 2: Resolve owner folders to stable Graph item IDs

**Files:**
- Modify: `backend/app/services/sharepoint.py:33-230`
- Modify: `backend/tests/test_sharepoint_provider.py:231-378`

- [ ] **Step 1: Write failing tests for new and existing folders**

Add the following tests to `SharePointProviderTests`:

```python
async def test_prepare_owner_folder_returns_created_folder_id(self):
    calls = []

    def fake_urlopen(req, timeout=0):
        calls.append((req.get_method(), req.full_url))
        return _Response({"id": "folder-created"})

    provider = GraphSharePointProvider(
        "drive-123",
        "Transcriptions",
        management_group_id="management-oid",
    )
    with patch("urllib.request.urlopen", fake_urlopen):
        folder_id = provider._resolve_owner_folder("Joseph Guerrero", "token")

    self.assertEqual(folder_id, "folder-created")
    self.assertEqual(
        calls,
        [
            (
                "POST",
                "https://graph.microsoft.com/v1.0/drives/drive-123/root:/Transcriptions:/children",
            )
        ],
    )

async def test_prepare_owner_folder_resolves_id_after_create_conflict(self):
    import io
    import urllib.error

    calls = []

    def fake_urlopen(req, timeout=0):
        calls.append((req.get_method(), req.full_url))
        if req.get_method() == "POST":
            raise urllib.error.HTTPError(
                req.full_url,
                409,
                "Conflict",
                {},
                io.BytesIO(b'{"error":{"code":"nameAlreadyExists"}}'),
            )
        return _Response({"id": "folder-existing"})

    provider = GraphSharePointProvider(
        "drive-123",
        "Transcriptions",
        management_group_id="management-oid",
    )
    with patch("urllib.request.urlopen", fake_urlopen):
        folder_id = provider._resolve_owner_folder("Joseph Guerrero", "token")

    self.assertEqual(folder_id, "folder-existing")
    self.assertEqual(
        calls,
        [
            (
                "POST",
                "https://graph.microsoft.com/v1.0/drives/drive-123/root:/Transcriptions:/children",
            ),
            (
                "GET",
                "https://graph.microsoft.com/v1.0/drives/drive-123/root:/Transcriptions/Joseph%20Guerrero",
            ),
        ],
    )
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```powershell
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest backend.tests.test_sharepoint_provider.SharePointProviderTests.test_prepare_owner_folder_returns_created_folder_id backend.tests.test_sharepoint_provider.SharePointProviderTests.test_prepare_owner_folder_resolves_id_after_create_conflict -v
```

Expected: failures because the constructor has no `management_group_id` argument and `_resolve_owner_folder` does not exist.

- [ ] **Step 3: Add the constructor state and folder resolver**

Replace the Graph provider constructor and add the stable resolver. Keep
`_ensure_owner_folder` as a compatibility wrapper until Task 4 removes the
implicit upload-time folder creation:

```python
def __init__(
    self,
    drive_id: str,
    folder_path: str,
    management_group_id: str = "",
) -> None:
    self._drive_id = drive_id
    self._folder_path = folder_path.strip("/")
    self._management_group_id = management_group_id.strip()
    self._secured_folders: set[str] = set()

def _resolve_owner_folder(self, owner_folder: str, access_token: str) -> str:
    if self._folder_path:
        quoted_parent = urllib.parse.quote(self._folder_path)
        create_url = f"{GRAPH_DRIVE_BASE}/{self._drive_id}/root:/{quoted_parent}:/children"
    else:
        create_url = f"{GRAPH_DRIVE_BASE}/{self._drive_id}/root/children"
    payload = {
        "name": owner_folder,
        "folder": {},
        "@microsoft.graph.conflictBehavior": "fail",
    }
    req = urllib.request.Request(
        create_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code != 409:
            raise
        segments = [part for part in (self._folder_path, owner_folder) if part]
        quoted_path = urllib.parse.quote("/".join(segments))
        get_url = f"{GRAPH_DRIVE_BASE}/{self._drive_id}/root:/{quoted_path}"
        get_req = urllib.request.Request(
            get_url,
            headers={"Authorization": f"Bearer {access_token}"},
            method="GET",
        )
        with urllib.request.urlopen(get_req, timeout=60) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    folder_id = body.get("id")
    if not isinstance(folder_id, str) or not folder_id:
        raise RuntimeError("Graph owner-folder resolution returned no item id")
    return folder_id

def _ensure_owner_folder(self, owner_folder: str, access_token: str) -> None:
    self._resolve_owner_folder(owner_folder, access_token)
```

- [ ] **Step 4: Run the focused tests and the existing provider suite**

Run:

```powershell
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest backend.tests.test_sharepoint_provider -v
```

Expected: the new resolution tests and all existing provider tests pass. The
temporary wrapper preserves the old upload path until Task 4 safely replaces it.

- [ ] **Step 5: Commit the resolver foundation**

```powershell
git add -- backend/app/services/sharepoint.py backend/tests/test_sharepoint_provider.py
git commit -m "refactor: resolve SharePoint owner folder item ids"
```

## Task 3: Break inheritance and re-grant owner and management access

**Files:**
- Modify: `backend/app/services/sharepoint.py:38-310`
- Modify: `backend/tests/test_sharepoint_provider.py`

- [ ] **Step 1: Write the failing inheritance-break payload test**

Add:

```python
async def test_prepare_owner_folder_breaks_inheritance_before_management_grant(self):
    calls = []

    def fake_urlopen(req, timeout=0):
        body = json.loads(req.data.decode("utf-8")) if req.data else None
        calls.append((req.get_method(), req.full_url, body))
        if len(calls) == 1:
            return _Response({"id": "folder-1"})
        if len(calls) in (2, 3):
            return _Response({"value": [{"id": f"permission-{len(calls)}"}]})
        return _Response(
            {
                "value": [
                    {
                        "roles": ["write"],
                        "grantedToV2": {
                            "user": {"email": "joseph@factor1.com.au"}
                        },
                    },
                    {
                        "roles": ["write"],
                        "grantedToV2": {"group": {"id": "management-oid"}},
                    },
                ]
            }
        )

    provider = GraphSharePointProvider(
        "drive-123",
        "Transcriptions",
        management_group_id="management-oid",
    )
    with patch("urllib.request.urlopen", fake_urlopen):
        await provider.prepare_owner_folder(
            owner_folder="Joseph Guerrero",
            owner_email="joseph@factor1.com.au",
            access_token="token",
        )

    owner_invite = calls[1]
    self.assertEqual(owner_invite[0], "POST")
    self.assertEqual(
        owner_invite[1],
        "https://graph.microsoft.com/v1.0/drives/drive-123/items/folder-1/invite",
    )
    self.assertEqual(owner_invite[2]["recipients"], [{"email": "joseph@factor1.com.au"}])
    self.assertEqual(owner_invite[2]["roles"], ["write"])
    self.assertIs(owner_invite[2]["retainInheritedPermissions"], False)

    management_invite = calls[2]
    self.assertEqual(management_invite[2]["recipients"], [{"objectId": "management-oid"}])
    self.assertEqual(management_invite[2]["roles"], ["write"])
    self.assertNotIn("retainInheritedPermissions", management_invite[2])
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest backend.tests.test_sharepoint_provider.SharePointProviderTests.test_prepare_owner_folder_breaks_inheritance_before_management_grant -v
```

Expected: failure because `prepare_owner_folder` does not exist.

- [ ] **Step 3: Extend the provider protocol and local provider**

Add to `SharePointProvider`:

```python
async def prepare_owner_folder(
    self,
    *,
    owner_folder: str,
    owner_email: str,
    access_token: str | None = None,
) -> None:
    raise NotImplementedError
```

Add to `LocalSharePointProvider`:

```python
async def prepare_owner_folder(
    self,
    *,
    owner_folder: str,
    owner_email: str,
    access_token: str | None = None,
) -> None:
    (LOCAL_SHAREPOINT_DIR / owner_folder).mkdir(parents=True, exist_ok=True)
```

- [ ] **Step 4: Implement the Graph invite helper and privacy preflight**

Add to `GraphSharePointProvider`:

```python
def _invite(
    self,
    *,
    item_id: str,
    recipient: dict[str, str],
    roles: list[str],
    access_token: str,
    retain_inherited_permissions: bool | None = None,
) -> None:
    payload: dict[str, object] = {
        "recipients": [recipient],
        "requireSignIn": True,
        "sendInvitation": False,
        "roles": roles,
    }
    if retain_inherited_permissions is not None:
        payload["retainInheritedPermissions"] = retain_inherited_permissions
    url = f"{GRAPH_DRIVE_BASE}/{self._drive_id}/items/{item_id}/invite"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    granted = body.get("value")
    if not isinstance(granted, list) or not granted:
        raise RuntimeError("Graph invite succeeded but granted no permission")

async def prepare_owner_folder(
    self,
    *,
    owner_folder: str,
    owner_email: str,
    access_token: str | None = None,
) -> None:
    if not access_token:
        raise ValueError("SharePoint folder preparation requires a delegated Graph token")
    if not owner_email:
        raise ValueError("SharePoint folder preparation requires the owner email")
    if not self._management_group_id:
        raise ValueError("SharePoint management group is not configured")
    if owner_folder in self._secured_folders:
        return
    folder_id = self._resolve_owner_folder(owner_folder, access_token)
    self._invite(
        item_id=folder_id,
        recipient={"email": owner_email},
        roles=["write"],
        access_token=access_token,
        retain_inherited_permissions=False,
    )
    self._invite(
        item_id=folder_id,
        recipient={"objectId": self._management_group_id},
        roles=["write"],
        access_token=access_token,
    )
    self._verify_owner_folder_permissions(
        folder_id=folder_id,
        owner_email=owner_email,
        access_token=access_token,
    )
    self._secured_folders.add(owner_folder)
```

Temporarily add this method so the test reaches Task 4's verification response:

```python
def _verify_owner_folder_permissions(
    self,
    *,
    folder_id: str,
    owner_email: str,
    access_token: str,
) -> None:
    url = f"{GRAPH_DRIVE_BASE}/{self._drive_id}/items/{folder_id}/permissions"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {access_token}"},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        json.loads(resp.read().decode("utf-8"))
```

- [ ] **Step 5: Run the inheritance test and verify it passes**

```powershell
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest backend.tests.test_sharepoint_provider.SharePointProviderTests.test_prepare_owner_folder_breaks_inheritance_before_management_grant -v
```

Expected: one test passes and the owner invite is the only call carrying `retainInheritedPermissions: false`.

- [ ] **Step 6: Commit the inheritance-break operation**

```powershell
git add -- backend/app/services/sharepoint.py backend/tests/test_sharepoint_provider.py
git commit -m "feat: break SharePoint owner folder inheritance"
```

## Task 4: Verify effective permissions and prohibit unsafe uploads

**Files:**
- Modify: `backend/app/services/sharepoint.py`
- Modify: `backend/tests/test_sharepoint_provider.py`

- [ ] **Step 1: Write failing ACL verification tests**

Add:

```python
async def test_prepare_owner_folder_rejects_broad_staff_principal(self):
    responses = iter(
        [
            _Response({"id": "folder-1"}),
            _Response({"value": [{"id": "owner-permission"}]}),
            _Response({"value": [{"id": "management-permission"}]}),
            _Response(
                {
                    "value": [
                        {
                            "roles": ["write"],
                            "grantedToV2": {
                                "user": {"email": "joseph@factor1.com.au"}
                            },
                        },
                        {
                            "roles": ["write"],
                            "grantedToV2": {"group": {"id": "management-oid"}},
                        },
                        {
                            "roles": ["write"],
                            "grantedToV2": {
                                "siteUser": {"displayName": "Everyone except external users"}
                            },
                        },
                    ]
                }
            ),
        ]
    )
    provider = GraphSharePointProvider(
        "drive-123",
        "Transcriptions",
        management_group_id="management-oid",
    )
    with patch("urllib.request.urlopen", lambda req, timeout=0: next(responses)):
        with self.assertRaisesRegex(
            sharepoint.SharePointPrivacyError,
            "Everyone except external users",
        ):
            await provider.prepare_owner_folder(
                owner_folder="Joseph Guerrero",
                owner_email="joseph@factor1.com.au",
                access_token="token",
            )

async def test_prepare_owner_folder_requires_owner_and_management_write(self):
    responses = iter(
        [
            _Response({"id": "folder-1"}),
            _Response({"value": [{"id": "owner-permission"}]}),
            _Response({"value": [{"id": "management-permission"}]}),
            _Response(
                {
                    "value": [
                        {
                            "roles": ["read"],
                            "grantedToV2": {
                                "user": {"email": "joseph@factor1.com.au"}
                            },
                        },
                        {
                            "roles": ["write"],
                            "grantedToV2": {"group": {"id": "management-oid"}},
                        },
                    ]
                }
            ),
        ]
    )
    provider = GraphSharePointProvider(
        "drive-123",
        "Transcriptions",
        management_group_id="management-oid",
    )
    with patch("urllib.request.urlopen", lambda req, timeout=0: next(responses)):
        with self.assertRaisesRegex(sharepoint.SharePointPrivacyError, "owner write"):
            await provider.prepare_owner_folder(
                owner_folder="Joseph Guerrero",
                owner_email="joseph@factor1.com.au",
                access_token="token",
            )
```

- [ ] **Step 2: Run the tests and verify they fail**

```powershell
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest backend.tests.test_sharepoint_provider.SharePointProviderTests.test_prepare_owner_folder_rejects_broad_staff_principal backend.tests.test_sharepoint_provider.SharePointProviderTests.test_prepare_owner_folder_requires_owner_and_management_write -v
```

Expected: failures because `SharePointPrivacyError` and real ACL verification do not exist.

- [ ] **Step 3: Implement identity extraction and strict ACL verification**

Add near the provider constants:

```python
BROAD_SHAREPOINT_PRINCIPALS = frozenset(
    {
        "everyone except external users",
        "innovations and systems visitors",
        "innovations and systems members",
    }
)


class SharePointPrivacyError(RuntimeError):
    """The destination could not be proven private before content upload."""
```

Add these module helpers:

```python
def _permission_identity_values(permission: dict[str, object]) -> set[str]:
    values: set[str] = set()
    for container_name in ("grantedToV2", "grantedTo"):
        container = permission.get(container_name)
        if not isinstance(container, dict):
            continue
        for identity_name in ("user", "group", "siteUser", "siteGroup"):
            identity = container.get(identity_name)
            if not isinstance(identity, dict):
                continue
            for field in ("id", "email", "displayName", "loginName", "title"):
                value = identity.get(field)
                if isinstance(value, str) and value.strip():
                    values.add(value.strip().casefold())
    return values


def _permission_has_write(permission: dict[str, object]) -> bool:
    roles = permission.get("roles")
    return isinstance(roles, list) and "write" in roles
```

Replace the temporary `_verify_owner_folder_permissions` with:

```python
def _verify_owner_folder_permissions(
    self,
    *,
    folder_id: str,
    owner_email: str,
    access_token: str,
) -> None:
    url = f"{GRAPH_DRIVE_BASE}/{self._drive_id}/items/{folder_id}/permissions"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {access_token}"},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    permissions = body.get("value")
    if not isinstance(permissions, list):
        raise SharePointPrivacyError("SharePoint permission verification returned no ACL")

    owner_key = owner_email.casefold()
    management_key = self._management_group_id.casefold()
    owner_has_write = False
    management_has_write = False
    forbidden: set[str] = set()

    for permission in permissions:
        if not isinstance(permission, dict):
            continue
        identities = _permission_identity_values(permission)
        forbidden.update(BROAD_SHAREPOINT_PRINCIPALS.intersection(identities))
        if _permission_has_write(permission):
            owner_has_write = owner_has_write or owner_key in identities
            management_has_write = management_has_write or management_key in identities

    if forbidden:
        raise SharePointPrivacyError(
            "SharePoint owner folder still exposes broad principals: "
            + ", ".join(sorted(forbidden))
        )
    if not owner_has_write:
        raise SharePointPrivacyError("SharePoint owner folder is missing owner write access")
    if not management_has_write:
        raise SharePointPrivacyError("SharePoint owner folder is missing management write access")
```

- [ ] **Step 4: Require a secured folder before Graph content upload**

In `GraphSharePointProvider.save_transcript`, replace the implicit folder ensure with:

```python
if owner_folder and owner_folder not in self._secured_folders:
    raise SharePointPrivacyError(
        "SharePoint owner folder was not privacy-verified before upload"
    )
```

Keep the existing path construction and `PUT` request after this guard.

- [ ] **Step 5: Update old owner-folder tests to call the privacy preflight**

For every existing Graph test that passes `owner_folder="Joseph Guerrero"`, arrange the four preflight responses in this order before the upload response:

```python
_Response({"id": "folder-1"})
_Response({"value": [{"id": "owner-permission"}]})
_Response({"value": [{"id": "management-permission"}]})
_Response(
    {
        "value": [
            {
                "roles": ["write"],
                "grantedToV2": {"user": {"email": "joseph@factor1.com.au"}},
            },
            {
                "roles": ["write"],
                "grantedToV2": {"group": {"id": "management-oid"}},
            },
        ]
    }
)
```

Then call:

```python
await provider.prepare_owner_folder(
    owner_folder="Joseph Guerrero",
    owner_email="joseph@factor1.com.au",
    access_token="token",
)
```

before `save_transcript`. Construct those providers with `management_group_id="management-oid"`.

- [ ] **Step 6: Run the full provider suite**

```powershell
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest backend.tests.test_sharepoint_provider -v
```

Expected: all provider tests pass; no test can issue a Graph content `PUT` for an owner folder without a successful ACL preflight.

- [ ] **Step 7: Commit strict ACL verification**

```powershell
git add -- backend/app/services/sharepoint.py backend/tests/test_sharepoint_provider.py
git commit -m "feat: verify SharePoint owner folder privacy before upload"
```

## Task 5: Integrate the privacy preflight with meeting delivery

**Files:**
- Modify: `backend/app/services/sharepoint.py:315-322`
- Modify: `backend/app/routers/meetings.py:709-842`
- Modify: `backend/tests/test_delivery_reliability.py:45-540`

- [ ] **Step 1: Extend the route test provider with an explicit preflight record**

Update `CaptureSharePointProvider`:

```python
class CaptureSharePointProvider:
    def __init__(
        self,
        uploads,
        grants,
        preparations=None,
        fail_upload_at=None,
        fail_grant_at=None,
        fail_prepare=False,
    ):
        self.uploads = uploads
        self.grants = grants
        self.preparations = preparations if preparations is not None else []
        self.fail_upload_at = fail_upload_at
        self.fail_grant_at = fail_grant_at
        self.fail_prepare = fail_prepare
        self.grant_attempts = 0

    async def prepare_owner_folder(
        self,
        *,
        owner_folder,
        owner_email,
        access_token=None,
    ):
        self.preparations.append(
            {
                "owner_folder": owner_folder,
                "owner_email": owner_email,
                "token": access_token,
            }
        )
        if self.fail_prepare:
            raise sharepoint.SharePointPrivacyError("simulated broad access")
```

Keep its existing `save_transcript` and `grant_view` methods unchanged.

Also add the protocol method to `UnavailableSharePointProvider` so the existing
provider-unavailable test still reaches its original upload failure:

```python
async def prepare_owner_folder(
    self,
    *,
    owner_folder,
    owner_email,
    access_token=None,
):
    return None
```

- [ ] **Step 2: Write failing route tests for owner preservation and call ordering**

Add:

```python
async def test_sharepoint_prepares_private_owner_folder_before_uploads(self):
    events = []

    class OrderedProvider(CaptureSharePointProvider):
        async def prepare_owner_folder(self, **kwargs):
            events.append("prepare")
            await super().prepare_owner_folder(**kwargs)

        async def save_transcript(self, **kwargs):
            events.append("upload")
            return await super().save_transcript(**kwargs)

    uploads = []
    grants = []
    preparations = []
    meetings_router.get_sharepoint_provider = lambda token=None: OrderedProvider(
        uploads,
        grants,
        preparations,
    )

    await meetings_router.save_transcript_to_sharepoint(
        self.meeting_id,
        actor="Joseph",
        graph_token="token",
        user_email="Joseph@Factor1.com.au",
    )

    self.assertEqual(events, ["prepare", "upload", "upload"])
    self.assertEqual(
        preparations,
        [
            {
                "owner_folder": "Joseph",
                "owner_email": "joseph@factor1.com.au",
                "token": "token",
            }
        ],
    )

async def test_sharepoint_privacy_failure_uploads_nothing(self):
    uploads = []
    grants = []
    meetings_router.get_sharepoint_provider = lambda token=None: CaptureSharePointProvider(
        uploads,
        grants,
        fail_prepare=True,
    )

    with self.assertRaises(HTTPException) as raised:
        await meetings_router.save_transcript_to_sharepoint(
            self.meeting_id,
            actor="Joseph",
            graph_token="token",
            user_email="joseph@factor1.com.au",
        )

    self.assertEqual(raised.exception.status_code, 502)
    self.assertEqual(uploads, [])
    self.assertEqual(grants, [])
    self.assertEqual(
        store.MEETINGS[self.meeting_id].sharepoint_status,
        SharePointStatus.failed,
    )
```

- [ ] **Step 3: Run the new route tests and verify they fail**

```powershell
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest backend.tests.test_delivery_reliability.DeliveryReliabilityTests.test_sharepoint_prepares_private_owner_folder_before_uploads backend.tests.test_delivery_reliability.DeliveryReliabilityTests.test_sharepoint_privacy_failure_uploads_nothing -v
```

Expected: failures because the endpoint has no `user_email` parameter and does not call `prepare_owner_folder`.

- [ ] **Step 4: Pass management configuration into the Graph provider**

Update `get_sharepoint_provider`:

```python
def get_sharepoint_provider(access_token: str | None = None) -> SharePointProvider:
    settings = get_settings()
    drive_id = getattr(settings, "sharepoint_drive_id", "")
    folder_path = getattr(settings, "sharepoint_folder_path", "")
    management_group_id = getattr(settings, "sharepoint_management_group_id", "")
    if access_token and drive_id:
        return GraphSharePointProvider(
            drive_id,
            folder_path,
            management_group_id=management_group_id,
        )
    return LocalSharePointProvider()
```

- [ ] **Step 5: Add the trusted owner email and run preflight before the upload loop**

Change the endpoint signature:

```python
async def save_transcript_to_sharepoint(
    meeting_id: UUID,
    actor: str = Actor,
    graph_token: str = Header("", alias="X-MN-Graph-Token"),
    user_email: str | None = Header(None, alias="X-MN-User-Email"),
) -> Meeting:
```

After the existing Graph-token check, normalize and validate live-mode identity:

```python
owner_email = _normalise_email(user_email)
if settings.sharepoint_drive_id and not owner_email:
    reason = FailureReason.for_category(
        FailureCategory.azure_signin,
        detail="missing_sharepoint_owner_email",
    )
    log_delivery_failure(
        meeting_id,
        "sharepoint",
        reason,
        code="missing_sharepoint_owner_email",
    )
    store.MEETINGS[meeting_id] = meeting.model_copy(
        update={
            "sharepoint_status": SharePointStatus.failed,
            "sharepoint_error_message": "Microsoft sign-in is required before transcript access can be secured",
            "sharepoint_error_code": FailureCategory.azure_signin.value,
        }
    )
    store.save_snapshot()
    raise HTTPException(
        status.HTTP_401_UNAUTHORIZED,
        "Microsoft sign-in is required before transcript access can be secured",
    )
```

Immediately after constructing the provider, before initializing or entering the upload loop, add:

```python
owner_folder = safe_owner_folder(actor)
await provider.prepare_owner_folder(
    owner_folder=owner_folder,
    owner_email=owner_email or "",
    access_token=graph_token or None,
)
```

Reuse `owner_folder` in both `save_transcript` calls instead of recalculating it.

- [ ] **Step 6: Update every direct endpoint test call**

For every direct live-mode endpoint call (`graph_token="token"`), add:

```python
user_email="joseph@factor1.com.au"
```

For the local stand-in test, leave `user_email=None`; `sharepoint_drive_id == ""` keeps owner-email validation disabled and `LocalSharePointProvider.prepare_owner_folder` creates the local directory.

- [ ] **Step 7: Run the delivery suite**

```powershell
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest backend.tests.test_delivery_reliability -v
```

Expected: all delivery reliability tests pass. The ordered test proves preparation precedes both uploads; the failure test proves zero content leaves the machine when inheritance cannot be broken.

- [ ] **Step 8: Commit route integration**

```powershell
git add -- backend/app/services/sharepoint.py backend/app/routers/meetings.py backend/tests/test_delivery_reliability.py
git commit -m "feat: gate transcript uploads on private SharePoint folder"
```

## Task 6: Idempotency, missing-identity, and regression coverage

**Files:**
- Modify: `backend/tests/test_sharepoint_provider.py`
- Modify: `backend/tests/test_delivery_reliability.py`
- Modify: `scripts/verify-sharepoint-privacy.ts`

- [ ] **Step 1: Add the secured-folder idempotency test**

```python
async def test_prepare_owner_folder_is_cached_for_two_artifact_uploads(self):
    calls = []

    def fake_urlopen(req, timeout=0):
        calls.append(req.get_method())
        if calls == ["POST"]:
            return _Response({"id": "folder-1"})
        if len(calls) in (2, 3):
            return _Response({"value": [{"id": f"permission-{len(calls)}"}]})
        if calls[-1] == "GET":
            return _Response(
                {
                    "value": [
                        {
                            "roles": ["write"],
                            "grantedToV2": {
                                "user": {"email": "joseph@factor1.com.au"}
                            },
                        },
                        {
                            "roles": ["write"],
                            "grantedToV2": {"group": {"id": "management-oid"}},
                        },
                    ]
                }
            )
        return _Response()

    provider = GraphSharePointProvider(
        "drive-123",
        "Transcriptions",
        management_group_id="management-oid",
    )
    with patch("urllib.request.urlopen", fake_urlopen):
        await provider.prepare_owner_folder(
            owner_folder="Joseph Guerrero",
            owner_email="joseph@factor1.com.au",
            access_token="token",
        )
        await provider.prepare_owner_folder(
            owner_folder="Joseph Guerrero",
            owner_email="joseph@factor1.com.au",
            access_token="token",
        )
        for filename in ("meeting - Transcript.md", "meeting - Summary.md"):
            await provider.save_transcript(
                meeting=Meeting(
                    id=uuid4(),
                    title="Meeting",
                    source=MeetingSource.online,
                    owner_id="joseph@factor1.com.au",
                    created_at=datetime.now(timezone.utc),
                ),
                filename=filename,
                content="content",
                access_token="token",
                owner_folder="Joseph Guerrero",
            )

    self.assertEqual(calls, ["POST", "POST", "POST", "GET", "PUT", "PUT"])
```

- [ ] **Step 2: Add live-mode missing owner and management tests**

Add to `DeliveryReliabilityTests`:

```python
async def test_sharepoint_live_mode_missing_owner_email_returns_401_before_provider(self):
    provider_called = False

    def provider_factory(token=None):
        nonlocal provider_called
        provider_called = True
        return CaptureSharePointProvider([], [])

    meetings_router.get_sharepoint_provider = provider_factory

    with self.assertRaises(HTTPException) as raised:
        await meetings_router.save_transcript_to_sharepoint(
            self.meeting_id,
            actor="Joseph",
            graph_token="token",
            user_email=None,
        )

    self.assertEqual(raised.exception.status_code, 401)
    self.assertFalse(provider_called)
```

Add to `SharePointProviderTests`:

```python
async def test_prepare_owner_folder_requires_management_configuration(self):
    provider = GraphSharePointProvider("drive-123", "Transcriptions")

    with self.assertRaisesRegex(ValueError, "management group"):
        await provider.prepare_owner_folder(
            owner_folder="Joseph Guerrero",
            owner_email="joseph@factor1.com.au",
            access_token="token",
        )
```

- [ ] **Step 3: Pin the proxy branch more tightly in the Node verification**

Add to `scripts/verify-sharepoint-privacy.ts`:

```ts
const sharePointBranch = proxySource.match(
  /if \(req\.path\.includes\('\/sharepoint'\)[\s\S]*?\n      }/
)
assert.ok(sharePointBranch, 'SharePoint POST branch must exist')
assert.match(sharePointBranch[0], /GRAPH_SHAREPOINT_SCOPES/)
assert.match(sharePointBranch[0], /sharePointIdentityHeaders\(getCurrentUserEmail\(\)\)/)
```

- [ ] **Step 4: Run all focused privacy checks**

```powershell
npm run verify:sharepoint-privacy
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest backend.tests.test_sharepoint_provider backend.tests.test_delivery_reliability backend.tests.test_sharepoint_recipients backend.tests.test_recipient_domain_allowlist -v
npm run typecheck:node
```

Expected: all focused Python tests pass, the privacy verifier prints its success line, and node typecheck passes.

- [ ] **Step 5: Commit the regression coverage**

```powershell
git add -- backend/tests/test_sharepoint_provider.py backend/tests/test_delivery_reliability.py scripts/verify-sharepoint-privacy.ts
git commit -m "test: cover SharePoint privacy preflight regressions"
```

## Task 7: Full verification, evidence, and live release gate

**Files:**
- Modify after successful automated verification: `docs/jira-progress.md`
- Verify only: all changed implementation and test files

- [ ] **Step 1: Run the complete backend suite**

```powershell
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest discover -s backend/tests -t backend -v
```

Expected: all tests pass; the existing environment-dependent skip is acceptable only if its reason is printed and unrelated to SharePoint.

- [ ] **Step 2: Run desktop and repository gates**

```powershell
npm run verify:graph
npm run verify:sharepoint-privacy
npm run typecheck
npm run build
git diff --check
git status --short
```

Expected: both verification scripts print success, both TypeScript projects pass, electron-vite builds main/preload/renderer, `git diff --check` is silent, and status lists only intended task changes plus the user's pre-existing untracked files.

- [ ] **Step 3: Record implementation evidence without changing Jira state**

Add a dated entry to `docs/jira-progress.md` containing:

```markdown
## 18 Aug 2026 — IN-91/IN-398 SharePoint inheritance hardening

- Future deliveries now privacy-prepare the recording owner's SharePoint
  folder before uploading content: owner write grant with
  `retainInheritedPermissions: false`, existing management-group write grant,
  and an effective-ACL check that rejects broad staff principals.
- Electron main supplies the trusted signed-in owner email; renderer code never
  supplies identity or tokens.
- Privacy preparation is fail-closed and precedes both transcript and summary
  uploads. Existing per-file meeting-recipient read grants are unchanged.
- Automated verification: record the exact backend test count and the results
  of `verify:graph`, `verify:sharepoint-privacy`, `typecheck`, `build`, and
  `git diff --check` from this run.
- Live multi-account SharePoint smoke remains the release gate until the owner,
  attendee, non-attendee, and management checks in the approved design pass.
```

Replace the sentence beginning `Automated verification:` with the actual counts and results before committing; do not claim live success here.

- [ ] **Step 4: Commit the verified evidence**

```powershell
git add -- docs/jira-progress.md
git commit -m "docs: record SharePoint permission hardening evidence"
```

- [ ] **Step 5: Perform the live owner upload test**

Using a disposable meeting from an installed build:

1. Sign in as the recording owner.
2. Deliver the transcript and summary.
3. Open [the Transcriptions library](https://futurebusinessgroup.sharepoint.com/sites/InnovationsandSystems/Transcriptions/Forms/AllItems.aspx).
4. Open the owner's folder, select **Manage access**, and confirm the broad staff principals are absent.
5. Confirm the owner can upload, open, and edit both files.

Expected: upload succeeds and the owner folder shows owner write plus existing management access, without Everyone/Visitors/Members.

- [ ] **Step 6: Perform the attendee, non-attendee, and management checks**

1. As an invited internal attendee, confirm both direct URLs open and editing is denied.
2. As an ordinary internal non-attendee, confirm SharePoint search does not reveal the files and both direct URLs deny access.
3. As an Innovations and Systems manager or IT administrator, confirm Manage Access remains available.
4. Retry delivery from the owner app and confirm no duplicate files and no permission widening.

Expected: only the owner, invited attendee, and existing management population can access according to their assigned roles.

- [ ] **Step 7: Update Jira only with explicit authorization**

If Joseph authorizes external updates after the live smoke, add the evidence to [IN-398](https://factor1.atlassian.net/browse/IN-398) and coordinate [IN-91](https://factor1.atlassian.net/browse/IN-91) with David. Do not transition either issue merely because automated tests pass.

## Rollback rule

If the live smoke blocks uploads, roll forward with a higher application version carrying the reverted code. Do not restore broad inheritance as a workaround. The local transcript and summary remain available for retry, so privacy failure must remain fail-closed.
