# IN-378 Meeting-Time Voiceprint Retrieval Design

Status: approved by Joseph on 24 July 2026

## Purpose

Make centrally enrolled staff voiceprints available to the Notetaker's
post-meeting speaker-identification pipeline without granting ordinary users
administrator rights.

Today the live Storage API supports self-or-admin reads of one OID-keyed
voiceprint record. That is sufficient for enrolment status, but it cannot
support meeting processing: a signed-in organiser must be able to retrieve the
active voiceprints of invited staff and approved expansion candidates so
pyannoteAI can label the transcript and downstream action-item owners.

This design adds a bounded, authenticated, read-only meeting-candidate
operation to the Storage API and consumes it once per desktop processing
attempt. It preserves the existing self-or-admin GET/PUT resource and does not
give ordinary users any create, update, disable, delete, list-all, or audit-log
permissions.

## Authorities and repositories

- Jira scope: IN-378, under IN-375.
- Storage API contract source of truth:
  `C:\Projects\notetaker-storage-api\docs\rest-contract-v1.md`.
- Desktop contract mirror:
  `docs/storage-api/rest-contract-v1.md`.
- Storage API implementation:
  `C:\Projects\notetaker-storage-api`.
- Desktop and local processing implementation:
  `C:\Projects\meeting-notetaker-2`.
- Existing attendee-first and controlled-expansion rules remain authoritative:
  `backend/app/services/speaker_matching.py` and
  `docs/decisions/2026-07-02-in79-voiceprint-candidate-expansion.md`.

## Scope

IN-378 includes:

1. An additive email field and email-to-OID index for central enrolments.
2. A scoped meeting-candidate batch-read endpoint in the Storage API.
3. Desktop Storage API token propagation on audio-upload and processing-retry
   requests.
4. One central candidate retrieval per processing attempt.
5. In-memory-only use of returned voiceprints.
6. Existing local voiceprints as a logged, limited outage fallback.
7. Retryable processing failure with audio preservation when central retrieval
   fails and no local fallback is available.
8. Contract, unit, integration, and authenticated production-smoke evidence.

IN-378 does not include:

- voiceprint disable, deletion, offboarding, or administration;
- a list-all-voiceprints endpoint;
- a new Graph directory permission;
- persisted desktop caches of central voiceprints;
- automatic mutation or migration of existing production records;
- immutable `voiceprint_used` audit events or the admin audit view, which
  remain IN-381;
- meeting JSON/audio Blob writes, which remain IN-386.

## Security model

### Existing endpoints remain unchanged

`GET/PUT /api/v1/voiceprints/{person_oid}` keep
`require_self_or_admin`. An ordinary user can still read or update only their
own record.

### Meeting-candidate permission

The new endpoint uses a dedicated dependency:

```text
regular user: valid delegated token containing access_as_user
administrator: valid token containing StorageApi.Admin
```

Token validation already verifies signature, issuer, audience, expiry, and OID.
The token parser will additionally expose the space-separated `scp` claim as a
set of scopes. The meeting-reader dependency accepts
`access_as_user` or `StorageApi.Admin`; any other valid token receives 403.

This authorizes the operation, not general administration. The endpoint is
POST-only, read-only, capped, and returns only exact requested active records.
It cannot enumerate the container and has no mutation path.

The desktop renderer never receives the Storage API token or voiceprints.
Electron main acquires the token and attaches it to the loopback FastAPI
request. FastAPI holds the token only in the live background-task call stack.
Tokens are never written to the snapshot, logs, meeting export, or disk cache.

## Central record and email index

### Additive record field

`CentralEnrolment` gains:

```json
{
  "email": "person@factor1.com.au"
}
```

The field is optional for backward compatibility. On a self PUT, the server
normalizes and stamps it from the validated token's `preferred_username`; a
client-supplied self email cannot override the token identity. On an admin PUT,
the server preserves an existing email or accepts the explicitly supplied
target email. Empty values normalize to absent.

Normalization is `strip().casefold()`.

### Private hashed index

When a record has an email, PUT also writes this private index entry in the
existing `voiceprints` container:

```text
by-email/{sha256(normalized_email).hexdigest()}.json
```

The index body contains only:

```json
{
  "person_id": "entra-object-id"
}
```

Email addresses do not appear in Blob paths. Resolution always verifies that
the fetched record's normalized email still equals the requested email and
that its status is `active`. Therefore an old index entry after an email
change cannot return the wrong record.

Record and index writes occur before the existing create/update audit event.
A transient failure returns the standard retryable `storage_unavailable`
response; retrying the idempotent PUT repairs the index. Audit details continue
to exclude email and all voiceprint values.

