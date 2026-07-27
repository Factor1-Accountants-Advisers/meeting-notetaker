# IN-386 Meeting Blob Delivery — Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver each processed meeting's canonical schema-1.0 JSON and merged WebM recording from the desktop backend to the authenticated Storage API/Private Azure Blob path, without blocking processing or exposing storage credentials to the renderer.

**Architecture:** Reuse the approved and locally implemented Storage API branch `in386-meeting-blob-delivery` as the server half of IN-386. In the desktop repo, extend the existing `StorageApiClient` seam, add a focused Blob-delivery service and persisted per-meeting state, trigger delivery at pipeline-ready and finalisation, and expose one authenticated retry route plus safe per-meeting notices on the reachable Home post-capture flow. Audio is streamed from the backend directly to the exact short-lived SAS URL; the renderer receives only status and never receives a token, SAS URL, Blob path, raw export, or audio bytes.

**Tech Stack:** Python 3.11, FastAPI, Pydantic v2, standard-library `http.client`, unittest, Electron, TypeScript, React, Vite.

**Authoritative design:** `C:\Projects\notetaker-storage-api\docs\superpowers\specs\2026-07-24-in386-meeting-blob-delivery-design.md` (approved by Joseph on 24 Jul 2026).

---

## Scope and dependency boundary

- The Storage API implementation already exists on local branch
  `in386-meeting-blob-delivery` at `4dc0736`. Preserve and review it; do not
  rewrite the endpoints in the desktop repo.
- The desktop work consumes:
  - `PUT /api/v1/meetings/{meeting_id}/export`
  - `POST /api/v1/meetings/{meeting_id}/audio/upload-sas`
- IN-384 remains the sole deep validator/builder of the canonical export.
  The Storage API performs only the ratified shallow gateway validation.
- IN-390 still owns richer summarisation/action fields. IN-386 uploads the
  valid schema-1.0 record that exists today, including null/empty fields.
- IN-387 SharePoint storage is independent. Blob failure must not affect
  SharePoint, email, finalisation, or the local review workflow.
- This plan does not merge, push, deploy, apply Bicep, mutate Jira, or run a
  production meeting smoke. Those are separate approval-gated release steps.

### Implementation outcome note (27 July 2026)

- Task 5 was adapted during quality review after the codebase proved that
  `MeetingReviewScreen` is intentionally unrouted under the Slice 1
  meeting-detail removal. IN-386 does not restore that navigation.
- Safe status and failed-delivery retry instead live on Home as independent,
  per-meeting notices. Authenticated startup hydration restores actionable
  `pending`/`failed` states, and generation-guarded cancellable polling keeps
  concurrent meetings isolated.
- The feature branch was rebased onto local `main` at `4a3eede`, integrating
  the parallel IN-478/IN-477 work before final verification.

## File map

### Create

- `backend/app/services/blob_delivery.py` — derives the stable UTC time basis,
  coordinates audio-first/JSON-second delivery, persists safe status, and
  contains all non-blocking failure handling.
- `backend/tests/test_storage_api_meetings.py` — REST/stub contract parity and
  safe streaming-SAS upload tests.
- `backend/tests/test_blob_delivery.py` — state machine, trigger, failure
  isolation, retry, finalisation, and privacy tests.

### Modify

- `backend/app/paths.py` — local stub directory for central meeting artifacts.
- `backend/app/services/storage_api.py` — meeting receipt/grant models,
  protocol methods, REST calls, stub behavior, and streaming SAS upload.
- `backend/app/schemas.py` — `BlobStatus` and persisted meeting fields.
- `backend/app/services/pipeline.py` — reset and pipeline-ready trigger.
- `backend/app/routers/meetings.py` — finalisation trigger and manual retry
  route; both receive the Storage API token only through backend headers.
- `backend/app/main.py` — reconcile an interrupted `pending` delivery to a
  retryable `failed` state at startup.
- `src/main/api-request-policy.ts` — exact allowlist for finalise and Blob
  retry token injection.
- `scripts/verify-storage-cutover.ts` — positive and negative route-policy
  assertions proving tokens stay off unrelated routes.
