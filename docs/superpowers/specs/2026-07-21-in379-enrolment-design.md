# IN-379 — Self-service voiceprint enrolment against the central store

**Status:** Approved design, pre-implementation
**Date:** 2026-07-21
**Sources:** Jira IN-379 (parent IN-375), David Ahlhaus's storage integration brief v0.2 (20 Jul 2026), Slice 1 enrolment implementation (IN-76/IN-71)

## Problem

Slice 1 enrolment writes provider voiceprints to a per-install local registry
(`var/voiceprints.json`). Slice 2 centralises voiceprints in Azure Blob behind
the authenticated Storage API (IN-471) so any user's Notetaker can retrieve
them. IN-379 re-points self-service enrolment at the central store, records
consent, adds a clip-upload path, and enforces the cutover rule: a local-only
voiceprint must not satisfy the Slice 2 enrolment gate.

## Decisions already made (do not relitigate)

- **Config-flagged cutover** (Joseph, 21 Jul): the gate accepts Slice 1 local
  enrolment until `MN_STORAGE_API_URL` is configured; once set, only central
  enrolment satisfies it and every user re-enrols. No interim lockout.
- **Capture stays 3 guided clips** (5–20 s each) — the live-validated
  precision setup — with a new per-slot "upload a clip" alternative. The
  ticket's "20–30 second sample" reads as a duration target; flagged to David
  in the D3 data contract.
- **Consent timestamp is server-stamped.** The client sends
  `consent_confirmed: true`; the backend stamps `consent_recorded_at`
  in UTC. Clients cannot supply arbitrary consent times.
- Architecture approach A: backend-proxied registration through a provider
  interface (renderer → preload → main → FastAPI → StorageApiClient),
  matching every existing provider seam in the repo.

## Components

### `backend/app/services/storage_api.py` (new)

- `CentralEnrolment` model: `person_id` (email now; the real API derives the
  Entra object ID from the validated token per IN-471), `display_name`,
  `voiceprints` (3 provider references), `sample_sources`
  (`recorded`/`uploaded` per clip), `status` (`active`), `model_version`,
  `consent_recorded_at`, `created_at`, `updated_at` — the IN-377/D3 field set.
- `StorageApiClient` protocol: `register_voiceprint(enrolment, access_token)`
  (upsert) and `get_enrolment(person_id, access_token)`.
