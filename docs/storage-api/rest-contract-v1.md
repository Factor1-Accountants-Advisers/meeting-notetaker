# Notetaker Storage API — REST Contract v1.0

Status: **Published** (IN-471). Foundation (auth, health, error contract) is
implemented and live. The voiceprint GET/PUT resource described in section 5
was implemented under IN-377 and verified live on 23 July 2026. The IN-378
meeting-candidate operation was deployed and verified live on 24 July 2026.
The additive IN-381 event taxonomy and administrator audit-read operation are
implemented. The IN-380/IN-382 administrator lifecycle operations described
below are implemented on their feature branch and are not deployed. The
additive section 5 staff directory operation (5 Aug 2026) is implemented on
its feature branch and is not yet deployed. The section 7
meeting JSON/audio delivery endpoints were ratified and implemented under
IN-386 on their feature branch and are not yet deployed. The section 9 call
watches — the base feature (create/replace, read signals, delete, plus the
unauthenticated Graph webhook) per the 12 Aug 2026 meeting-call-events design
(decisions D1–D9) — are merged to `main`, dark behind
`NSA_CALL_WATCHES_ENABLED`, and not yet deployed. The section 9 per-meeting
redesign (decisions E1–E6, 14 Aug 2026 call-watch-per-meeting design) —
per-meeting create/replace with a 5-watch cap, the `{join_url_hash}`-scoped
signals/delete routes, and the deprecated `current/*` legacy aliases — is
implemented on the `feature/call-watch-per-meeting` branch, not yet merged,
and ships behind the same flag. Sections marked "reserved" describe future
work only.

Mirrored copy: `meeting-notetaker-2/docs/storage-api/rest-contract-v1.md`
(kept in sync by hand; this repo is the source of truth).

---

## 1. Conventions

- **Base path:** `/api/v1` for every authenticated resource. Health checks
  (section 4) live outside this prefix, at `/health/*`.
- **Auth:** Bearer token in the `Authorization` header — a delegated Entra ID
  token for the **"Notetaker Storage API"** app registration, scope
  `access_as_user`. No API keys, connection strings, or other shared secrets
  are accepted anywhere in this API.
- **Bodies:** JSON in, JSON out. `Content-Type: application/json` on request
  bodies that carry one.
- **Timestamps:** UTC, ISO-8601 (e.g. `2026-07-22T04:31:07.123456+00:00`).
- **Correlation:** callers may send an optional `X-Correlation-Id` request
  header. The API always echoes a correlation id on the response — the
  inbound value if one was sent, otherwise a generated one — on **every**
  response, including error responses (4xx/5xx alike).
- **Versioning:** this document describes v1, which is **additive-only**:
  new fields, new endpoints, and new (documented) error codes may be added
  without a version bump. Any breaking change — removing/renaming a field,
  changing a status code's meaning, tightening a previously-accepted shape —
  ships under a new `/api/v2` base path instead of changing v1 in place.

## 2. Error shape

Every error response (except the two health endpoints — see section 4) uses
exactly this envelope:

```json
{
  "error": {
    "code": "unauthenticated",
    "message": "a bearer token is required",
    "correlation_id": "3f6a9c2e1b7d4f0a9c3e5b7d1f0a9c3e"
  }
}
```

- `code` — a stable, machine-readable string. Client code should branch on
  `code`, never on `message` (message text may change without notice).
- `message` — a human-readable, non-sensitive description. Never contains
  storage URLs, SAS strings, token material, or voiceprint values.
- `correlation_id` — matches the `X-Correlation-Id` response header; use it
  to find the request in Application Insights (see `docs/runbook.md`).

### Error code table

| `code` | HTTP status | Meaning | Retryable? |
|---|---|---|---|
| `unauthenticated` | 401 | Missing/malformed `Authorization` header, or the bearer token failed validation (bad signature, wrong issuer/audience, expired, unknown signing key, missing `oid` claim). Raised **before any storage access occurs.** | No — caller must re-authenticate. |
| `forbidden` | 403 | Token is valid but the caller lacks permission for the operation — e.g. acting on another person's record without `StorageApi.Admin`, or calling an admin-only endpoint without that role. | No. |
| `auth_unavailable` | 503 | The Entra JWKS (signing-key) endpoint could not be reached while validating the token. Distinct from `unauthenticated` so clients don't treat a transient Entra/network outage as an invalid-credential re-auth loop. | **Yes** — retry with backoff. |
| `storage_unavailable` | 503 | Azure Blob Storage returned a non-404 failure (throttling, transient network error, service outage). | **Yes** — retry with backoff. |
| `feature_disabled` | 503 | Call-watch routes only (section 9): `NSA_CALL_WATCHES_ENABLED` is off, or `NSA_GRAPH_NOTIFICATION_URL` is unset or not an `https://` URL. Both configurations collapse to this one code — the desktop backs off identically either way. | No — retrying does not help until an administrator changes configuration. |
| `graph_error` | 502 | `POST /api/v1/call-watches` only (section 9): Microsoft Graph itself rejected or failed the subscription-create call. `message` is a fixed static string; Graph's own response text (which can echo the join URL back) is never relayed to the client and is logged only as a status code, never as text. A malformed `scheduled_end_utc` is caught earlier, at the request model, and surfaces as `422 validation_error` instead — see section 9.2. | **Yes** — retry with backoff; a transient Graph failure may succeed on retry. |
| `watch_limit` | 409 | `POST /api/v1/call-watches` only (section 9): the caller already holds `5` non-expired watches for **other** meetings. Replacing an existing meeting's own watch is exempt and never returns this code — see section 9.2. | No — delete an existing watch first, or wait for one to expire. |
| `validation_error` | 422 | The request body failed schema validation. | No (fix the request). |
| `payload_too_large` | 413 | A request document exceeds a documented size cap — currently only the section 7 meeting export document (50 MiB). | No (reduce the document). |
| `http_error` | 404 / 405 / other | Generic HTTP-level failures that aren't one of the above — e.g. unmatched route (404), disallowed method (405). The `message` field carries the underlying HTTP reason where available. | Depends on status. |
| `internal_error` | 500 | Any unhandled exception. Sanitized — no stack trace, no internal detail. The full exception is recorded server-side in Application Insights only, keyed by `correlation_id`. | Situational — safe to retry once. |

Notes:

- **422 carries no field-level detail today.** The `message` is a generic
  "request validation failed" string with no per-field breakdown, by
  deliberate leak-safe default. A sanitized field-list may be **added**
  later (e.g. `error.details.fields`) — that would be an additive change,
  compatible with v1 clients that ignore unknown fields.
- **409 has two producers today:** invalid voiceprint lifecycle transitions
  (`conflict` — for example trying to enable a deleted tombstone or enable a
  record that is not disabled) and the section 9 call-watch cap (`watch_limit`
  — see the table above). It remains reserved for future optimistic-concurrency
  control on other resources.
- 401 is always raised before any storage code runs — the FastAPI auth
  dependency (`require_user`) is attached at router-include time for every
  non-health router, so an unauthenticated or unauthorized request never
  reaches a handler that would touch Blob Storage.