- `src/renderer/src/data/mock.ts` — Blob delivery types and sample defaults.
- `src/renderer/src/lib/api.ts` — DTO mapping and retry API call.
- `src/renderer/src/App.tsx` — per-meeting delivery watchers, authenticated
  actionable-state hydration, and retry orchestration.
- `src/renderer/src/screens/HomeScreen.tsx` — reachable safe status/retry
  notices; no Blob path/provider detail.
- `docs/storage-api/rest-contract-v1.md` — byte-identical mirror of the
  ratified Storage API contract.
- `docs/jira-progress.md` — implementation and verification evidence.

## Delivery rules locked by this plan

1. Pipeline-ready performs a full delivery: merged `audio.webm` first, then
   the canonical JSON. Audio-first avoids creating a JSON history revision
   merely because an audio upload failed.
2. A successful prior delivery followed by finalisation uploads JSON only;
   audio is immutable and is not sent twice. If the earlier full delivery is
   pending/failed, finalisation schedules a full retry.
3. Edits refresh the local IN-384 artifact but do not upload individually.
   Finalisation publishes the accumulated corrections once.
4. `MN_STORAGE_API_ENABLED=false` skips central delivery and leaves the local
   workflow usable. Empty `MN_STORAGE_API_URL` uses the file-backed stub.
5. A configured real Storage API requires a non-empty delegated token. Missing
   token fails closed before any provider call.
6. Delivery errors update only `blob_status` and a fixed, user-safe message.
   Raw exception text, tokens, SAS URLs, Blob paths, transcript text, invitee
   emails, and audio data are never persisted, audited, logged, or returned.

### Task 1: Extend the Storage API seam with meeting delivery

**Files:**
- Create: `backend/tests/test_storage_api_meetings.py`
- Modify: `backend/app/paths.py`
- Modify: `backend/app/services/storage_api.py`

- [ ] **Step 1: Write failing tests for response validation and URL paths**

Add tests that use the existing fake opener pattern and assert:

```python
def test_rest_upload_meeting_export_validates_receipt(self):
    opener = CaptureOpener({
        "meeting_id": str(self.meeting_id),
        "blob_path": f"meetings/2026/07/{self.meeting_id}/meeting.json",
        "revision": "created",
        "updated_at": "2026-07-27T01:02:03Z",
    })
    client = RestStorageApiClient("https://storage.example", opener=opener)

    receipt = client.upload_meeting_export(
        self.meeting_id,
        "2026-07-27T00:00:00Z",
        {"schema_version": "1.0", "meeting_id": str(self.meeting_id)},
        access_token="delegated-token",
    )

    self.assertEqual(receipt.meeting_id, self.meeting_id)
    self.assertEqual(receipt.revision, "created")
    request = opener.requests[0]
    self.assertEqual(request.method, "PUT")
    self.assertEqual(
        request.full_url,
        f"https://storage.example/api/v1/meetings/{self.meeting_id}/export",
    )
    self.assertNotIn("delegated-token", repr(receipt))


def test_rest_requests_exact_audio_upload_grant(self):
    opener = CaptureOpener({
        "upload_url": "https://account.blob.core.windows.net/notetaker/audio.webm?sig=secret",
        "blob_path": f"meetings-audio/2026/07/{self.meeting_id}/audio.webm",
        "expires_at": "2026-07-27T01:12:03Z",
    })
    client = RestStorageApiClient("https://storage.example", opener=opener)

    grant = client.request_audio_upload_sas(
        self.meeting_id,
        "2026-07-27T00:00:00Z",
        access_token="delegated-token",
    )

    self.assertEqual(grant.blob_path, f"meetings-audio/2026/07/{self.meeting_id}/audio.webm")
    self.assertEqual(opener.requests[0].method, "POST")
    self.assertTrue(opener.requests[0].full_url.endswith("/audio/upload-sas"))
```

Also cover malformed/mismatched receipts, malformed grants, missing token,
401/404/422 rejection, 5xx/unreachable mapping, and ensure no error string
contains the access token.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```powershell
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest tests.test_storage_api_meetings -v
```

Expected: import/attribute failures for the missing receipt/grant models and
client methods.