- `RestStorageApiClient`: raw `urllib` against `MN_STORAGE_API_URL`; endpoint
  paths provisional until the IN-471 REST contract is published (this client
  is that contract's first consumer). Sends the delegated token as a Bearer
  header; never logs tokens or voiceprint values.
- `StubStorageApiClient`: activates when `MN_STORAGE_API_URL` is empty.
  File-backed at `var/central-voiceprints.json` (mirrors
  `JsonVoiceprintRepository`) so dev and tests exercise the full flow.
  Supports failure injection. Never migrates or reads Slice 1
  `voiceprints.json`.
- `central_enrolment_required() -> bool` = `bool(settings.storage_api_url)`.

### Config (`backend/app/config.py`)

`MN_STORAGE_API_URL`, `MN_STORAGE_API_SCOPE` — empty defaults (stub mode).
`MN_STORAGE_API_SCOPE` is consumed by the Electron main process (MSAL
acquisition in `api-proxy.ts`), which reads env through its own public-env
path — both processes must see the same `MN_*` variables per the existing
pattern; do not wire it backend-only.

**Known packaged-env gap (found 21 Jul, Task 5):** in packaged installs,
`backend-supervisor.ts` merges `backend.env` into the *backend subprocess*
env only; the main process reads `.env.production` via `loadPublicEnv()`
instead. At cutover, ops must place `MN_STORAGE_API_SCOPE` where the main
process reads it (and `MN_STORAGE_API_URL` where the backend reads it) —
add both to the provisioning checklist under IN-376/IN-471.
`backend.env.template` does not yet mention either variable.

### Schemas (`backend/app/schemas.py`)

- `EnrollRequest` + `consent_confirmed: bool` and per-clip
  `sample_sources: list["recorded" | "uploaded"]` (length 3, defaults to
  all-recorded for old callers).
- `PersonEnrollment` + `centrally_enrolled: bool = False` and
  `consent_recorded_at: datetime | None`.

### Backend routes (`backend/app/routers/people.py`)

- `POST /people/{id}/enroll`: 422 unless `consent_confirmed` is true. After
  pyannote voiceprint creation (unchanged, clips memory-only): write the
  local registry (pre-cutover behaviour and rollback window), then, when
  central enrolment is required, register centrally with the server-stamped
  `consent_recorded_at`. Central failure → 502 retryable, response never
  claims success. Audited via `store.add_audit` as today.
- `GET /people/me/enrolment-status` (new): `{ enrolled_locally,
  centrally_enrolled, central_required }` — the gate's single source of truth.
  "Me" is resolved from a new `X-MN-User-Email` header that `api-proxy.ts`
  injects from the authenticated main-process session (`getCurrentUserEmail()`)
  — not from `X-MN-User`, which carries the display name. A missing header
  fails closed (`enrolled_locally=false, centrally_enrolled=false`) while
  still reporting `central_required` accurately.

### Electron main (`src/main/api-proxy.ts`)

Attach `X-MN-Storage-Token` on `/people/*/enroll` and
`/people/me/enrolment-status` via silent MSAL acquisition of
`MN_STORAGE_API_SCOPE` when configured — a copy of the existing
`X-MN-Graph-Token` pattern. Renderer never sees tokens. Stub ignores the
header; absence of the scope config sends no header.

### Renderer

- `EnrollmentModal`: consent step copy extended to cover central storage,
  that only the voiceprint reference is retained, and re-enrolment at
  cutover (copy drafted for David's review). Each clip slot offers record
  (existing) or upload (new file picker; decoded duration must be 5–20 s;
  same quality analysis). Sends `consent_confirmed` and `sample_sources`.
- `App.tsx` gate: consumes `/people/me/enrolment-status`; requires
  `centrally_enrolled` when `central_required`, else `enrolled_locally`.
  Keeps the existing retry-with-backoff while the packaged backend boots.

## Cutover semantics

Local voiceprints can never set `centrally_enrolled` — the rule is
structural, not policy. Only a central record with `status == "active"`
satisfies the gate: `disabled`/`deleted` records (offboarding, IN-382)
fail closed. (Added 21 Jul after Task 4 code review.) After cutover, Slice 1 local records remain only for
the agreed rollback window and are invisible to the gate. Stub central data
is dev-only and does not migrate to the real store (same rule as local
voiceprints). A person flagged for re-enrolment (`reenrollment_required`)
does not count as locally enrolled for the gate; whether a flag should also
invalidate a central record is deferred to IN-382 (offboarding). (Added 21
Jul, final review.)

## Error handling

| Failure | Behaviour |
| --- | --- |
| Consent not confirmed | 422 before any provider call |
| pyannote failure | existing 503 path unchanged |
| Central registration failure | 502 retryable; wizard keeps accepted clips in memory and offers retry; local write already done (harmless, rollback-aligned) |
| Re-enrolment / retry | upsert by `person_id`; replaces prior central record |
| Missing token when central required | 502 with explicit "sign-in required for central enrolment" message |
| Malformed record from the real API | wrapped in `StorageApiError` inside the seam (never a raw ValidationError/500), so the status endpoint's fail-closed catch always holds — a 500 there would let Task 6's renderer fallback revert the gate to local enrolment post-cutover (added 21 Jul after Task 4 review) |

**Central-store** audit events are not written by desktop or backend — the
Function writes them server-side (brief §5, IN-381), so the stub no-ops with
a comment. Local `store.add_audit` on the enroll endpoint continues unchanged
per AGENTS.md (every mutating endpoint audits).

## Testing

Backend TDD (`backend/tests/test_central_enrolment.py`): consent 422; gate
matrix (central required × local/central enrolment, 4 states); registration
payload carries the D3 field set with server-stamped UTC
`consent_recorded_at`; upsert on re-enrolment; central failure → 502 and
`centrally_enrolled` stays false; stub activation on empty config; clips
never written to disk. Plus the standard battery: full unittest suite,
`npm run verify:graph`, `npm run typecheck`, `npm run build`,
`git diff --check`, and a native dev smoke of the wizard.

## Out of scope

Admin management screen (IN-380), audit log view (IN-381), offboarding
(IN-382), meeting-time voiceprint retrieval (IN-378), JSON/audio Blob writes
(IN-386), any real Azure resource or the IN-471 Function implementation.