Existing records without the new field remain valid for self lookup but are
not returned by meeting-candidate resolution. They become resolvable after a
normal re-enrolment/PUT or a separately approved admin backfill. IN-378 performs
no silent production-data migration.

## REST operation

### Request

```http
POST /api/v1/voiceprints/meeting-candidates
Authorization: Bearer <delegated Storage API token>
Content-Type: application/json
```

```json
{
  "meeting_id": "b6accba2-c5e1-447f-a999-63f6330658fb",
  "candidates": [
    {
      "email": "david@factor1.com.au",
      "source": "invitee"
    },
    {
      "email": "benjamin@factor1.com.au",
      "source": "controlled_expansion"
    }
  ]
}
```

`meeting_id` is the Notetaker's immutable app-generated UUID, not a Graph ID.
`candidates` accepts 1–50 entries. `source` is one of:

- `invitee`
- `organizer`
- `recorder`
- `controlled_expansion`

The server normalizes and case-insensitively deduplicates emails while
preserving the first occurrence and its source.

### Success response

```json
{
  "meeting_id": "b6accba2-c5e1-447f-a999-63f6330658fb",
  "records": [
    {
      "person_id": "entra-object-id",
      "email": "david@factor1.com.au",
      "display_name": "David Ahlhaus",
      "voiceprints": ["opaque-provider-value"],
      "sample_sources": ["recorded"],
      "status": "active",
      "model_version": "precision-2",
      "consent_recorded_at": "2026-07-23T01:02:03+00:00",
      "created_at": "2026-07-23T01:02:03+00:00",
      "updated_at": "2026-07-23T01:02:03+00:00"
    }
  ],
  "missing": [
    {
      "email": "benjamin@factor1.com.au",
      "source": "controlled_expansion"
    }
  ]
}
```

Records and missing entries preserve normalized request order. Disabled,
deleted, stale-index, absent, and malformed records all appear as missing;
their existence/status is not disclosed separately. A successful response
with missing candidates is not an error.

The endpoint performs no audit write under IN-378. IN-381 will add the
immutable `voiceprint_used` event using this operation's `meeting_id`,
correlation ID, actor, and returned person IDs without recording voiceprint
values.

### Errors

- 401 `unauthenticated`: token missing or invalid.
- 403 `forbidden`: token is valid but has neither `access_as_user` nor
  `StorageApi.Admin`.
- 422 `validation_error`: invalid UUID, empty/oversized candidate list, invalid
  email, or invalid source.
- 503 `auth_unavailable`: Entra signing keys temporarily unavailable.
- 503 `storage_unavailable`: any non-404 Blob failure.

The existing correlation-ID and redaction middleware applies unchanged.

## Desktop processing data flow

1. Electron main classifies meeting audio upload and processing retry as
   Storage API routes.
2. It acquires a fresh token for
   `api://13298042-714a-4d57-a1c5-481c22753087/access_as_user`.
3. It attaches `X-MN-User-Email`, `X-MN-User-Oid`, and
   `X-MN-Storage-Token` to the loopback request. The renderer sees none of
   them.
4. The FastAPI upload/retry handler passes the token and signed-in email into
   `kick_pipeline`; neither value is persisted.
5. At the identifying-speakers stage, a meeting-candidate resolver builds the
   ordered request:
   Graph attendees, organiser, signed-in recorder, then configured controlled
   expansion emails. It normalizes and deduplicates them.
6. When central storage is enabled, the resolver performs exactly one
   meeting-candidate request for that processing attempt.
7. Active central records are adapted to the existing `Voiceprint` type using
   normalized email as `employee_id`. This preserves the existing
   attendee-first and second-pass expansion matcher.
8. The matcher reuses the returned list for both its base and controlled
   expansion passes. This list is the per-meeting cache and exists only in
   memory for the lifetime of `run_pipeline`.
9. Transcript labels flow into the existing participant and action-item
   ownership logic. Missing candidates remain `Speaker N`; the matcher never
   guesses.
10. On manual retry, Electron obtains a fresh token and the resolver calls the
    Storage API again. No old token or candidate cache is reused.

In stub/developer mode, the current file-backed provider and local matcher
behaviour remain available. Stub data never migrates to the live store.

## Failure and fallback behaviour

Central storage remains authoritative after cutover.

- A successful central response is used as-is. A missing central record does
  not revive a legacy local record.
- If the central request fails because the token/API/Azure is unavailable,
  the resolver selects any matching local attendee/organiser/recorder/
  controlled-expansion records as a limited rollback-window fallback.
- If at least one relevant local record is available, processing may continue
  in degraded mode. Logs and pipeline diagnostics record only meeting ID,
  error classification, candidate counts, and fallback counts—never tokens,
  emails, OIDs, or voiceprint values.