- [ ] **Step 3: Add typed models and protocol methods**

Add these public shapes to `storage_api.py`:

```python
class BlobExportReceipt(BaseModel):
    meeting_id: UUID
    blob_path: str
    revision: Literal["created", "updated"]
    updated_at: datetime


class AudioUploadGrant(BaseModel):
    upload_url: str
    blob_path: str
    expires_at: datetime


class StorageApiClient(Protocol):
    def upload_meeting_export(
        self,
        meeting_id: UUID,
        time_basis_utc: str,
        export_payload: dict,
        access_token: str | None,
    ) -> BlobExportReceipt: ...

    def request_audio_upload_sas(
        self,
        meeting_id: UUID,
        time_basis_utc: str,
        access_token: str | None,
    ) -> AudioUploadGrant: ...

    def upload_audio_to_grant(
        self,
        grant: AudioUploadGrant,
        audio_path: Path,
    ) -> None: ...
```

Implement REST methods through `_request`, validate every response with
Pydantic, and verify the receipt `meeting_id` equals the requested UUID.

- [ ] **Step 4: Write failing tests for bounded-memory audio upload**

Use a fake HTTPS connection and a multi-chunk file:

```python
def test_audio_put_streams_exact_file_without_exposing_sas(self):
    audio = self.temp_dir / "audio.webm"
    audio.write_bytes(b"a" * (2 * 1024 * 1024 + 17))
    connection = CaptureHttpsConnection(status=201)
    grant = AudioUploadGrant(
        upload_url="https://account.blob.core.windows.net/notetaker/audio.webm?sig=secret",
        blob_path="meetings-audio/2026/07/id/audio.webm",
        expires_at="2026-07-27T01:12:03Z",
    )

    put_file_to_sas(
        grant,
        audio,
        connection_factory=lambda host, timeout: connection,
        chunk_size=1024 * 1024,
    )

    self.assertEqual(connection.headers["Content-Type"], "audio/webm")
    self.assertEqual(connection.headers["x-ms-blob-type"], "BlockBlob")
    self.assertEqual(connection.headers["Content-Length"], str(audio.stat().st_size))
    self.assertEqual([len(chunk) for chunk in connection.chunks], [1048576, 1048576, 17])
    self.assertNotIn("secret", repr(connection.safe_summary))
```

Add rejection tests for non-HTTPS URLs, hosts outside
`*.blob.core.windows.net`, user-info/fragments, missing local audio, and
non-2xx Azure responses.

- [ ] **Step 5: Implement streaming SAS upload**

Implement a focused helper using `http.client.HTTPSConnection`: validate the
scheme/host, set `Content-Length`, stream 1 MiB chunks, and never include the
URL in raised errors.

```python
def put_file_to_sas(
    grant: AudioUploadGrant,
    audio_path: Path,
    *,
    connection_factory=HTTPSConnection,
    chunk_size: int = 1024 * 1024,
) -> None:
    parsed = urllib.parse.urlsplit(grant.upload_url)
    hostname = (parsed.hostname or "").casefold()
    if (
        parsed.scheme != "https"
        or not hostname.endswith(".blob.core.windows.net")
        or parsed.username
        or parsed.password
        or parsed.fragment
    ):
        raise StorageApiContractError("storage API returned an invalid audio upload target")
    try:
        size = audio_path.stat().st_size
        connection = connection_factory(hostname, timeout=900)
        target = urllib.parse.urlunsplit(("", "", parsed.path, parsed.query, ""))
        connection.putrequest("PUT", target)
        connection.putheader("Content-Type", "audio/webm")
        connection.putheader("x-ms-blob-type", "BlockBlob")
        connection.putheader("Content-Length", str(size))
        connection.endheaders()
        with audio_path.open("rb") as source:
            while chunk := source.read(chunk_size):
                connection.send(chunk)
        response = connection.getresponse()
        response.read()
        if not 200 <= response.status < 300:
            raise StorageApiRejected(f"audio upload returned {response.status}")
    except StorageApiError:
        raise
    except OSError as exc:
        raise StorageApiUnavailable("audio upload connection failed") from exc
    finally:
        if "connection" in locals():
            connection.close()
```