## 3. Auth semantics

- **Identity source:** the caller's identity is taken **only** from the
  validated token's `oid` claim (Entra object id) — never from a URL path
  segment or a request body field. A request body that includes a
  conflicting `person_id`/`person_oid` value does not change who the caller
  is; it is just data.
- **Token validation:** signature verified against the tenant's JWKS
  (cached, kid-based lookup), plus issuer, audience, and expiry checks.
  Claims consumed: `oid`, `name`, `preferred_username`, `roles`.
- **Unconfigured auth fails closed:** if the API is not configured with a
  tenant id and audience, every token is rejected as `unauthenticated` —
  there is no "auth disabled" mode.
- **`require_self_or_admin`:** endpoints keyed by a `{person_oid}` path
  parameter (e.g. the voiceprint resource) allow a caller to act only on
  their **own** record — `token.oid == path person_oid` — unless the token
  carries the `StorageApi.Admin` app role, in which case any `person_oid` is
  permitted. Path/dependency parameter names must match exactly; this is
  enforced by FastAPI request validation (a misnamed route parameter fails
  closed as `validation_error`, not open).
- **`require_admin`:** protects voiceprint enumeration, lifecycle mutations,
  and `GET /api/v1/voiceprints/audit-events`.
  It requires the exact `StorageApi.Admin` role regardless of the path.

## 4. Health

Health endpoints are **not authenticated** and are **not** under `/api/v1`.
They use their own minimal response shape — **not** the error envelope from
section 2 — and never include configuration values (storage account URL,
tenant id, etc.) in the body.

| Endpoint | Auth | 200 body | Failure |
|---|---|---|---|
| `GET /health/live` | none | `{"status": "live"}` | — (process-up check only; does not touch storage) |
| `GET /health/ready` | none | `{"status": "ready"}` | `503 {"status": "degraded"}` if a cheap Blob Storage reachability check fails |

## 5. Voiceprint resource — ratified for IN-377

**Status: implemented and live.** These two endpoints shipped under IN-377 on
23 July 2026. Both apply `require_self_or_admin` on `{person_oid}`.

### `GET /api/v1/voiceprints/{person_oid}`

Fetch a person's central voiceprint enrolment record.

- **Auth:** self-or-admin (`person_oid` must equal the caller's `oid`,
  unless the caller holds `StorageApi.Admin`).
- **200** — the stored `CentralEnrolment` record (schema below).
- **404** — no record exists for `person_oid` (`http_error` envelope, since
  a plain "absent" is not a validation or auth failure).
- **403 / 401 / 503** — per the tables above.

### `PUT /api/v1/voiceprints/{person_oid}`

Create or update a person's central voiceprint enrolment record.

- **Auth:** self-or-admin.
- Request body: a `CentralEnrolment`-shaped JSON object (schema below).
- **200** — **always** returns the full stored record as persisted by the
  server, including server-set `created_at` (preserved from the prior
  record on update, set fresh on first create) and `updated_at` (always
  refreshed to "now" on every successful write).
- **The response body is never empty.** This is a hard contract
  requirement: the current IN-379 desktop client
  (`RestStorageApiClient.register_voiceprint` in
  `meeting-notetaker-2/backend/app/services/storage_api.py`) treats an
  empty/falsy response body as success and silently **echoes its own
  request body back** as the "stored" record rather than erroring. If the
  server ever returned an empty 200, the client would never notice its
  write didn't durably round-trip server-assigned fields. The server MUST
  always return the canonical stored JSON object on 200.
- **409 is reserved** for future concurrency control (e.g. an
  `If-Match`/ETag conditional-write scheme) and is not returned by this
  version of `PUT`.
- Malformed/incomplete body → `422 validation_error` (generic message, no
  field detail — see section 2).

### `person_id` / `person_oid` — the IN-377 amendment

**This is the one deliberate, called-out change from the current IN-379
client behaviour:** the path parameter and the `person_id` field inside the
stored record are the caller's **Entra object id (`oid`)** — not an email
address.

The IN-379 client's `CentralEnrolment.person_id` field is currently
documented in its own code as *"email today; Entra object id once IN-471
validates tokens"* (see
`meeting-notetaker-2/backend/app/services/storage_api.py`). This contract
is the trigger for that switch: IN-377's implementation of these endpoints,
and the corresponding desktop-client cutover, key every record by `oid`,
never by email. Email addresses can be reused/changed/reassigned in Entra;
object ids are stable for the lifetime of the identity, and the server
derives identity exclusively from the validated token's `oid` claim (see
section 3) — so keying storage by anything else would be inconsistent with
how the server actually authorizes requests.

### Record schema (`CentralEnrolment`)

Field-for-field, this is the same shape the IN-379 client already defines
(`meeting-notetaker-2/backend/app/services/storage_api.py`), with the
`person_id` amendment above applied:

| Field | Type | Notes |
|---|---|---|
| `person_id` | string | **Entra object id (`oid`)** — amended from email, see above. |
| `email` | string \| null | Normalized sign-in email used only for exact meeting-candidate resolution. Self PUTs stamp it from token `preferred_username`; old records may omit it. |
| `display_name` | string | Human-readable name for the enrolled person. |
| `voiceprints` | array of string | Opaque voiceprint model artifacts/references. Never logged or included in audit `details` (section 6). |
| `sample_sources` | array of `"recorded" \| "uploaded"` | Provenance of the voice samples used to build `voiceprints`. |
| `status` | `"active" \| "disabled" \| "deleted"` | Defaults to `"active"`. |
| `model_version` | string \| null | Which voiceprint model produced this enrolment, if known. |
| `consent_recorded_at` | timestamp | UTC ISO-8601; when consent for central storage was recorded. |
| `created_at` | timestamp | UTC ISO-8601. **Server-set.** Preserved across updates. |
| `updated_at` | timestamp | UTC ISO-8601. **Server-set.** Refreshed on every write. |
| `disabled_at` | timestamp \| null | Server-set when an administrator disables the record; cleared by enable. |
| `deleted_at` | timestamp \| null | Server-set tombstone timestamp when artifacts are deleted. |

### Blob layout

Records are stored one-per-person as:

```
voiceprints/{oid}.json
```

in the `voiceprints` container (`NSA_VOICEPRINTS_CONTAINER`, default
`voiceprints`).

For bounded meeting-candidate lookup, each PUT also maintains a private,
one-way email index:

```
by-email/{sha256(normalized_email)}.json
```

The index document contains only `{"person_id": "<oid>"}`. A lookup never
trusts the index alone: it reads the referenced enrolment and requires an
exact normalized-email match plus `status == "active"`. Missing, malformed,
or stale index entries therefore fail closed. Existing records without an
`email` remain valid for self GET/PUT but cannot be returned by meeting
lookup until they are PUT/re-enrolled again or an approved backfill is run.

Meeting use metadata is stored separately so updating last-used cannot race
with and overwrite a lifecycle mutation:

```
last-used/{oid}.json
```

### Administrator voiceprint management — IN-380/IN-382

