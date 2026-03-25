# Azure AD SSO Authentication — Design Spec

## Goal

Wire up real Azure AD SSO authentication in the Next.js web app, replacing the dev bypass with a working Microsoft login flow. Backend JWT validation and desktop MSAL auth already exist — this spec covers the frontend integration and a backend dev bypass toggle.

## Background

The Meeting Note-Taker app serves an Australian accounting firm. Users sign in with their company Microsoft accounts via Azure AD. The backend already validates Azure AD JWT tokens (via JWKS) and auto-provisions users on first login. The frontend currently has a placeholder login page and sends no auth headers.

Azure AD credentials (Tenant ID, Client ID, Client Secret) are now configured in `backend/.env.local`.

## Scope

### In scope
- Frontend MSAL.js integration (login, token acquisition, logout)
- Frontend route protection (redirect unauthenticated users to login)
- API client Bearer token injection
- Backend dev bypass toggle (`USE_DEV_AUTH_BYPASS` env var)
- Environment variable additions for frontend

### Out of scope
- Backend JWT validation changes (already implemented in `security.py`)
- Desktop MSAL changes (already implemented in worktree)
- Role-based access control
- Token refresh beyond MSAL's built-in silent renewal
- Session revocation / logout-on-all-devices

## Architecture

### Token Strategy: ID Tokens

The backend (`security.py` line 132) validates tokens with `audience == client_id`. Access tokens acquired for Microsoft Graph scopes (e.g. `User.Read`) have `audience == "https://graph.microsoft.com"`, which would fail validation.

**Solution:** Use **ID tokens** for backend API calls. ID tokens have `aud == client_id` by default, contain the `oid`, `preferred_username`, and `name` claims the backend requires, and are the standard approach for single-tenant apps where the backend just needs to verify identity.

MSAL's `loginRedirect` acquires both an ID token and an access token. The `useAuth` hook will extract the ID token from the MSAL account object and send it as the Bearer token.

### Auth Flow

```
User visits /meetings
  → AuthGuard checks: authenticated?
  → NO → redirect to /login
  → User clicks "Sign in with Microsoft"
  → MSAL redirects to login.microsoftonline.com
  → User signs in with company Microsoft account
  → Microsoft redirects back to /login with auth code
  → MSAL exchanges code for ID + access tokens, stores in sessionStorage
  → Redirect to / (dashboard)
  → SWR hooks call API with ID token in Authorization header
  → Backend validates JWT via Azure AD JWKS (audience == client_id ✓)
  → Returns user-scoped data
```

### Component Map

```
layout.tsx
  └─ AuthProvider (MsalProvider wrapper)
       ├─ /login → Login page (no AuthGuard)
       └─ /(protected) route group
            └─ layout.tsx with AuthGuard
                 └─ Page components
                      └─ SWR hooks → api.ts fetcher (injects ID token)
```

## Frontend Components

### 1. MSAL Configuration (`web/src/lib/msal-config.ts`)

- `PublicClientApplication` configuration object
- Authority: `https://login.microsoftonline.com/{NEXT_PUBLIC_AZURE_AD_TENANT_ID}`
- Client ID: `NEXT_PUBLIC_AZURE_AD_CLIENT_ID`
- Redirect URI: `NEXT_PUBLIC_AZURE_AD_REDIRECT_URI` (default: `http://localhost:3000/login`)
- Login scopes: `["openid", "profile", "User.Read"]` — `openid` and `profile` ensure an ID token with identity claims; `User.Read` grants a Graph access token (not used for API calls, but triggers consent for basic profile)
- Cache location: `sessionStorage` (cleared on tab close — appropriate for shared workstations at an accounting firm)

### 2. Auth Provider (`web/src/components/AuthProvider.tsx`)

- Client component (`'use client'`)
- Wraps `MsalProvider` from `@azure/msal-react`
- Initializes `PublicClientApplication` instance
- Placed in root `layout.tsx` to wrap the entire app (including login page, so MSAL can handle the redirect callback)

### 3. Auth Hook (`web/src/lib/useAuth.ts`)

Custom hook built on `useMsal()` exposing a simplified interface:

```typescript
interface UseAuth {
  user: { name: string; email: string } | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  getIdToken: () => Promise<string>;
}
```

- `getIdToken()` gets the ID token from the active MSAL account. Attempts `acquireTokenSilent` first (which refreshes the ID token if expired), falls back to redirect if silent fails.
- `login()` triggers `loginRedirect` with configured scopes
- `logout()` triggers `logoutRedirect`

### 4. API Client Update (`web/src/lib/api.ts`)