`RestStorageApiClient.upload_audio_to_grant` calls this helper.

- [ ] **Step 6: Implement a file-backed stub**

Add `central_meetings_dir()` returning `data_root() / "central-meetings"`.
The stub writes:

```text
central-meetings/{meeting_id}/meeting.json
central-meetings/{meeting_id}/history/{server-utc-ts}.json
central-meetings/{meeting_id}/audio.webm
```

Its grant uses an opaque `stub://meeting/{meeting_id}/audio.webm` URL that is
accepted only by the stub's `upload_audio_to_grant`; the REST helper must
continue rejecting it. Use `shutil.copyfile` for audio and `Path.replace`
for atomic JSON writes.

- [ ] **Step 7: Run focused tests and commit**

Run:

```powershell
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest tests.test_storage_api_meetings -v
```

Expected: all tests pass.

Commit:

```powershell
git add backend/app/paths.py backend/app/services/storage_api.py backend/tests/test_storage_api_meetings.py
git commit -m "feat: add meeting delivery Storage API client (IN-386)"
```

### Task 2: Add the persisted non-blocking delivery state machine

**Files:**
- Create: `backend/app/services/blob_delivery.py`
- Create: `backend/tests/test_blob_delivery.py`
- Modify: `backend/app/schemas.py`
- Modify: `backend/app/main.py`

- [ ] **Step 1: Write failing state/time-basis tests**

Cover the three-state model and stable path date:

```python
def test_scheduled_start_is_preferred_as_time_basis(self):
    meeting, export = self.make_ready_meeting(
        scheduled_start="2026-06-30T16:30:00Z",
        created_at=datetime(2026, 7, 27, tzinfo=timezone.utc),
    )
    self.assertEqual(time_basis_utc(meeting, export), "2026-06-30T16:30:00Z")


def test_ad_hoc_meeting_uses_created_at_utc(self):
    meeting, export = self.make_ready_meeting(
        scheduled_start=None,
        created_at=datetime(2026, 7, 27, 9, 30, tzinfo=timezone(timedelta(hours=8))),
    )
    self.assertEqual(time_basis_utc(meeting, export), "2026-07-27T01:30:00Z")
```

Assert old snapshots without Blob fields validate to `pending`, and startup
reconciliation changes an interrupted `pending` delivery on a ready meeting
to `failed` with a safe retry message.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```powershell
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest tests.test_blob_delivery -v
```

Expected: missing `BlobStatus`, fields, and service functions.

- [ ] **Step 3: Add the persisted model**

Add:

```python
class BlobStatus(str, Enum):
    pending = "pending"
    uploaded = "uploaded"
    failed = "failed"
```

and these backward-compatible `Meeting` fields:

```python
blob_status: BlobStatus = BlobStatus.pending
blob_error_message: str | None = None
```

Extend startup reconciliation so a ready meeting left `pending` after an
interrupted app run becomes:

```python
{
    "blob_status": BlobStatus.failed,
    "blob_error_message": "Secure storage upload was interrupted. Retry when connected.",
}
```

- [ ] **Step 4: Write failing delivery tests**

Use a capture client and assert the exact order and privacy boundary:

```python
async def test_full_delivery_uploads_audio_before_json_and_marks_uploaded(self):
    client = CaptureStorageClient()
    await deliver_meeting_to_blob(
        self.meeting_id,
        access_token="delegated-token",
        actor="Joseph",
        client=client,
        include_audio=True,
    )

    self.assertEqual(client.calls, ["request_audio_sas", "upload_audio", "upload_export"])
    meeting = store.MEETINGS[self.meeting_id]
    self.assertEqual(meeting.blob_status, BlobStatus.uploaded)
    self.assertIsNone(meeting.blob_error_message)
    self.assertNotIn("delegated-token", json.dumps(meeting.model_dump(mode="json")))


async def test_audio_failure_does_not_upload_json_or_fail_pipeline(self):
    client = CaptureStorageClient(fail_at="upload_audio")
    await deliver_meeting_to_blob(
        self.meeting_id,
        access_token="delegated-token",
        actor="Joseph",
        client=client,
        include_audio=True,
    )

    meeting = store.MEETINGS[self.meeting_id]
    self.assertEqual(client.calls, ["request_audio_sas", "upload_audio"])
    self.assertEqual(meeting.pipeline_status, PipelineStatus.ready)
    self.assertEqual(meeting.blob_status, BlobStatus.failed)
    self.assertEqual(
        meeting.blob_error_message,
        "Secure storage upload failed while uploading audio. Retry when connected.",
    )
```

