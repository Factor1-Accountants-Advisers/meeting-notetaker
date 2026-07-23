# IN-476 Desktop Storage API Cutover Design

**Date:** 23 July 2026
**Jira:** IN-476
**Parent:** IN-375
**Status:** Approved in conversation; implementation not started

## Goal

Cut the packaged Meeting Notetaker desktop application over from the
development-only, email-keyed central-enrolment seam to the live authenticated
Storage API. The desktop must use the signed-in user's Entra object ID (`oid`)
for central voiceprint records while continuing to use email as the local staff
registry key.

## Authorities

- Jira IN-476 and parent IN-375.
- `docs/storage-api/rest-contract-v1.md`.
- The deployed Storage API:
  `https://func-innov-nt-storage-prod-eqg7dzf8gfbqawea.australiaeast-01.azurewebsites.net`.
- Delegated scope:
  `api://13298042-714a-4d57-a1c5-481c22753087/access_as_user`.
- Existing IN-379 enrolment design and implementation.

## Scope

1. Extract the signed-in user's tenant-local Entra object ID from the MSAL
   account in Electron main.
2. Propagate email, OID, and the delegated Storage API token from Electron main
   to FastAPI on enrolment-related requests only.
3. Keep email-based local person and voiceprint behavior unchanged.
4. Use OID for the central Storage API path and
   `CentralEnrolment.person_id`.
5. Add public, overrideable production defaults for the Storage API URL and
   scope.
6. Fail closed before Pyannote processing when central storage is required but
   the OID or delegated token is unavailable.
7. Add automated tests, documentation, and a coordinated authenticated
   production smoke.

## Out of scope

- Storage API changes or redeployment.
- Admin voiceprint management, offboarding, or read-audit expansion.
- Migration of Slice 1 local voiceprints.
- Changes to the renderer's authentication surface.
- A production PUT without Joseph's explicit approval at smoke-test time.

## Architecture

The existing thin-client boundary remains:

```
Renderer
  -> preload IPC
  -> Electron main (MSAL account + token)
  -> FastAPI (local email identity + central OID identity)
  -> authenticated Storage API
  -> Azure Blob through Function managed identity
```

The renderer continues to receive neither tokens nor identity claims. Electron
main is the only desktop component that reads the MSAL account and attaches
identity headers.

### Rejected alternatives

1. **Decode the access token in FastAPI.** Rejected because the desktop backend
   does not validate Storage API tokens and should not treat an unvalidated
   claim as authoritative.
2. **Add `/voiceprints/me` to the Storage API.** Rejected because it changes a
   deployed, ratified contract when the existing self-or-admin OID route already
   supports the required behavior.

## Identity model

Email and OID have separate purposes:

| Identity | Purpose |
| --- | --- |
| Email / UPN | Existing local `PersonEnrollment.employee_id`, local voiceprint lookup, display and audit context |
| Entra `oid` | Central Storage API URL path and `CentralEnrolment.person_id` |

Electron main derives OID from `AccountInfo.idTokenClaims.oid`. For cached
single-tenant accounts, `AccountInfo.localAccountId` is accepted as a fallback.
Empty or whitespace-only values are treated as missing.

The MSAL token result carries `accountOid` alongside the existing email and
display name. `auth-session.ts` caches it using the same cold-start pattern as
email. On Storage API routes, Electron first performs silent token acquisition
and then reads email and OID so refreshed account metadata is available.

Electron sends these internal headers to FastAPI:

- `X-MN-User-Email`
- `X-MN-User-Oid`
- `X-MN-Storage-Token`

They are attached only to:

- `GET /api/v1/people/me/enrolment-status`
- `POST /api/v1/people/{employee_id}/enroll`

The existing `X-MN-User` display-name audit actor is unchanged.

## FastAPI behavior

### Enrolment status

`GET /people/me/enrolment-status` uses email to determine local enrolment and
OID to query the central record:

```
local person = PEOPLE[email]
central record = Storage API /voiceprints/{oid}
```

When central storage is required:

- missing email fails both local and central status closed;
- missing OID or token skips the central call and reports
  `centrally_enrolled=false`;
- Storage API errors remain fail-closed;
- only a returned record with `status == "active"` satisfies the central gate.

No request may substitute email into the central path.

### Enrolment write

`POST /people/{employee_id}/enroll` continues to resolve the local person using
the normalized email path parameter. When central storage is required, it
validates the presence of both OID and delegated token after consent and request
shape validation but before any Pyannote work or local voiceprint mutation.

The central record uses:

```text
person_id = X-MN-User-Oid
display_name = local PersonEnrollment.display_name
```

The route continues to:

- require explicit consent;
- require exactly three clips;
- keep enrolment audio memory-only;
- run the three existing Pyannote voiceprint jobs;
- write the local rollback-window record;
- call the central API;
- audit the local mutation;
- preserve the existing 180-second Electron proxy timeout.