- Update the SWR fetcher to include `Authorization: Bearer {idToken}` header
- `getIdToken()` called before each request
- If token acquisition fails (user not authenticated), redirect to `/login`
- All existing SWR hooks (`useMeetings`, `useMeeting`, etc.) automatically get auth headers through the shared fetcher
- Also update non-SWR mutation functions (e.g., `updateActionItem`) to include the Bearer token header

### 5. Auth Guard (`web/src/components/AuthGuard.tsx`)

- Client component wrapping protected content
- Checks authentication state via `useAuth()`
- If not authenticated and not loading → redirect to `/login`
- If loading → show loading spinner
- If authenticated → render children

**Route structure:** Use a Next.js `(protected)` route group with its own `layout.tsx` that includes AuthGuard. Move all existing pages (`/`, `/meetings/[id]`, `/action-items`) into the `(protected)` group. The `/login` page stays outside the group and is not wrapped by AuthGuard.

### 6. Login Page Update (`web/src/app/login/page.tsx`)

- Replace disabled placeholder with working "Sign in with Microsoft" button
- On click: trigger MSAL `loginRedirect` with configured scopes
- After successful redirect callback: navigate to `/` (dashboard)
- Show error message if login fails
- If already authenticated, redirect to `/` immediately

### 7. Nav Update (`web/src/components/Nav.tsx`)

- Add user display (name/email from MSAL account)
- Add "Sign out" button that triggers MSAL `logoutRedirect`

## Backend Changes

### Dev Bypass Toggle

The current bypass condition in `_auth_bypass_enabled()` (line 63-68 of `dependencies.py`) checks `not settings.azure_ad_tenant_id`. Now that Azure AD credentials are configured, this bypass is already broken. We replace it with an explicit toggle.

**New env var:** `USE_DEV_AUTH_BYPASS` (default: `false`)

**Changes to `dependencies.py`:**
- Update `_auth_bypass_enabled()` to check `settings.use_dev_auth_bypass` instead of `not settings.azure_ad_tenant_id`
- Keep the existing `AND ENVIRONMENT == "development"` guard

**Updated logic:**
```python
def _auth_bypass_enabled() -> bool:
    return (
        settings.environment == "development"
        and settings.use_dev_auth_bypass
    )
```

**New setting in `config.py`:**
```python
use_dev_auth_bypass: bool = False
```

This decouples the bypass from the presence of Azure AD credentials. Developers can explicitly opt into bypass mode regardless of whether credentials are configured.

## Environment Variables

### New frontend env vars (`web/.env.local`)

```
NEXT_PUBLIC_AZURE_AD_TENANT_ID=<tenant-id-from-backend-.env.local>
NEXT_PUBLIC_AZURE_AD_CLIENT_ID=<client-id-from-backend-.env.local>
NEXT_PUBLIC_AZURE_AD_REDIRECT_URI=http://localhost:3000/login
```

The `NEXT_PUBLIC_` prefix makes these available in the browser. Tenant ID and Client ID are safe to expose — they are public identifiers, not secrets. The redirect URI must match what's configured in the Azure AD app registration.

### Updated backend env vars (`backend/.env.local`)

```
USE_DEV_AUTH_BYPASS=false
```

Set to `true` when you want to skip auth during development.

## Dependencies

### New npm packages (`web/`)

- `@azure/msal-browser` — core MSAL library for browser-based auth
- `@azure/msal-react` — React hooks and components for MSAL

### No new backend dependencies

`python-jose[cryptography]` is already installed for JWT validation.

## Testing Strategy

- **Unit tests**: Mock MSAL provider in component tests, verify AuthGuard redirects, verify API client adds Bearer header
- **Integration test**: Verify fetcher includes Authorization header when token is available
- **Manual test**: Full login flow — visit app → redirect to login → sign in with Microsoft → see dashboard
- **Bypass test**: Set `USE_DEV_AUTH_BYPASS=true` in backend, verify API works without token

## Security Considerations

- **ID tokens for API auth** — ID tokens have `aud == client_id`, matching backend validation. Access tokens are not sent to our API.
- **sessionStorage** for token cache — tokens cleared on tab close, not persisted across sessions (appropriate for shared workstations)
- **No secrets in browser** — only Tenant ID and Client ID are exposed (public values)
- **Client Secret stays backend-only** — not used in the frontend MSAL flow (public client)
- **Fail-closed** — backend rejects requests without valid tokens by default
- **Dev bypass is explicit** — requires both `USE_DEV_AUTH_BYPASS=true` AND `ENVIRONMENT=development`
- **CORS** — already configured in `main.py` to allow all origins in development. Production CORS origins must be updated when deploying.