Also cover: configured real API + missing token fails before client calls;
disabled cutover skips; missing export/audio fails safely; JSON-only
finalisation does not request SAS; success/failure creates a local audit
entry containing only meeting/status metadata; no exception escapes.

- [ ] **Step 5: Implement the delivery service**

`blob_delivery.py` owns:

```python
async def deliver_meeting_to_blob(
    meeting_id: UUID,
    *,
    access_token: str | None,
    actor: str,
    include_audio: bool,
    client: StorageApiClient | None = None,
) -> Meeting:
    settings = get_settings()
    meeting = store.MEETINGS[meeting_id]
    if not settings.storage_api_enabled:
        return meeting
    export = store.MEETING_EXPORTS.get(meeting_id)
    if meeting.pipeline_status is not PipelineStatus.ready or export is None:
        return _fail(meeting_id, actor, "Secure storage upload is waiting for processed meeting data.")
    if settings.storage_api_url and not access_token:
        return _fail(meeting_id, actor, "Sign in is required to upload this meeting to secure storage.")

    selected = client or get_storage_api_client()
    basis = time_basis_utc(meeting, export)
    _set_pending(meeting_id)
    try:
        if include_audio:
            audio_path = audio_path_for(meeting_id, "audio/webm")
            grant = await asyncio.to_thread(
                selected.request_audio_upload_sas,
                meeting_id,
                basis,
                access_token,
            )
            await asyncio.to_thread(selected.upload_audio_to_grant, grant, audio_path)
        await asyncio.to_thread(
            selected.upload_meeting_export,
            meeting_id,
            basis,
            export,
            access_token,
        )
    except Exception:
        logger.exception("secure meeting storage upload failed for %s", meeting_id)
        stage = "audio" if include_audio and "grant" in locals() else "meeting record"
        return _fail(
            meeting_id,
            actor,
            f"Secure storage upload failed while uploading {stage}. Retry when connected.",
        )
    return _succeed(meeting_id, actor)
```

Refine stage tracking with an explicit local enum/string rather than
inspecting exception text. `_fail` and `_succeed` update only Blob fields,
save the snapshot, and call `store.add_audit` with
`meeting.blob_upload_failed` or `meeting.blob_upload`; audit before/after are
status strings only.

- [ ] **Step 6: Run focused tests and commit**

Run:

```powershell
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest tests.test_blob_delivery -v
```

Expected: all tests pass.

Commit:

```powershell
git add backend/app/schemas.py backend/app/main.py backend/app/services/blob_delivery.py backend/tests/test_blob_delivery.py
git commit -m "feat: add non-blocking meeting Blob delivery state (IN-386)"
```

### Task 3: Wire pipeline-ready, finalisation, and manual retry

**Files:**
- Modify: `backend/app/services/pipeline.py`
- Modify: `backend/app/routers/meetings.py`
- Modify: `backend/tests/test_blob_delivery.py`

- [ ] **Step 1: Write failing trigger tests**

Add tests proving:

```python
async def test_pipeline_ready_attempts_full_delivery_after_export_refresh(self):
    with patch("app.services.pipeline.deliver_meeting_to_blob", new=AsyncMock()) as deliver:
        await pipeline.run_pipeline(
            self.meeting_id,
            self.audio_path,
            storage_token="token",
            storage_actor="Joseph",
        )
    deliver.assert_awaited_once_with(
        self.meeting_id,
        access_token="token",
        actor="Joseph",
        include_audio=True,
    )
    self.assertIn(self.meeting_id, store.MEETING_EXPORTS)


async def test_finalise_schedules_json_only_after_prior_success(self):
    store.MEETINGS[self.meeting_id] = store.MEETINGS[self.meeting_id].model_copy(
        update={"blob_status": BlobStatus.uploaded}
    )
    with patch("app.routers.meetings.kick_blob_delivery") as kick:
        result = await meetings.finalize_meeting(
            self.meeting_id,
            actor="Joseph",
            storage_token="token",
        )
    self.assertEqual(result.status, MeetingStatus.finalized)
    kick.assert_called_once_with(
        self.meeting_id,
        access_token="token",
        actor="Joseph",
        include_audio=False,
    )
```