All operations in this subsection require the exact `StorageApi.Admin` app
role via `require_admin`; a delegated non-admin receives 403 before storage is
read or written.

- `GET /api/v1/voiceprints` returns
  `{"items": VoiceprintAdminRecord[]}` for every status. Each item includes
  `person_id`, `display_name`, `email`, `status`, `sample_sources`,
  `consent_recorded_at`, lifecycle timestamps, `last_used_at`, and
  `voiceprint_count`. It never includes the opaque `voiceprints` array.
- `POST /api/v1/voiceprints/{person_oid}/disable` sets `status=disabled`,
  stamps `disabled_at`, appends `voiceprint_disabled`, and returns the safe
  admin record plus `audit_event_id`.
- `POST /api/v1/voiceprints/{person_oid}/enable` reactivates only a disabled
  record, clears `disabled_at`, appends `voiceprint_enabled`, and returns the
  safe record plus `audit_event_id`.
- `DELETE /api/v1/voiceprints/{person_oid}` permanently clears the opaque
  voiceprint artifacts, sets `status=deleted` and `deleted_at`, and retains the
  metadata tombstone. It appends `voiceprint_deleted` and returns the safe
  tombstone plus `audit_event_id`.
- Deleted tombstones cannot be enabled or disabled (409 `conflict`). Missing
  targets return 404. Disabled and deleted records remain excluded from
  meeting-candidate results.

Lifecycle data writes and audit appends are separate operations. If the data
write succeeds and the audit append fails, the request returns 503; retrying
disable is safe and creates the required audit event. Existing audit entries
are never mutated or deleted.

### `GET /api/v1/voiceprints/directory` — staff directory (5 Aug 2026)

Minimal-disclosure directory of colleagues holding an **active** central
voiceprint, for the desktop app's attendee suggestions. Available to **any
authenticated principal** (no role required) — the deliberate exception to
the no-non-admin-enumeration stance, bounded to the two fields the picker UI
displays anyway:

```json
{ "items": [ { "email": "amy@factor1.com.au", "display_name": "Amy Active" } ] }
```

- Active records only; records without a usable email are omitted.
- Emails are normalised lowercase; items sorted by `display_name` then
  `email` (casefold).
- NEVER includes oids, lifecycle timestamps, sample sources, counts, or
  voiceprint material — all of that remains behind `StorageApi.Admin`.
- Reads are not audit-logged (matches the admin list).
- Registered before `GET /api/v1/voiceprints/{person_oid}` — the path would
  otherwise be captured as `person_oid="directory"` (same ordering constraint
  as `audit-events`).

### `POST /api/v1/voiceprints/meeting-candidates` — IN-378

Resolve the active central voiceprints for a bounded set of meeting
participants. This is a read-only operation: it cannot create, update,
disable, delete, or enumerate voiceprints beyond the submitted candidates.

- **Auth:** a delegated token carrying the exact `access_as_user` scope, or
  an app-role token carrying `StorageApi.Admin`.
- **Trust model:** `meeting_id`, candidate emails, and sources are supplied by
  the authenticated employee client. This matches manual/ad-hoc flows, where
  participant lists are user-entered. Joseph accepted this bounded
  employee-trust model on 24 Jul 2026. The operation remains exact-request-only,
  read-only, and capped at 50 candidates per call. Stronger server-verifiable
  meeting membership is out of scope unless separately required.
- Request body: one meeting UUID and between 1 and 50 candidate entries.
  Each candidate has an email and a source:
  `invitee`, `organizer`, `recorder`, or `controlled_expansion`.
- Emails are trimmed and case-folded, then de-duplicated while preserving
  the first candidate's order and source.
- **200** — `records` contains only active enrolments that exactly match a
  candidate email; `missing` contains the normalized candidate objects that
  did not resolve, preserving each first-seen source.
- Disabled/deleted records, stale indexes, mismatched records, and missing
  records all collapse to `missing`; the response does not disclose why a
  candidate was absent.
- Every active record returned emits one immutable `voiceprint_used` event.
  Missing, disabled, deleted, stale-index, and malformed candidates emit no
  use event because no voiceprint record was returned. The event contains the
  target person OID plus the submitted `meeting_id` and server UTC date; it
  never contains candidate emails or voiceprint values.
- **401 / 403 / 422 / 503** — per the tables above.

Example request:

```json
{
  "meeting_id": "9ab402de-a57f-45a6-8cde-4f89902f5d0b",
  "candidates": [
    {"email": "invitee@example.com", "source": "invitee"},
    {"email": "recorder@example.com", "source": "recorder"}
  ]
}
```

Example response:

```json
{
  "meeting_id": "9ab402de-a57f-45a6-8cde-4f89902f5d0b",
  "records": [
    {
      "person_id": "8f5203eb-2398-40ce-8567-646ba28e7d27",
      "email": "invitee@example.com",
      "display_name": "Invitee",
      "voiceprints": ["opaque-voiceprint"],
      "sample_sources": ["recorded"],
      "status": "active",
      "model_version": "pyannote-v1",
      "consent_recorded_at": "2026-07-23T04:31:07+00:00",
      "created_at": "2026-07-23T04:31:07+00:00",
      "updated_at": "2026-07-23T04:31:07+00:00"
    }
  ],
  "missing": [
    {"email": "recorder@example.com", "source": "recorder"}
  ]
}
```

## 6. Voiceprint audit

Every mutating operation on server-held data is expected to write an audit
event. Audit events are written **only by this Function, server-side** —
no client can write, edit, or forge an audit entry (a client with only an
upload SAS, for example, has no path to the audit container at all).

Implemented today in `app/services/audit.py`. Each event is one JSON object,
newline-appended (JSONL) to:

```
voiceprints-audit/{yyyy}/{mm}/{dd}.jsonl
```

in the `voiceprints-audit` container (`NSA_AUDIT_CONTAINER`, default
`voiceprints-audit`), one file per UTC day. Append-only: existing lines are
never rewritten or deleted by this API.

Each event has exactly these nine keys:

| Key | Type | Notes |
|---|---|---|
| `schema_version` | integer | Currently `1`. |
| `event_id` | string | Unique id (uuid4 hex) for this event. |
| `occurred_at` | timestamp | UTC ISO-8601, server clock. |
| `actor_oid` | string | The `oid` of the caller who performed the action. |
| `actor_name` | string | The caller's `name` claim, for human readability. |
| `action` | string | Short verb describing what happened (e.g. `voiceprint.update`). |
| `target` | string | What was acted on (e.g. the affected `person_oid`/blob path). |
| `correlation_id` | string | Ties the event back to the originating request/logs. |
| `details` | object | Minimal event-specific context. Sensitive key shapes are rejected recursively before writes and after reads, so token, authorization, SAS, email, embedding, raw-audio, and voiceprint values cannot enter or leave through this API. |

### Event actions

New events use these exact underscore-separated action names:

| Trigger | `action` | `target` | `details` |
|---|---|---|---|
| A PUT creates a record | `voiceprint_created` | Target person OID | `status` |
| A meeting-candidate response returns an active record | `voiceprint_used` | Returned person OID | `meeting_id`, server UTC `date` |
| An existing PUT changes status to `disabled` | `voiceprint_disabled` | Target person OID | `status` |
| An existing PUT changes status to `deleted` | `voiceprint_deleted` | Target person OID | `status` |
| Any other existing-record PUT | `voiceprint_updated` | Target person OID | `status` |
| Admin disable | `voiceprint_disabled` | Target person OID | `status`, `previous_status` |
| Admin enable | `voiceprint_enabled` | Target person OID | `status`, `previous_status` |
| Admin delete | `voiceprint_deleted` | Target person OID | `status`, `previous_status` |
| A section 7 export PUT stores meeting JSON | `meeting_json_written` | Current meeting JSON blob path | `meeting_id`, `schema_version`, `revision` |
| A section 7 audio upload SAS is issued | `meeting_audio_sas_issued` | Audio blob path | `meeting_id` |
| A section 9 `POST /call-watches` creates or replaces a per-meeting watch | `call_watch_created` | `callwatches/{oid}/{join_url_hash}` | `subscription_id`, `join_web_url_hash` |
| A section 9 `DELETE /call-watches/{join_url_hash}` (or the deprecated `DELETE /call-watches/current` alias, once per watch it deletes) removes an existing watch | `call_watch_deleted` | `callwatches/{oid}/{join_url_hash}` | `subscription_id` |
| A section 9 `POST /call-watches` lazily reaps an expired watch it found while checking the 5-watch cap | `call_watch_expired_cleanup` | `callwatches/{oid}/{join_url_hash}` | `subscription_id` |

The validated caller's `oid` and `name` claims are always the event's
`actor_oid` and `actor_name`. This identifies the responsible actor for
disable and delete transitions without accepting actor identity from request
data.

One `voiceprint_used` event is appended per returned record rather than one
event containing a list of participants. This keeps every target unambiguous
and avoids storing an employee email/OID list. Ordinary
`GET /voiceprints/{person_oid}` enrolment-status/self/admin reads remain
unaudited.

Audit writes have at-least-once semantics. If a multi-record meeting lookup
appends some use events and a later append fails, the endpoint returns
`503 storage_unavailable`; retry can produce another event with a different
`event_id`. Existing entries are never rewritten to deduplicate them.
`correlation_id` allows administrators to identify events from the same API
request.

The v1 voiceprint record/index write and audit append use separate Blob
operations and cannot be committed atomically. If the data write succeeds but
the audit append fails, the API returns `503 storage_unavailable`, but the
record may already be stored; a retry can therefore be classified as an
update. A durable transactional outbox would require a wider IN-377 storage
contract change and is not introduced by IN-381.

Historical events written before IN-381 can have dotted action names such as
`voiceprint.create` / `voiceprint.update` and Blob-path targets. They remain
immutable and are returned by the read API when they match the supplied
filters; the API does not rewrite history.

### `GET /api/v1/voiceprints/audit-events`

Return a bounded, newest-first page from the immutable voiceprint audit log.
This is the read-only administrator view required by IN-381; no audit mutation
endpoint exists.

- **Auth:** exact `StorageApi.Admin` app role via `require_admin`. A delegated
  user without that role receives `403` before audit storage is read.
- **`from_date` / `to_date`:** optional UTC dates (`YYYY-MM-DD`). If neither is
  supplied, both default to the current UTC date. If only one is supplied, the
  other defaults to the same date. The inclusive range is limited to 31 days,
  and `from_date` must not be after `to_date`.
- **`action`:** optional exact action filter, maximum 64 characters.
- **`person_oid`:** optional exact `target` filter, maximum 128 characters.
  Historical Blob-path targets do not match an OID-only filter.
- **`meeting_id`:** optional UUID matched exactly against
  `details.meeting_id`.
- **`limit`:** page size from 1 to 100; default 50.
- **`cursor`:** optional opaque continuation value, maximum 512 characters.
  It is bound to the normalized date range and filters. Invalid, mismatched,
  or over-limit cursors return the generic `422 validation_error` envelope.
  Traversal is capped at a 10,000 matching-event offset.
- Audit blobs are scanned newest-first with 64-KiB backward range reads. One
  request can scan at most 32 MiB across its date window. If a selective
  filter cannot produce a page within that budget, the API returns the
  generic `422 validation_error` envelope and the caller must narrow the date
  range or filters.
- **200:** an `items` array plus nullable `next_cursor`.
- **503:** Blob failures, malformed audit JSONL, invalid event schema, or a
  historical event carrying a forbidden sensitive detail key fail closed as
  `storage_unavailable`. Such lines are never silently skipped or returned as
  arbitrary JSON.

Example response:

```json
{
  "items": [
    {
      "schema_version": 1,
      "event_id": "54af9f874477477bb17fd0e0f65d461b",
      "occurred_at": "2026-07-24T01:02:03+00:00",
      "actor_oid": "caller-oid",
      "actor_name": "Administrator",
      "action": "voiceprint_used",
      "target": "person-oid",
      "correlation_id": "request-correlation-id",
      "details": {
        "meeting_id": "9ab402de-a57f-45a6-8cde-4f89902f5d0b",
        "date": "2026-07-24"
      }
    }
  ],
  "next_cursor": null
}
```

## 7. Meeting JSON/audio delivery — ratified for IN-386

**Status: ratified and implemented** under IN-386 on its feature branch; not
yet deployed. These two endpoints deliver the finished meeting record: the
meeting JSON export goes through the API, the audio recording goes directly
to Blob Storage under a short-lived SAS issued by the API.

Rules shared by both endpoints:

- **Auth:** a delegated token carrying the exact `access_as_user` scope, or
  an app-role token carrying `StorageApi.Admin`. A valid token with neither
  → `403 forbidden`; no valid token → `401 unauthenticated`.
- **Trust model:** `meeting_id` and `time_basis_utc` are assertions by the
  authenticated employee caller — the server does not verify them against a
  calendar or recording system. This is the same bounded employee-trust
  model as the section 5 meeting-candidates operation; Joseph accepted it on
  24 Jul 2026. The operations are write-only into the private `notetaker`
  container (`NSA_NOTETAKER_CONTAINER`, default `notetaker`) — nothing here
  can read, list, or enumerate meeting data.
- **`meeting_id`** is a typed UUID path parameter. A non-UUID value is
  rejected as `422 validation_error` before any storage access.
- **`time_basis_utc`** (required in both request bodies): an ISO-8601
  timestamp **with an explicit offset**, normalised server-side to UTC.
  Semantically it is the meeting's `scheduled_start`, or the recording start
  for ad-hoc meetings with no schedule. Naive timestamps (no offset) →
  `422 validation_error`. The `{yyyy}/{mm}` blob prefix below is derived
  server-side from this value **in UTC** — a `+10:00` timestamp near local
  midnight files under the UTC month, not the local one.
- Unknown request-body fields are ignored (v1 additive tolerance, section 8).

### `PUT /api/v1/meetings/{meeting_id}/export`

Store the meeting's export document (transcript/summary/metadata) as the
meeting's current JSON record.