The signed-in OID identifies the central record. The email path still selects
the local person being enrolled. When central storage is required, the route
also requires the normalized `employee_id` path to equal `X-MN-User-Email`.
This prevents a modified renderer from selecting another local employee while
writing to the signed-in user's central OID. The live Storage API independently
enforces that the OID path matches the delegated token's `oid`.

## Public configuration

`src/main/env.ts` will define these non-secret defaults next to the existing
public Entra client and tenant IDs:

```text
MN_STORAGE_API_URL=https://func-innov-nt-storage-prod-eqg7dzf8gfbqawea.australiaeast-01.azurewebsites.net
MN_STORAGE_API_SCOPE=api://13298042-714a-4d57-a1c5-481c22753087/access_as_user
```

Existing environment and `.env` values retain precedence. This provides:

- automatic live configuration in packaged builds;
- an override path for test, rollback, or a future hostname;
- no new secret, credential, SAS, or storage key.

`MN_STORAGE_API_ENABLED=false` is the explicit operational rollback switch.
When false, FastAPI treats central enrolment as not required and Electron skips
Storage API token acquisition. An absent value means enabled when a URL is
configured. This avoids overloading an empty URL—which the existing public-env
loader intentionally treats as missing—and makes rollback behavior testable.

`loadPublicEnv()` runs before the packaged backend supervisor starts. The
backend child inherits `process.env`, so the URL reaches FastAPI and the scope
remains available to Electron main. A developer launching FastAPI directly
does not run Electron's public-env loader and therefore stays in stub mode
unless they explicitly set `MN_STORAGE_API_URL`.

The configuration is documented in `backend.env.template` and
`backend/.env.example`, with a warning that packaged public defaults normally
own these values and that overrides must keep Electron main and FastAPI
consistent.

## Error handling

| Failure | Required behavior |
| --- | --- |
| Storage API scope absent after override/configuration | No token; central flow fails closed |
| Silent token acquisition requires interaction | Central flow fails closed; renderer remains on enrolment gate |
| Email missing | Local and central status false |
| OID missing | No central request; status false or enrolment returns retryable 502 |
| Storage token missing | No central request; status false or enrolment returns retryable 502 |
| Enrolment path email differs from signed-in email | 403 before provider work |
| OID does not match token | Storage API returns 403; desktop surfaces central registration failure |
| Central API unavailable or malformed response | Existing fail-closed/retry behavior |

Logs record only booleans, status codes, route shapes, and correlation IDs.
They never record access tokens, OIDs, emails, or voiceprint values as part of
this cutover.

## Testing

Implementation follows red-green-refactor.

### Electron/main-process verification

A focused verification script will cover:

- OID extraction from `idTokenClaims.oid`;
- cached-account fallback to `localAccountId`;
- whitespace/missing identity rejection;
- Storage API header construction;
- OID not being substituted with email;
- explicit `MN_STORAGE_API_ENABLED=false` rollback behavior;
- production public defaults;
- environment override precedence;
- storage-route boundary matching;
- preservation of the 180-second enrolment timeout.

### Backend tests

`backend/tests/test_central_enrolment.py` will cover:

- status uses email locally and OID centrally;
- central status is not called without OID or token;
- central enrolment payload uses OID;
- email is never sent as `person_id`;
- central enrolment rejects a path/header email mismatch before provider work;
- missing OID/token stops before provider work;
- existing stub-mode and gate behavior remains intact.

### Required verification battery

- focused storage-cutover verification script;
- focused backend central-enrolment tests;
- full backend unittest suite;
- `npm run verify:graph`;
- `npm run typecheck`;
- `npm run build`;
- `git diff --check`;
- native Electron restart/smoke because Electron main changes do not hot reload.

## Authenticated production smoke

The smoke is deliberately staged:

1. Start the Electron app with the cutover branch and sign in normally if the
   cached session cannot acquire the delegated scope silently.
2. Confirm the packaged/main-process configuration uses the exact unique
   Function hostname and delegated scope.
3. Call the self enrolment-status flow, which acquires a delegated token and
   performs `GET /api/v1/voiceprints/{signed_in_oid}`.
4. Record only HTTP status, response classification, and correlation ID.
5. Treat either `200` with a valid active/inactive record or `404` with the
   contract error envelope as proof of authentication and self-authorization.
6. If a write is needed to prove end-to-end enrolment, show Joseph the exact
   target OID and operation without exposing the voiceprint payload, then wait
   for explicit approval before PUT.

The smoke does not copy tokens or voiceprint material into Jira, logs, or
documentation.

## Rollout and rollback

- The code ships behind public configuration values that remain overrideable.
- Setting `MN_STORAGE_API_ENABLED=false` in an override returns the backend to
  stub mode for diagnosis; it does not migrate or delete any data.
- Local voiceprints remain only for the previously agreed rollback window and
  cannot satisfy the central gate while central storage is configured.
- No production storage record is deleted or rewritten as part of deployment.

## Delivery evidence

After implementation:

- add the commit and verification evidence to `docs/jira-progress.md`;
- correct the stale voiceprint-endpoint status in the mirrored REST contract;
- attach a concise verification comment to IN-476;
- leave IN-395 as the independent acceptance-test ticket.