Also assert: a failed/pending prior delivery makes finalisation schedule a
full delivery; a delivery exception never changes ready/finalized state;
segment edits do not trigger delivery; `POST /blob/retry` requires editor
access and schedules a full delivery; reprocessing resets Blob state to
pending.

- [ ] **Step 2: Run trigger tests and confirm RED**

Run:

```powershell
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest tests.test_blob_delivery -v
```

Expected: missing arguments, trigger calls, and retry route.

- [ ] **Step 3: Wire pipeline-ready safely**

Pass `storage_actor` from `upload_audio`/`retry_pipeline` through
`kick_pipeline` and `run_pipeline`. Immediately after
`refresh_meeting_export(meeting_id)`, call:

```python
await deliver_meeting_to_blob(
    meeting_id,
    access_token=storage_token,
    actor=storage_actor,
    include_audio=True,
)
```

The delivery service must swallow and persist all failures. Keep an outer
defensive `try/except` around this call so an unforeseen delivery bug is
logged but can never execute the pipeline's `failed` transition.

- [ ] **Step 4: Add a retained background-delivery launcher**

Mirror `_PIPELINE_TASKS`:

```python
_BLOB_DELIVERY_TASKS: set[asyncio.Task] = set()


def kick_blob_delivery(
    meeting_id: UUID,
    *,
    access_token: str | None,
    actor: str,
    include_audio: bool,
) -> None:
    task = asyncio.create_task(
        deliver_meeting_to_blob(
            meeting_id,
            access_token=access_token,
            actor=actor,
            include_audio=include_audio,
        )
    )
    _BLOB_DELIVERY_TASKS.add(task)
    task.add_done_callback(_BLOB_DELIVERY_TASKS.discard)
```

- [ ] **Step 5: Wire finalisation and retry**

Add `X-MN-Storage-Token` to finalisation and schedule after local state/audit:

```python
include_audio = meeting.blob_status is not BlobStatus.uploaded
kick_blob_delivery(
    meeting_id,
    access_token=_clean_optional_header(storage_token),
    actor=actor,
    include_audio=include_audio,
)
```

Add:

```python
@router.post("/{meeting_id}/blob/retry", response_model=Meeting)
async def retry_blob_delivery(
    meeting_id: UUID,
    actor: str = Actor,
    storage_token: str | None = Header(None, alias="X-MN-Storage-Token"),
) -> Meeting:
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")
    require(meeting_id, actor, AccessRole.editor)
    if meeting.pipeline_status is not PipelineStatus.ready:
        raise HTTPException(status.HTTP_409_CONFLICT, "Transcript is not ready yet")
    kick_blob_delivery(
        meeting_id,
        access_token=_clean_optional_header(storage_token),
        actor=actor,
        include_audio=True,
    )
    return store.MEETINGS[meeting_id]
```

Set Blob state to pending before scheduling so the returned DTO immediately
reflects retry progress.

- [ ] **Step 6: Run backend tests and commit**

Run:

```powershell
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest tests.test_blob_delivery -v
backend\.venv\Scripts\python.exe -m unittest discover -s backend/tests -t backend -v
```

Expected: focused tests and the full backend suite pass.

Commit:

```powershell
git add backend/app/services/pipeline.py backend/app/routers/meetings.py backend/tests/test_blob_delivery.py
git commit -m "feat: trigger and retry meeting Blob delivery (IN-386)"
```

### Task 4: Extend the Electron token route policy

**Files:**
- Modify: `src/main/api-request-policy.ts`
- Modify: `scripts/verify-storage-cutover.ts`

- [ ] **Step 1: Add failing positive and negative assertions**

Add:

```typescript
assert.equal(
  isStorageRoute({
    method: 'POST',
    path: '/api/v1/meetings/9ab402de-a57f-45a6-8cde-4f89902f5d0b/finalize'
  }),
  true
)
assert.equal(
  isStorageRoute({
    method: 'POST',
    path: '/api/v1/meetings/9ab402de-a57f-45a6-8cde-4f89902f5d0b/blob/retry'
  }),
  true
)
assert.equal(
  isStorageRoute({
    method: 'GET',
    path: '/api/v1/meetings/9ab402de-a57f-45a6-8cde-4f89902f5d0b/blob/retry'
  }),
  false
)
assert.equal(
  isStorageRoute({
    method: 'POST',
    path: '/api/v1/meetings/9ab402de-a57f-45a6-8cde-4f89902f5d0b/email'
  }),
  false
)
```

- [ ] **Step 2: Run the verifier and confirm RED**

Run:

```powershell
npm run verify:storage-cutover
```

Expected: the new finalise/retry positive assertions fail.

- [ ] **Step 3: Expand only the exact meeting mutation allowlist**

Change `meetingProcessingRoute` to match only:

```typescript
const storageBackedMeetingRoute =
  req.method === 'POST' &&
  /^\/api\/v1\/meetings\/[^/]+\/(?:audio|retry|finalize|blob\/retry)$/.test(path)
```

Do not attach Storage tokens to meeting GETs, email, SharePoint, audit, access,
segment-edit, or speaker-name routes.

- [ ] **Step 4: Run verifier/typecheck and commit**

Run:

```powershell
npm run verify:storage-cutover
npm run typecheck:node
```

Expected: both pass.

Commit:

```powershell
git add src/main/api-request-policy.ts scripts/verify-storage-cutover.ts
git commit -m "feat: route Storage token for Blob delivery (IN-386)"
```

### Task 5: Surface safe delivery status and retry on the live Home flow