- **Auth / trust:** per the shared rules above.
- Request envelope — exactly two documented fields:
  - `time_basis_utc` — required, per the shared rules above.
  - `export` — required object: the schema-1.0 `MeetingExport` document.
- **Server-side validation is deliberately shallow** (thin-gateway stance —
  deep validation of the export is owned by the desktop's IN-384
  `MeetingExport` builder, and the server must not fork that contract):
  - `export.schema_version` must be the string `"1.0"` →
    `422 validation_error` otherwise.
  - `export.meeting_id` must equal the path `meeting_id`, compared
    case-insensitively → `422 validation_error` otherwise.
  - The serialized **export document** (the `export` object, not the whole
    envelope) is capped at 50 MiB → `413 payload_too_large` beyond that.
  - Everything else inside `export` is opaque to the server.
- **200** — **always** returns a receipt; the response body is never empty
  (same hard rule as the section 5 voiceprint PUT):
  `meeting_id`, `blob_path` (the current JSON blob), `revision`
  (`"created"` on first write, `"updated"` on re-upload), and `updated_at`
  (server clock, UTC).
- **401 / 403 / 413 / 422 / 503** — per the tables above.

Example response:

```json
{
  "meeting_id": "9ab402de-a57f-45a6-8cde-4f89902f5d0b",
  "blob_path": "meetings/2026/07/9ab402de-a57f-45a6-8cde-4f89902f5d0b/meeting.json",
  "revision": "created",
  "updated_at": "2026-07-24T04:31:07.123456Z"
}
```

#### Blob layout and write-once/history semantics

The current record and its history live in the `notetaker` container as:

```
meetings/{yyyy}/{mm}/{meeting_id}/meeting.json                    (current)
meetings/{yyyy}/{mm}/{meeting_id}/history/{server-utc-ts}.json    (history)
```

`{server-utc-ts}` is the server clock formatted `YYYYMMDDTHHMMSSffffffZ` —
filename-safe and lexically sortable, so history snapshots list in
chronological order.

The first write for a meeting is a **conditional create** (`revision:
"created"`). A re-upload first snapshots the prior current record to
`history/`, then overwrites the current blob (`revision: "updated"`). The
snapshot and the overwrite are separate Blob operations and cannot be
committed atomically — same stance as the section 6 record-write/audit-append
disclosure: a failure between the two can leave a history snapshot without
the matching overwrite, and a retry can add a redundant identical snapshot.
Last-writer-wins between concurrent re-uploads of the same meeting is
accepted for v1; no meeting JSON content is ever deleted by this API.
Because the `{yyyy}/{mm}` prefix is derived from `time_basis_utc`, the
storage identity of a meeting is effectively UTC-month + `meeting_id`, not
`meeting_id` alone: a re-upload that asserts a different `time_basis_utc`
files under a different `{yyyy}/{mm}` prefix and therefore creates an
independent current record for the same `meeting_id`, rather than updating
the original one. Clients must keep `time_basis_utc` stable across
re-uploads of the same meeting.

### `POST /api/v1/meetings/{meeting_id}/audio/upload-sas`

Issue a short-lived upload URL for the meeting's audio recording.

- **Auth / trust:** per the shared rules above.
- Request body: `{"time_basis_utc": ...}` — same rules as above.
- **200** — grants a **create+write-only** user-delegation SAS (never an
  account key), with a TTL of `sas_ttl_minutes` (`NSA_SAS_TTL_MINUTES`,
  default 10 minutes), scoped to exactly one blob in the `notetaker`
  container:

  ```
  meetings-audio/{yyyy}/{mm}/{meeting_id}/audio.webm
  ```

  The content contract is fixed: `audio/webm`, at the fixed name
  `audio.webm`. **`.webm` is a recorded deviation from David's brief**, which
  assumed `.m4a` at §7; `.webm` is what the desktop app actually records —
  decision Joseph, 24 Jul 2026. Transcoding to another container format
  remains a possible additive change later and is not part of this contract.
  Re-requesting a SAS for the same meeting is allowed (retry after expiry or
  failure); an overwrite via a fresh SAS is idempotent by construction, since
  the recording is immutable content.
- **401 / 403 / 422 / 503** — per the tables above.

Example response:

```json
{
  "upload_url": "https://<account>.blob.core.windows.net/notetaker/meetings-audio/2026/07/9ab402de-a57f-45a6-8cde-4f89902f5d0b/audio.webm?<sas-token>",
  "blob_path": "meetings-audio/2026/07/9ab402de-a57f-45a6-8cde-4f89902f5d0b/audio.webm",
  "expires_at": "2026-07-24T04:41:07Z"
}
```

**Note on `expires_at`:** it is advisory/approximate. It is computed
independently of the SAS signature's own expiry and is always at-or-after
it (it may trail the signature expiry by up to about a second on a cold
delegation-key fetch); the SAS token itself is authoritative. Clients must
not time retry logic to the last moment of `expires_at`.

#### Audio layout note (recorded deviation)

Audio deliberately lives under the `meetings-audio/` sibling prefix, **not**
the meeting's JSON directory. Azure lifecycle-management filters are
prefixMatch-only and blob index tags are unsupported on HNS accounts, so the
retention split below is only implementable with a dedicated audio prefix.
This is a recorded deviation from the earlier sketch/brief single-directory
layout.

#### Retention

Audio is tiered to Cool at 30 days and deleted at 365 days via a storage
lifecycle policy on the `meetings-audio/` prefix. Meeting JSON and its
history are kept forever.

#### Accepted v1 gap — no upload-completion confirmation

There is no upload-completion confirmation call, and therefore no
"audio uploaded" audit event. SAS issuance is the audited fact, and the
blob's existence is the evidence of completion.

### Audit

Both operations append section 6 audit events (`meeting_json_written` on
every successful export write; `meeting_audio_sas_issued` on every SAS
grant) — see the section 6 event-actions table for the exact `target` and
`details` shapes. The SAS URL never appears in audit events or logs; it is
returned in the response body only.

## 8. Versioning

- v1 (`/api/v1`) is **additive-only**: new endpoints, new optional request
  fields, new response fields, and new error `code` values may be added to
  this document without notice to existing clients, as long as existing
  fields/behaviour are unchanged.
- Any breaking change (removed/renamed field, changed status-code meaning,
  narrowed acceptance) requires a new `/api/v2` base path. v1 and v2 may run
  concurrently during a migration window.

## 9. Call watches — meeting call events

**Status: implemented.** The base feature (create/replace, read signals,
delete, plus the unauthenticated Graph webhook) per the 12 Aug 2026
meeting-call-events design
(`meeting-notetaker-2/docs/superpowers/specs/2026-08-12-meeting-call-events-design.md`,
decisions D1–D9) is merged to `main`, dark. The per-meeting redesign
described in this section — per-meeting create/replace with a 5-watch cap,
the `{join_url_hash}`-scoped signals/delete routes, and the deprecated
`current/*` legacy aliases — is per the 14 Aug 2026 call-watch-per-meeting
design
(`meeting-notetaker-2/docs/superpowers/specs/2026-08-14-call-watch-per-meeting-design.md`,
decisions E1–E6), implemented on the `feature/call-watch-per-meeting` branch,
not yet merged. Neither has been deployed. This section is appended after
section 8 rather than inserted earlier so that existing `contract §8`
references elsewhere in this repo (e.g. `app/models.py`'s
additive-only-posture docstrings) keep pointing at Versioning. Ships dark:
every authenticated route below 503s until an administrator sets
`NSA_CALL_WATCHES_ENABLED=true` and a valid `NSA_GRAPH_NOTIFICATION_URL` —
see `docs/runbook.md`'s "Call watches" section for configuration,
certificate generation, and triage.