- People without an available fallback remain `Speaker N`.
- If no relevant local record exists, the resolver raises a typed processing
  error. The pipeline enters `failed` with a retry-oriented message and error
  code. Existing audio remains on disk and is not overwritten or deleted.
- A subsequent retry obtains a fresh token and repeats central retrieval.

The fallback does not satisfy the central enrolment gate and is not a
migration mechanism.

## Code boundaries

### Storage API repository

- `app/models.py`: additive central email and request/response models.
- `app/auth/tokens.py`: expose normalized delegated scopes on `Principal`.
- `app/auth/dependencies.py`: meeting-reader permission dependency.
- `app/services/blob.py`: unchanged generic JSON operations.
- `app/routers/voiceprints.py`: email-index write and batch-read endpoint.
- `tests/test_tokens.py`, `tests/test_auth_dependencies.py`,
  `tests/test_voiceprints.py`: authentication, indexing, resolution, privacy,
  and error tests.
- `docs/rest-contract-v1.md`, `docs/jira-progress.md`: source contract and
  evidence.

### Desktop repository

- `src/main/api-request-policy.ts`: attach Storage API identity to audio and
  retry routes.
- `scripts/verify-storage-cutover.ts`: proxy-policy regression coverage.
- `backend/app/services/storage_api.py`: wire models and meeting-candidate
  request.
- `backend/app/services/meeting_voiceprints.py`: candidate assembly,
  central retrieval, local fallback, and typed failures.
- `backend/app/services/speaker_matching.py`: accept one resolved candidate
  list per run while preserving current ordering and expansion logic.
- `backend/app/services/pipeline.py`: carry ephemeral auth context and resolve
  candidates at the speaker-identification stage.
- `backend/app/routers/meetings.py`: accept the existing private Storage
  headers on upload/retry and pass them into the pipeline.
- Focused backend tests plus `docs/storage-api/rest-contract-v1.md` and
  `docs/jira-progress.md`.

## Testing

Implementation follows red-green-refactor.

Storage API tests cover:

- `scp` parsing and exact `access_as_user` matching;
- regular delegated reader, administrator, missing-scope, and unauthenticated
  outcomes;
- self PUT server-stamping normalized email;
- deterministic hashed index creation without plaintext email in the path;
- admin update email preservation;
- normalization, ordering, deduplication, and 50-candidate cap;
- active records returned; disabled/deleted/stale/missing records collapsed
  into `missing`;
- storage failures mapped to 503;
- no audit/log entry containing email or voiceprint values;
- all existing self-or-admin GET/PUT tests remain green.

Desktop tests cover:

- audio/retry route classification and header injection;
- wire request/response validation and malformed response handling;
- candidate order: attendees, organiser, recorder, expansion;
- one central request per processing attempt;
- central success remaining authoritative over legacy local data;
- missing central enrolments remaining unknown;
- partial local fallback on central failure with degraded diagnostics;
- no-fallback typed failure and preserved audio;
- retry performing a new retrieval with newly supplied auth context;
- base and expansion matcher passes sharing the same in-memory records.

Required verification:

- Storage API ruff and full pytest suite.
- Desktop focused tests and full backend unittest suite.
- `npm run verify:graph`.
- `npm run typecheck`.
- `npm run build`.
- `git diff --check` in both repositories.
- Native Electron restart/smoke because Electron main changes do not hot
  reload.

## Deployment and smoke

The Storage API change is additive and deploys before the desktop consumer.
The existing self GET/PUT behaviour remains compatible during the interval.

After the Storage API deploy:

1. Verify unauthenticated meeting-candidate request returns the standard 401
   envelope.
2. From a signed-in desktop session, call the new endpoint with a generated
   meeting UUID and the signed-in user's email.
3. Record only status, response classification, counts, and correlation ID.
4. A 200 response—whether the existing pre-index record is returned or appears
   in `missing`—proves delegated reader authorization and endpoint wiring.
5. Do not PUT, re-enrol, backfill, or otherwise mutate a production voiceprint
   merely to make the smoke return a record without separate explicit
   approval.
6. Run a local/native processing smoke to prove that returned fixture records
   are used once, unknowns remain safe, fallback is logged, and retry re-fetches.

Rollback is code/config only: disable the central Storage API with the existing
`MN_STORAGE_API_ENABLED=false` switch. No production record is deleted or
migrated during rollback.

## Delivery sequence

1. Implement and verify the additive Storage API contract and endpoint.
2. Deploy and perform the read-only authenticated endpoint smoke.
3. Implement and verify the desktop consumer and pipeline integration.
4. Perform the native processing smoke.
5. Record commit/test evidence in both repositories and attach concise evidence
   to IN-378.