**Files:**
- Modify: `src/renderer/src/data/mock.ts`
- Modify: `src/renderer/src/lib/api.ts`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/screens/HomeScreen.tsx`

- [ ] **Step 1: Add DTO and view-model fields**

Define:

```typescript
export type BlobStatus = 'pending' | 'uploaded' | 'failed'
```

Add backend DTO fields:

```typescript
blob_status: BlobStatus
blob_error_message: string | null
```

Map them to:

```typescript
blobStatus: dto.blob_status,
blobErrorMessage: dto.blob_error_message,
```

and add safe defaults to every sample meeting.

- [ ] **Step 2: Add the retry API function**

Add:

```typescript
export async function retryBlobDelivery(meetingId: string): Promise<MeetingDto | null> {
  return call<MeetingDto>('POST', `/meetings/${meetingId}/blob/retry`)
}
```

- [ ] **Step 3: Implement reachable per-meeting status notices**

Keep `MeetingReviewScreen` unrouted and free of IN-386 UI. The live App owns
one independent notice/watcher per meeting and Home renders the compact cards:

- pending: “Saving meeting record to secure storage…”
- uploaded: “Meeting record saved to secure storage.”
- failed: the backend's fixed safe message plus “Retry upload”

Use no Blob paths or technical provider errors. Retry is available only for a
canonical `failed` state; it immediately shows `pending`, keeps the action
mounted and disabled while retrying, and replaces status from the returned
DTO. Generation-guarded cancellable polling is keyed by meeting so concurrent
captures cannot overwrite one another. Authenticated startup hydration
restores only actionable ready `pending`/`failed` meetings; prior `uploaded`
history does not clutter Home. Long-running canonical `pending` remains
non-terminal and polls more slowly after ten minutes.

The card uses `role="status"` / `aria-live="polite"`, existing focus/tone
tokens, and a fixed fallback for transport exceptions.

- [ ] **Step 4: Run renderer checks and commit**

Run:

```powershell
npm run typecheck:web
npm run build
```

Expected: both pass and no missing sample-data fields remain.

Commit:

```powershell
git add src/renderer/src/data/mock.ts src/renderer/src/lib/api.ts src/renderer/src/App.tsx src/renderer/src/screens/HomeScreen.tsx
git commit -m "feat: show and retry secure meeting storage (IN-386)"
```

### Task 6: Synchronize the contract and record evidence

**Files:**
- Modify: `docs/storage-api/rest-contract-v1.md`
- Modify: `docs/jira-progress.md`

- [ ] **Step 1: Copy the ratified contract mirror**

After reviewing the Storage API branch diff, copy
`C:\Projects\notetaker-storage-api\docs\rest-contract-v1.md` byte-for-byte to
`docs/storage-api/rest-contract-v1.md`. Do not hand-edit one copy.

- [ ] **Step 2: Prove byte identity**

Run:

```powershell
$server = (Get-FileHash -Algorithm SHA256 C:\Projects\notetaker-storage-api\docs\rest-contract-v1.md).Hash
$desktop = (Get-FileHash -Algorithm SHA256 C:\Projects\meeting-notetaker-2\docs\storage-api\rest-contract-v1.md).Hash
if ($server -ne $desktop) { throw "REST contract mirrors differ" }
```

Expected: no output and exit code 0.

- [ ] **Step 3: Record implementation evidence**

Add an IN-386 section to `docs/jira-progress.md` containing:

- exact Storage API branch/commit reviewed;
- exact desktop commits;
- endpoint/trigger/status behavior;
- confirmation that SAS/token/path/export/audio never reaches the renderer;
- full verification commands and counts;
- explicit release state: not merged/pushed/deployed until separately
  approved;
- production smoke remains pending and is a production write.

- [ ] **Step 4: Commit docs**

```powershell
git add docs/storage-api/rest-contract-v1.md docs/jira-progress.md
git commit -m "docs: record IN-386 desktop delivery evidence"
```

### Task 7: Full verification and security/privacy review

**Files:**
- Verify only; update `docs/jira-progress.md` if actual counts differ.

- [ ] **Step 1: Review the existing Storage API implementation**

From `C:\Projects\notetaker-storage-api` on
`in386-meeting-blob-delivery`, run:

```powershell
.\.venv\Scripts\python.exe -m pytest tests -v
.\.venv\Scripts\python.exe -m ruff check .
git diff main...in386-meeting-blob-delivery --check
```

Expected: all tests pass, Ruff passes, diff check is clean. Review the Bicep
lifecycle diff but do not run `what-if` or deploy without explicit approval.

- [ ] **Step 2: Run the full desktop battery**

From `C:\Projects\meeting-notetaker-2`:

```powershell
$env:PYTHONPATH='backend'
backend\.venv\Scripts\python.exe -m unittest discover -s backend/tests -t backend -v
npm run verify:storage-cutover
npm run verify:graph
npm run typecheck
npm run build
git diff --check
```

Expected: full backend suite passes; both verifiers, typecheck, build, and
diff check pass.

- [ ] **Step 3: Run local wire smokes only**

With the Storage API URL empty (stub mode), exercise:

1. a ready-meeting full delivery;
2. JSON/audio files under `backend/var/central-meetings/{meeting_id}`;
3. failed delivery followed by `POST /blob/retry`;
4. finalisation creating a JSON history revision without re-copying audio.

Use test-created UUIDs and temporary `MN_DATA_DIR`; do not touch production
Blob or the live Storage API.

- [ ] **Step 4: Perform the field-by-field privacy review**

Verify these are the only new client-visible meeting fields:

| Field | Allowed content |
|---|---|
| `blob_status` | `pending`, `uploaded`, or `failed` |
| `blob_error_message` | fixed user-safe text; no URL/path/token/PII |

Verify local audit entries contain meeting identity/title and status only.
Verify central audit events remain exactly the server contract's
`meeting_json_written` and `meeting_audio_sas_issued` shapes. Search tracked
code/docs/test output for `sig=`, `upload_url`, `Authorization`, and sample
token literals; confirm none are logged or persisted.

- [ ] **Step 5: Review repository state**

Run:

```powershell
git status --short --branch
git log --oneline -8
git diff main...HEAD --stat
```

Expected: only intentional IN-386 commits/files are present. Stop before
merge, push, deploy, Bicep apply, Jira transition, or production smoke and
request explicit approval for the desired release actions.
