# Spike: Graph Mail.Send (interim meeting notes delivery)

**Status: validated** — delegated `Mail.Send`, attachment delivery, and `@factor1.com.au` recipient filtering all work against the existing Entra app registration.

Standalone test for **Option 1** — send transcript/summary attachments via the signed-in user's Outlook mailbox using Microsoft Graph `POST /me/sendMail`.

This folder is **not** wired into the Notetaker app. It proved the approach before Slice 1 implementation. **Slice 4 Teams delivery** will replace email; delete this spike when that ships.

---

## What was validated

| Check | Result |
|---|---|
| `Mail.Send` on existing Entra app (`AZURE_AD_CLIENT_ID` from desktop) | Works with delegated permission + user consent |
| File attachment (`.md` transcript) via `sendMail` | Delivers to inbox; appears in Sent Items |
| Recipient filter — external domains stripped | External invitees rejected; only `@factor1.com.au` in To |
| Graph `/me` | Resolves signed-in user's mailbox |

---

## Recipient filtering (required for production)

Calendar meetings often include **external client** invitees. Meeting notes must **never** be auto-emailed to them.

### Rule

Only recipients whose email domain is exactly **`factor1.com.au`** (case-insensitive) may receive automated notes.

| Recording type | Recipients after filter |
|---|---|
| Calendar-linked meeting | All invitees with `@factor1.com.au` email |
| Ad-hoc / manual / uploaded audio | Signed-in user only (must be `@factor1.com.au`) |
| External `@client.com`, `@gmail.com`, etc. | **Never sent** — logged as rejected |

### Implementation reference

Logic lives in `recipient-filter.mjs`:

- `isAllowedInternalDomain(email)` — exact domain match on `factor1.com.au`
- `filterInternalRecipients(recipients)` — returns `{ allowed, rejected }`
- Empty or malformed emails go to **rejected**

When building Slice 1, **port this module** (or equivalent) into the Electron main process. Run the filter immediately before `sendMail`, using attendee emails from Graph calendar metadata or ad-hoc upload payload.

Run unit tests:

```powershell
npm test
```

Spike dry-run prints allowed vs rejected addresses without sending:

```powershell
npm run spike:dry-run
```

---

## Authentication — spike vs production

### Spike (this folder): device code flow

The spike is a **CLI script** with no Electron UI. It uses MSAL **device code** flow:

1. Terminal prints a code and URL ([login.microsoft.com/device](https://login.microsoft.com/device))
2. User signs in once and consents to `Mail.Send`
3. Tokens cached in `.msal-token-cache.json` (gitignored)
4. Repeat runs use **`acquireTokenSilent`** — no device code unless cache is cleared or scopes change

This is **acceptable for spike testing only**. End users must never see a terminal device-code step.

### Production (Slice 1): use existing desktop auth

The Notetaker desktop app already authenticates via MSAL in `meeting-notetaker-main/desktop/src/main/auth.ts`:

| Concern | Existing app behaviour |
|---|---|
| Sign-in UX | `acquireTokenInteractive` — system browser opens automatically (not device code) |
| Token cache | Encrypted `msal-cache.enc` in Electron `%APPDATA%` userData |
| Tenant / client | Same `AZURE_AD_TENANT_ID` and `AZURE_AD_CLIENT_ID` as backend |
| Current Graph scopes | `Calendars.Read`, `User.Read`, `openid`, `profile`, `offline_access` |

**Slice 1 email implementation must reuse this auth stack**, not the spike's device-code flow or separate cache file.

#### Changes needed in `auth.ts` for production mail

1. Add `https://graph.microsoft.com/Mail.Send` to **`ALL_SCOPES`** (and a dedicated mail scope constant if helpful)
2. Add an **`acquireMailToken()`** (or extend `acquireToken()`) that calls `acquireTokenSilent` with `Mail.Send` — same pattern as calendar token acquisition
3. **One re-sign-in** when the app update ships: existing users consent to the new scope via the normal browser sign-in flow (same as first install)
4. After that, every post-meeting send uses **silent token refresh** — no user interaction per meeting

#### Where send happens

After local pipeline completes (`status=complete`):

1. Electron main process polls or receives meeting completion
2. Fetches transcript + summary from backend API
3. Applies `filterInternalRecipients()` to invitee list
4. Calls Graph `POST /me/sendMail` with `acquireMailToken()` bearer token
5. Logs rejected externals; aborts send if zero allowed recipients

Do **not** pass mail tokens through the FastAPI backend — keep mail sending in Electron main process where MSAL cache already lives.

---

## Entra app registration

Use the **same app registration** as the desktop Notetaker (see `desktop/.env.local` or docs referencing client ID `3e3f3422-d4fa-4ebe-9b22-148439e84cc3` in Factor1 tenant).

### Azure Portal (one-time)

1. **App registrations** → your Notetaker app → **API permissions**
2. Add Microsoft Graph **Delegated** → **`Mail.Send`**
3. **Grant admin consent** if your tenant requires it
4. Users re-consent on first run after scope is added (browser sign-in in app; device code in this spike)

Existing permissions unchanged: `User.Read`, `Calendars.Read`.

---

## Running the spike (local validation only)

### Prerequisites

- Node.js 18+
- Outlook on machine (optional — confirms Sent Items sync)

### Setup

```powershell
cd spike-graph-sendmail
npm install
copy .env.example .env
```

Edit `.env`:

- `AZURE_AD_TENANT_ID` / `AZURE_AD_CLIENT_ID` — same as `meeting-notetaker-main/desktop/.env.local`
- `TEST_RECIPIENTS` — comma-separated; **include at least one external address** to verify filtering

### Run

```powershell
npm run spike:dry-run   # auth + filter only, no send
npm run spike           # send test email with attachment
```

---

## Troubleshooting (spike)

| Error | Likely fix |
|---|---|
| `403` / `Authorization_RequestDenied` | Add delegated `Mail.Send`; grant admin consent |
| `InvalidAuthenticationToken` | Delete `.msal-token-cache.json` and re-run |
| Device code every run | Cache missing or silent refresh failed — check `.msal-token-cache.json` exists |
| `413 Request Entity Too Large` | Attachment too large for inline send (unlikely for text transcripts) |
| No mail in Sent Items | Wait for Outlook sync (~1 min) |

---

## Files in this spike

| File | Purpose |
|---|---|
| `send-mail-spike.mjs` | Device-code auth + filter + `sendMail` (spike only) |
| `recipient-filter.mjs` | **Port to production** — `@factor1.com.au` filter |
| `recipient-filter.test.mjs` | Unit tests for filter logic |
| `sample-meeting-notes.md` | Sample attachment |

---

## Lifecycle

| Phase | Delivery mechanism |
|---|---|
| Slice 1 (interim) | Graph `Mail.Send` from Electron — existing auth + filter |
| Slice 4 | Teams meeting chat / private message — **replace email** |
| After Slice 4 | Remove spike folder and Slice 1 email module |