**Recorded deviation from the base D1–D9 design (E2/E3/E6, 14 Aug 2026):**
the base design gave each caller exactly one watch at a time, keyed only by
`oid`, with `GET .../current/signals` and `DELETE .../current` as its only
read/delete routes. Live use (the desktop auto-recording unlimited
back-to-back meetings) needed a watch per meeting, not per user, so the store
is now keyed by `(oid, join_url_hash)` and those two routes are reinterpreted
as legacy aliases (9.5) rather than removed outright. This is the one
documented breaking-shape change in this section: a hypothetical caller that
depended on `current/*` meaning "my one watch" now gets union/delete-all
semantics instead — harmless for the only fleet that has ever called these
routes (pre-v2.1.0, one watch at a time, see 9.5), but a genuine behavioural
change from the D1–D9 shape, not a pure addition. Because the base shape was
never deployed to a live client before this redesign landed, it ships as a
contract revision within this section rather than a new `/api/v2` base path
(section 8) — the additive-only posture applies to *deployed* v1 behaviour,
and none of the D1–D9 shape reached that state.

### 9.1 What this is

While a desktop client is auto-recording a Teams meeting it organizes, it can
ask this API to watch that meeting's Microsoft Graph `meetingCallEvents`
change-notification feed on its behalf, then poll back a small, per-meeting
reduction of what Graph delivers: at most three signal types —
`recorder_left`, `recorder_rejoined`, `call_ended` — scoped to the recording
user's own OID and to one specific meeting. The desktop never receives raw
Graph payloads, other participants' identities, roster contents, or the
meeting join URL back from this API. A caller may hold **up to five**
concurrent watches, one per meeting, each identified by the sha256 hex digest
of that meeting's `joinWebUrl` — computed server-side from the raw URL
supplied to `POST` (9.2), and computed independently client-side to address
the `GET`/`DELETE` routes in 9.3/9.4, since those carry no request body for
the server to hash; the raw URL itself never leaves the `POST` request body
— see 9.8. The routes in 9.2–9.4 (all
authenticated) are the current desktop-facing surface; 9.5 lists two
deprecated legacy aliases kept for a fleet still transitioning off the
one-watch-per-user shape; `POST /graph/call-notifications` (9.7) is the
unauthenticated half Microsoft Graph itself calls into.

