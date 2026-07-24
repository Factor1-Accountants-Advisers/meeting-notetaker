# Notetaker Storage API — REST Contract v1.0

Status: **Published** (IN-471). Foundation (auth, health, error contract) is
implemented and live. The voiceprint GET/PUT resource described in section 5
was implemented under IN-377 and verified live on 23 July 2026. The IN-378
meeting-candidate operation was deployed and verified live on 24 July 2026.
The additive IN-381 event taxonomy and administrator audit-read operation are
implemented on their feature branch and are not deployed. Sections marked
"reserved" describe future work only.

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
| `validation_error` | 422 | The request body failed schema validation. | No (fix the request). |
| `http_error` | 404 / 405 / other | Generic HTTP-level failures that aren't one of the above — e.g. unmatched route (404), disallowed method (405). The `message` field carries the underlying HTTP reason where available. | Depends on status. |
| `internal_error` | 500 | Any unhandled exception. Sanitized — no stack trace, no internal detail. The full exception is recorded server-side in Application Insights only, keyed by `correlation_id`. | Situational — safe to retry once. |

Notes:

- **422 carries no field-level detail today.** The `message` is a generic
  "request validation failed" string with no per-field breakdown, by
  deliberate leak-safe default. A sanitized field-list may be **added**
  later (e.g. `error.details.fields`) — that would be an additive change,
  compatible with v1 clients that ignore unknown fields.
- **409 is reserved, not produced.** No v1.0 operation returns 409. It is
  reserved for future optimistic-concurrency control (e.g. conditional
  writes on the voiceprint resource) and will be documented here before any
  endpoint starts returning it.
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
- **`require_admin`:** protects
  `GET /api/v1/voiceprints/audit-events` and any future admin-only operation.
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
| An existing PUT changes status to `disabled` | `voiceprint_disabled` | Target person OID | `previous_status`, `status` |
| An existing PUT changes status to `deleted` | `voiceprint_deleted` | Target person OID | `previous_status`, `status` |
| Any other existing-record PUT | `voiceprint_updated` | Target person OID | `previous_status`, `status` |

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

## 7. Reserved for IN-386 — meeting JSON/audio (sketch, not implemented)

Not implemented anywhere in this repo yet; documented here as the agreed
future shape so nothing downstream has to guess.

- Path: `notetaker/meetings/{yyyy}/{mm}/{meeting_id}/` in the `notetaker`
  container (`NSA_NOTETAKER_CONTAINER`, default `notetaker`). The
  `{yyyy}/{mm}` prefix is derived from the meeting's `scheduled_start`,
  **in UTC**.
- Retention: audio blobs are deleted after 12 months; the meeting JSON
  (transcript/summary/metadata) is kept forever.
- No endpoints, request/response shapes, or auth rules are ratified yet —
  IN-386 will extend this document when they are.

## 8. Versioning

- v1 (`/api/v1`) is **additive-only**: new endpoints, new optional request
  fields, new response fields, and new error `code` values may be added to
  this document without notice to existing clients, as long as existing
  fields/behaviour are unchanged.
- Any breaking change (removed/renamed field, changed status-code meaning,
  narrowed acceptance) requires a new `/api/v2` base path. v1 and v2 may run
  concurrently during a migration window.