`NSA_CALL_WATCHES_ENABLED` and a configured `NSA_GRAPH_NOTIFICATION_URL` gate
every authenticated route in this section (9.2–9.5) — the webhook always
answers `202` regardless of the flag (see 9.7's "always 202" note).

### 9.2 `POST /api/v1/call-watches`

Create a watch for one meeting, or replace the caller's existing watch for
that same meeting.

- **Auth:** `require_scoped_user` — a delegated token carrying the exact
  `access_as_user` scope, or an app-role token carrying `StorageApi.Admin`.
- Request body:

  ```json
  {
    "join_web_url": "https://teams.microsoft.com/l/meetup-join/...",
    "scheduled_end_utc": "2026-08-12T11:00:00Z"
  }
  ```

  - `join_web_url` — required, must start with `https://`. Used to build the
    Graph subscription resource and to compute a sha256 hex digest,
    `join_web_url_hash` — the key this section's routes and storage layout
    use to identify the watch (see 9.8); the raw value is never stored,
    logged, or returned. Empty or non-`https://` → `422 validation_error`.
  - `scheduled_end_utc` — required, non-blank string, and must parse as an
    ISO-8601 timestamp (the model applies the same trailing-`Z` normalisation
    `graph_subscriptions._expiration_iso` does before parsing). An empty or
    unparseable value → `422 validation_error`, matching section 7's
    `time_basis_utc` precedent — malformed *input* is a 422 regardless of
    which route it's on. `502 graph_error` is reserved for Graph itself
    rejecting or failing the subscription-create call once a well-formed
    `scheduled_end_utc` has already been accepted.
  - Unknown fields are ignored (v1 additive tolerance).
- **200** —

  ```json
  {
    "watch_id": "8f5203eb-2398-40ce-8567-646ba28e7d27",
    "subscription_expires_utc": "2026-08-12T23:00:00.0000000Z"
  }
  ```

  `watch_id` is always the caller's own `oid`, taken from the validated
  token — the request body has no field that could pick a different watch to
  write. Unlike the pre-per-meeting shape, `watch_id` no longer identifies
  "the" watch by itself: it is the same value on every `POST` a caller makes,
  regardless of which meeting; `join_web_url_hash` (computed server-side from
  the request body, never client-supplied) is what actually selects which
  meeting's watch is created or replaced, and it is also the path segment the
  9.3/9.4 routes key off. `subscription_expires_utc` is Graph's own
  `expirationDateTime` for the created subscription, always formatted with a
  literal `.0000000Z` suffix (seven zero digits, not real sub-second
  precision) — that is the exact string this API asks Graph to accept, and it
  is reused verbatim in the response. It equals
  `min(scheduled_end_utc + 12h, now + 70h)` — see `docs/runbook.md`.
- **Per-meeting replace semantics:** a `POST` for a `join_web_url` that
  hashes to a meeting the caller already has a watch for replaces that
  meeting's watch outright and leaves every other meeting's watch for the
  same `oid` untouched — there is still exactly one live watch per
  `(oid, join_url_hash)` pair, just no longer exactly one per `oid`. The
  prior Graph subscription for that meeting is deleted best-effort (a
  Graph-side failure here — e.g. it already expired — is swallowed and never
  fails the request). Every signal is generation-stamped with the
  `subscription_id` of the watch it was delivered under; `GET .../signals`
  (9.3) only ever serves signals stamped with that meeting's **current**
  watch's `subscription_id`. A replacing `POST` therefore makes every
  prior-generation signal for that meeting invisible immediately, even if a
  late Graph notification for the old subscription is still in flight when
  the new watch is created and gets appended after the fact.
- **5-watch-per-user cap (spec E3):** a caller may hold at most **5**
  concurrent watches across all their meetings. A `POST` for a *new* meeting
  (one the caller has no live watch for) once already at the cap returns
  `409 watch_limit` — checked, and Graph never touched, before any
  subscription is created, so a refused create never leaves an orphaned
  Graph subscription. **Replacing an existing meeting's own watch is exempt
  from the cap** (see "Per-meeting replace semantics" above) — it does not
  grow the caller's watch count, so it is never blocked even exactly at the
  cap. Expired watches — any watch whose stored `subscription_expires_utc` is
  at or before the current time — are excluded from the cap count and are
  lazily deleted (Graph subscription deleted best-effort, blobs removed, one
  `call_watch_expired_cleanup` audit event per watch removed — see 9.9) the
  moment a `POST` checks the cap, before the new-or-replacing watch is
  created. This exists because spec D3 has no watch renewal or background
  expiry sweep (`docs/runbook.md`): without it, a caller whose machine lost
  state and left 5 dead watches behind would be permanently locked out of
  creating a new one. A watch with a missing, non-string, or unparseable
  `subscription_expires_utc` is treated as **not** expired — it still counts
  toward the cap and is never reaped — so malformed data fails toward
  blocking a create, never toward silently discarding a watch record. The
  cap check itself is advisory, not a lock: two concurrent `POST`s from the
  same caller can both read the same pre-check count and both pass,
  breaching the cap by one; this is accepted as benign (one desktop per
  user) rather than serialising every create.
- **Errors:**
  - `422 validation_error` — empty/non-`https://` `join_web_url`, or an
    empty/unparseable `scheduled_end_utc` (see above).
  - `409 watch_limit` — the cap in the bullet above, for a new meeting only.
  - `503 feature_disabled` — see the error code table (section 2).
  - `502 graph_error` — see the error code table (section 2).
  - `401` / `403` — standard (section 3).
  - `503 storage_unavailable` — a Blob Storage failure while reading/writing
    the watch record (the standard `StorageUnavailable` → 503 mapping,
    section 2).

### 9.3 `GET /api/v1/call-watches/{join_url_hash}/signals`

Return every signal recorded for one meeting's current watch generation.

- **Auth:** `require_scoped_user`.
- **`join_url_hash`** — a path segment, not a query parameter: the sha256 hex
  digest of that meeting's `joinWebUrl`, computed by the client exactly as
  `POST /call-watches` (9.2) computes it server-side. Must be **64 lowercase
  hex characters**; anything else (wrong length, uppercase, non-hex
  characters, the literal string `current`, ...) → `422 validation_error`,
  before storage is touched. (`current` specifically never reaches this
  validation — see 9.5's routing note.)
- **200** —

  ```json
  {
    "signals": [
      {
        "seq": "20260812T023004123456-a1b2c3d4",
        "type": "recorder_left",
        "event_utc": "2026-08-12T02:30:04Z",
        "received_utc": "2026-08-12T02:30:05.987654+00:00"
      }
    ]
  }
  ```

  - `type` — `Literal["recorder_left", "recorder_rejoined", "call_ended"]`.
  - `event_utc` — the timestamp Graph attached to the event; nullable
    (Graph's own `eventDateTime` field is optional).
  - `received_utc` — this API's own receipt clock; always present.
  - `seq` — opaque and chronologically sortable; the desktop dedupes on it.
    A retried delivery within the same webhook request collides on the same
    `seq` (the notification-id suffix); a redelivery in a later request gets
    a fresh receipt-time prefix and so a new `seq` — the desktop's seen-set
    plus the state machine's terminal states make that duplicate harmless. **There is no pagination or
    cursor** — every signal for this meeting's current watch generation is
    returned on every call (bounded to a handful per meeting by the replace
    semantics in 9.2); the desktop is expected to track which `seq` values it
    has already acted on itself.
  - No watch for that hash under the caller's own `oid` — whether because
    none was ever created, it was deleted, or it belongs to a **different**
    caller (identity comes from the token, never the path; a hash you don't
    own resolves to "no watch," never someone else's data) — or a watch with
    no signals yet, all return `{"signals": []}`, not an error.
- **Errors:** `422 validation_error` (malformed hash, above),
  `503 feature_disabled`, `401` / `403`, `503 storage_unavailable` — same
  meanings as 9.2.

### 9.4 `DELETE /api/v1/call-watches/{join_url_hash}`

Delete one meeting's watch, if the caller has one.

- **Auth:** `require_scoped_user`.
- **`join_url_hash`** — same validation as 9.3: 64 lowercase hex characters
  or `422 validation_error`.
- **204** — always, whether or not a watch existed for that hash under the
  caller's own `oid`. **Idempotent:** deleting an already-deleted, or
  never-existing, meeting's watch is still a plain `204`, not a `404`. If a
  watch did exist, its Graph subscription is deleted best-effort (failures
  swallowed, same as the replace path in 9.2) and its watch/signal blobs are
  removed; every other meeting's watch for the same `oid` is untouched.
- **Errors:** `422 validation_error` (malformed hash), `503 feature_disabled`,
  `401` / `403`, `503 storage_unavailable`.

### 9.5 Deprecated legacy aliases

**These two routes are deprecated.** They exist only for the pre-per-meeting
(v2.0.25 and earlier) desktop fleet, which predates this section's per-meeting
shape and only ever creates/holds **one** watch at a time. Both are declared
in the router before the `{join_url_hash}` routes above, so the literal path
segment `current` is always matched here first and never reaches 9.3/9.4's
hash validation as a (malformed) `join_url_hash`.

**Removal criterion:** once the fleet is confirmed at desktop version
**≥ v2.1.0** (the first per-meeting-aware release) or later, these two routes
may be removed from this contract in a subsequent revision. Until then they
remain live and behave as documented below — not as a single-watch alias,
but with real multi-watch semantics that happen to degrade correctly for a
client that never has more than one watch open.

#### `GET /api/v1/call-watches/current/signals` (deprecated)

Returns the **union** of every one of the caller's current watches' signals
— each watch's own signals are still generation-filtered exactly as 9.3
filters them, this route just does not scope to one meeting — sorted by
`seq` across all of them. A caller with no watches gets `{"signals": []}`.
Correct (equivalent to 9.3 scoped to that one meeting) for a v2.0.25 client,
which never holds more than one watch; for a caller with multiple concurrent
watches, this route mixes signals from every one of them into a single list
with no way to tell which meeting a given signal belongs to — exactly why
9.3 exists. Deliberately does **not** reap expired watches the way 9.2's
cap check does; reaping only ever happens at create time, so an expired
watch's still-current-generation signals are intentionally still served here
until something else deletes it (a `call_ended` fired moments before a
subscription's own expiry must still reach an old client still polling this
alias). Same auth, and the same `503 feature_disabled` /
`503 storage_unavailable` / `401` / `403` errors, as 9.3.

#### `DELETE /api/v1/call-watches/current` (deprecated)

Deletes **all** of the caller's current watches — per-meeting delete (as
9.4) plus best-effort Graph subscription delete plus one audit event, applied
once per watch the caller had. A caller with no watches is a no-op `204`
with no audit event, the same idempotent shape as 9.4. Correct
(equivalent to 9.4 for that one meeting) for a v2.0.25 client, which never
holds more than one watch; for a caller with multiple concurrent watches,
this route deletes every meeting's watch, not just one — the behavioural
change called out at the top of this section. Same auth and error shapes as
9.4.

### 9.6 Storage layout

```
callwatches/{oid}/{join_url_hash}/watch.json
callwatches/{oid}/{join_url_hash}/signals/{seq}.json
```

in the `notetaker` container (`NSA_NOTETAKER_CONTAINER`) — one `watch.json`
and one `signals/` prefix per `(oid, join_url_hash)` pair, so a caller's
watches for different meetings never share a blob. Signal blobs are written
one-per-blob with a conditional create (never appended to a shared document),
so a redelivered Graph notification racing across two Function instances
cannot duplicate a signal or corrupt a shared document. A replacing `POST`
(9.2) deletes the meeting's prior signal blobs as tidy-up; this is not what
makes reads race-safe (the `subscription_id` generation stamp in 9.2 is), it
just keeps orphaned blobs from accumulating.

### 9.7 `POST /graph/call-notifications` — the Graph webhook

The receiving half of this feature. Microsoft Graph, not the desktop, calls
this route.

- **Path:** `/graph/call-notifications` — **no `/api/v1` prefix**, and not
  under `/health` either; it is its own top-level path.
- **Auth: deliberately unauthenticated** (spec D4). This is the *only* route
  in the entire API mounted without the `require_user` dependency — pinned
  exactly by `tests/test_auth_dependencies.py`'s
  `test_unguarded_routes_are_exactly_health_and_the_graph_webhook`, which
  fails if this set ever grows without a matching spec decision. Microsoft
  Graph cannot present a delegated Entra user token for a webhook call, so
  this route authenticates Graph's own way instead:
  1. **Handshake:** a `?validationToken=...` query parameter (present only
     at subscription-creation time) is echoed back verbatim as
     `200 text/plain`, before any settings are read at all.
  2. **`clientState` equality:** every notification item's `clientState`
     field must constant-time-equal `NSA_GRAPH_CLIENT_STATE`. An unset
     `NSA_GRAPH_CLIENT_STATE` fails closed — an item carrying an empty
     `clientState` never matches an empty setting.
  3. **`validationTokens` JWT validation:** every JWT in the body-level
     `validationTokens` list (Microsoft's guidance: validate *all* of them,
     not just one) must independently validate: correct signature (via the
     same tenant JWKS machinery used for ordinary user tokens), audience =
     `NSA_GRAPH_CLIENT_ID`, issuer = Entra's v1 or v2 form for
     `NSA_TENANT_ID`, and `azp` (or `appid` on v1 tokens, only consulted when
     `azp` is entirely absent) = the fixed Microsoft Graph change-tracking
     service principal `0bf30f3b-4a52-48df-9a82-234910c4a086`.
- **1 MB body cap:** the only unauthenticated body-reading route in the API,
  so it bounds what an anonymous caller can make it buffer. When
  `Content-Length` is present and parses to `0`–`1,000,000` bytes, that
  declared value is trusted and the body is read normally; a declared value
  outside that range is rejected on the header alone, without the body ever
  being read. When `Content-Length` is **absent or unparseable**, the body
  is read anyway and the cap is enforced on its actual length instead — the
  Azure Functions ASGI adapter this route runs behind has no proven record
  of always surfacing `Content-Length`, and failing closed on its absence
  would risk silently dropping every real Graph notification if it doesn't.
- **Always `202`** — never a `4xx`/`5xx` for any rejection (the handshake's
  `200` is the only other status this route returns). Every validation
  failure, malformed item, decrypt failure, unknown subscription, or even an
  unexpected exception while processing an item (including a Blob Storage
  outage) is dropped and logged, but still acknowledged with `202`. This is
  deliberate: Graph disables a subscription after enough failure responses,
  and a disabled subscription costs the feature entirely, whereas a dropped
  signal costs at most one late auto-stop (the desktop's existing scheduled
  auto-stop remains the fallback). For the same reason,
  `NSA_CALL_WATCHES_ENABLED` does **not** gate this route — the webhook keeps
  acking (and storing valid signals) while every authenticated route in this
  section (9.2–9.5) is 503ing.
- **Processing:** a valid item's `encryptedContent` is decrypted with
  `NSA_GRAPH_ENC_KEY_PEM` (RSA-OAEP-SHA1 key unwrap, HMAC-SHA256 signature
  check, AES-256-CBC), its `subscriptionId` is resolved to a current watch,
  and the decrypted payload is reduced to at most one signal for that
  watch's owner before being appended.
- **Logging:** only ever a short static drop-reason string plus a count —
  never payload contents, decrypted data, join URLs, subscription resource
  strings, `validationTokens`, display names, or exception messages (class
  names only, e.g. `unexpected_error:StorageUnavailable`). See
  `docs/runbook.md`'s "Call watches" section for the full drop-reason
  vocabulary and triage guidance.

### 9.8 Privacy: join URLs are never stored, logged, or returned raw

The raw `join_web_url` from the `POST /call-watches` request body (9.2)
exists for exactly two purposes: building the Graph subscription resource
string, and computing a sha256 hex digest, `join_web_url_hash`. Only that
hash — 64 lowercase hex characters — crosses into the watch record, the
audit event, any log line, or an HTTP path segment (the `join_url_hash` the
9.3/9.4 routes take): including on the `502 graph_error` path, where Graph's
own error text (which can echo the URL-encoded join URL back) is
deliberately excluded from both the HTTP response and the server-side log
line; only Graph's HTTP status code is logged there. The client computes the
same hash independently when calling 9.3/9.4 — this API never returns a
`join_web_url_hash` for the client to reuse, so it must derive it the same
way (sha256 hex digest of the raw `joinWebUrl`) itself.

### 9.9 Audit

| Trigger | `action` | `target` | `details` |
|---|---|---|---|
| `POST /call-watches` (9.2) creates or replaces a meeting's watch | `call_watch_created` | `callwatches/{oid}/{join_url_hash}` | `subscription_id`, `join_web_url_hash` |
| `DELETE /call-watches/{join_url_hash}` (9.4) removes a watch that existed | `call_watch_deleted` | `callwatches/{oid}/{join_url_hash}` | `subscription_id` |
| The deprecated `DELETE /call-watches/current` alias (9.5) removes a watch that existed — one event per watch deleted | `call_watch_deleted` | `callwatches/{oid}/{join_url_hash}` | `subscription_id` |
| `POST /call-watches` (9.2) lazily reaps an expired watch found while checking the 5-watch cap | `call_watch_expired_cleanup` | `callwatches/{oid}/{join_url_hash}` | `subscription_id` |

`{join_url_hash}` in `target` is always the hash of the specific meeting
acted on — never the caller's `oid` alone — even for events raised from the
deprecated `current` aliases, since every underlying store operation is
still per-meeting. A refused `POST` writes no audit event *for the refused
create itself* -- but note a `409`/`502` POST may still have written
`call_watch_expired_cleanup` events first, because the expired-watch reap
(9.2) runs before the cap check and before Graph is called; only `422`
(rejected before the handler) and `503` (flag check precedes the reap)
guarantee zero audit writes. `GET .../signals` reads — both 9.3 and the
deprecated 9.5 alias — are never audited (matches the read-only stance
elsewhere in this contract). The webhook (9.7) never writes audit events —
Graph is not an authenticated actor.
