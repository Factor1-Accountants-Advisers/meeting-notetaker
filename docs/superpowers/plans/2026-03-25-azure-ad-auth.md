# Azure AD SSO Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up real Azure AD SSO in the Next.js web app using MSAL.js, with ID token-based API authentication and an explicit dev bypass toggle.

**Architecture:** Frontend uses `@azure/msal-react` for login/token management, sends ID tokens as Bearer tokens to the FastAPI backend (which already validates JWTs via JWKS). A `(protected)` route group wraps authenticated pages, and a `USE_DEV_AUTH_BYPASS` env var replaces the old implicit bypass.

**Tech Stack:** Next.js 14 (App Router), @azure/msal-browser, @azure/msal-react, FastAPI, python-jose

**Spec:** `docs/superpowers/specs/2026-03-25-azure-ad-auth-design.md`

---

## File Structure

### New files (frontend)
| File | Responsibility |
|------|---------------|
| `web/src/lib/msal-config.ts` | MSAL PublicClientApplication config (authority, clientId, redirect, cache) |
| `web/src/lib/useAuth.ts` | Custom hook: user, isAuthenticated, login, logout, getIdToken |
| `web/src/components/AuthProvider.tsx` | Client component wrapping MsalProvider |
| `web/src/components/AuthGuard.tsx` | Client component: redirect to /login if unauthenticated |
| `web/src/app/(protected)/layout.tsx` | Protected route group layout with AuthGuard |
| `web/.env.local` | Frontend environment variables (NEXT_PUBLIC_AZURE_AD_*) |

### Moved files (frontend — route group restructure)
| From | To |
|------|-----|
| `web/src/app/page.tsx` | `web/src/app/(protected)/page.tsx` |
| `web/src/app/meetings/[id]/page.tsx` | `web/src/app/(protected)/meetings/[id]/page.tsx` |
| `web/src/app/action-items/page.tsx` | `web/src/app/(protected)/action-items/page.tsx` |

### Modified files (frontend)
| File | Change |
|------|--------|
| `web/src/app/layout.tsx` | Wrap children with AuthProvider, remove Nav (moved to protected layout) |
| `web/src/app/login/page.tsx` | Replace placeholder with working MSAL login |
| `web/src/lib/api.ts` | Add Bearer token to fetcher and mutation functions |
| `web/src/components/Nav.tsx` | Add user display and sign-out button |

### Modified files (backend)
| File | Change |
|------|--------|
| `backend/app/core/config.py:38` | Add `use_dev_auth_bypass: bool = False` |
| `backend/app/api/dependencies.py:63-68` | Update `_auth_bypass_enabled()` to use new toggle |
| `backend/.env.local` | Add `USE_DEV_AUTH_BYPASS=false` |

---

### Task 1: Backend Dev Bypass Toggle

**Files:**
- Modify: `backend/app/core/config.py:38`
- Modify: `backend/app/api/dependencies.py:63-68`
- Modify: `backend/.env.local`

- [ ] **Step 1: Add `use_dev_auth_bypass` to Settings**

In `backend/app/core/config.py`, add after line 38 (after `whisper_model`):

```python
    # Dev auth bypass
    use_dev_auth_bypass: bool = False
```

- [ ] **Step 2: Update `_auth_bypass_enabled()` in dependencies.py**

Replace lines 63-68 in `backend/app/api/dependencies.py`:

```python
def _auth_bypass_enabled() -> bool:
    """True when explicitly enabled via USE_DEV_AUTH_BYPASS in dev mode."""
    return (
        settings.environment == "development"
        and settings.use_dev_auth_bypass
    )
```

- [ ] **Step 3: Add USE_DEV_AUTH_BYPASS to backend .env.local**

Add to `backend/.env.local`:

```
USE_DEV_AUTH_BYPASS=false
```

- [ ] **Step 4: Verify bypass is disabled**

Run:
```bash
cd C:/Projects/meeting-notetaker/backend
python -c "from app.core.config import settings; print('bypass:', settings.use_dev_auth_bypass)"
```
Expected: `bypass: False`

- [ ] **Step 5: Verify API rejects unauthenticated requests**

Run:
```bash
curl -s http://localhost:8000/api/meetings | python -m json.tool
```
Expected: `{"detail": "Authentication required"}` (401)

- [ ] **Step 6: Verify bypass works when enabled**

Temporarily set `USE_DEV_AUTH_BYPASS=true` in `backend/.env.local`, restart server, and test:
```bash
curl -s http://localhost:8000/api/meetings
```
Expected: Returns meeting list JSON (200). Then set back to `false`.

- [ ] **Step 7: Commit**

```bash
git add backend/app/core/config.py backend/app/api/dependencies.py backend/.env.local
git commit -m "feat(auth): add explicit USE_DEV_AUTH_BYPASS toggle

Replace implicit bypass (checked azure_ad_tenant_id presence) with
explicit env var toggle. Bypass now requires both
USE_DEV_AUTH_BYPASS=true AND ENVIRONMENT=development."
```

---

### Task 2: Install MSAL Dependencies & Create Config

**Files:**
- Create: `web/src/lib/msal-config.ts`
- Create: `web/.env.local`

- [ ] **Step 1: Install MSAL packages**

```bash
cd C:/Projects/meeting-notetaker/web
npm install @azure/msal-browser @azure/msal-react
```

- [ ] **Step 2: Create frontend .env.local**

Create `web/.env.local`:

```
NEXT_PUBLIC_AZURE_AD_TENANT_ID=891d380b-39a6-4eb4-aca5-4ffe1d3c25ac
NEXT_PUBLIC_AZURE_AD_CLIENT_ID=3e3f3422-d4fa-4ebe-9b22-148439e84cc3
NEXT_PUBLIC_AZURE_AD_REDIRECT_URI=http://localhost:3000/login
```

- [ ] **Step 3: Create MSAL configuration**

Create `web/src/lib/msal-config.ts`:

```typescript
import { Configuration, LogLevel } from "@azure/msal-browser";

const tenantId = process.env.NEXT_PUBLIC_AZURE_AD_TENANT_ID;
const clientId = process.env.NEXT_PUBLIC_AZURE_AD_CLIENT_ID;
const redirectUri =
  process.env.NEXT_PUBLIC_AZURE_AD_REDIRECT_URI || "http://localhost:3000/login";

if (!tenantId || !clientId) {
  throw new Error(
    "Missing NEXT_PUBLIC_AZURE_AD_TENANT_ID or NEXT_PUBLIC_AZURE_AD_CLIENT_ID"
  );
}

export const msalConfig: Configuration = {
  auth: {
    clientId,
    authority: `https://login.microsoftonline.com/${tenantId}`,
    redirectUri,
    postLogoutRedirectUri: "/login",
  },
  cache: {
    cacheLocation: "sessionStorage",
    storeAuthStateInCookie: false,
  },
  system: {
    loggerOptions: {
      logLevel: LogLevel.Warning,
      loggerCallback: (level, message, containsPii) => {
        if (containsPii) return;
        if (level === LogLevel.Error) console.error(message);
        else if (level === LogLevel.Warning) console.warn(message);
      },
    },
  },
};

export const loginRequest = {
  scopes: ["openid", "profile", "User.Read"],
};
```

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/msal-config.ts web/package.json web/package-lock.json
git commit -m "feat(auth): install MSAL and create config

Add @azure/msal-browser and @azure/msal-react.
Configure PublicClientApplication with sessionStorage cache."
```

Note: Do NOT commit `web/.env.local` — it contains credentials and should stay gitignored.

---

### Task 3: Auth Provider & useAuth Hook

**Files:**
- Create: `web/src/components/AuthProvider.tsx`
- Create: `web/src/lib/useAuth.ts`

- [ ] **Step 1: Create AuthProvider component**

Create `web/src/components/AuthProvider.tsx`:

```tsx
"use client";

import { ReactNode } from "react";
import { MsalProvider } from "@azure/msal-react";
import { PublicClientApplication } from "@azure/msal-browser";
import { msalConfig } from "@/lib/msal-config";

const msalInstance = new PublicClientApplication(msalConfig);

export default function AuthProvider({ children }: { children: ReactNode }) {
  return <MsalProvider instance={msalInstance}>{children}</MsalProvider>;
}
```

- [ ] **Step 2: Create useAuth hook**

Create `web/src/lib/useAuth.ts`:

```typescript
"use client";

import { useMsal, useIsAuthenticated } from "@azure/msal-react";
import { InteractionRequiredAuthError } from "@azure/msal-browser";
import { useCallback, useMemo } from "react";
import { loginRequest } from "@/lib/msal-config";

export interface AuthUser {
  name: string;
  email: string;
}

export function useAuth() {
  const { instance, accounts, inProgress } = useMsal();
  const isAuthenticated = useIsAuthenticated();
  const isLoading = inProgress !== "none";

  const user: AuthUser | null = useMemo(() => {
    if (accounts.length === 0) return null;
    const account = accounts[0];
    return {
      name: account.name || "",
      email: account.username || "",
    };
  }, [accounts]);

  const login = useCallback(async () => {
    await instance.loginRedirect(loginRequest);
  }, [instance]);

  const logout = useCallback(async () => {
    await instance.logoutRedirect({
      postLogoutRedirectUri: "/login",
    });
  }, [instance]);

  const getIdToken = useCallback(async (): Promise<string> => {
    if (accounts.length === 0) {
      throw new Error("No authenticated account");
    }

    try {
      const response = await instance.acquireTokenSilent({
        ...loginRequest,
        account: accounts[0],
      });
      return response.idToken;
    } catch (error) {
      if (error instanceof InteractionRequiredAuthError) {
        await instance.acquireTokenRedirect(loginRequest);
        throw new Error("Redirecting for token acquisition");
      }
      throw error;
    }
  }, [instance, accounts]);

  return { user, isAuthenticated, isLoading, login, logout, getIdToken };
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd C:/Projects/meeting-notetaker/web
npx tsc --noEmit
```
Expected: No errors (or only pre-existing ones unrelated to auth files).

- [ ] **Step 4: Commit**

```bash
git add web/src/components/AuthProvider.tsx web/src/lib/useAuth.ts
git commit -m "feat(auth): add AuthProvider and useAuth hook

AuthProvider wraps MsalProvider for the app.
useAuth exposes user, login, logout, getIdToken."
```

---

### Task 4: API Client — Add Bearer Token

**Files:**
- Modify: `web/src/lib/api.ts`

- [ ] **Step 1: Update api.ts with auth-aware fetcher**

Replace the entire contents of `web/src/lib/api.ts`:

```typescript
import useSWR, { SWRResponse } from "swr";
import type {
  MeetingListResponse,
  MeetingDetail,
  TranscriptResponse,
  ActionItem,
  ActionItemListResponse,
  ActionItemUpdate,
} from "@/types";

// --- Token injection ---

let _getIdToken: (() => Promise<string>) | null = null;

/**
 * Register the token provider. Called once from AuthGuard
 * after MSAL is initialized.
 */
export function setTokenProvider(fn: () => Promise<string>) {
  _getIdToken = fn;
}

async function authHeaders(): Promise<Record<string, string>> {
  if (!_getIdToken) return {};
  try {
    const token = await _getIdToken();
    return { Authorization: `Bearer ${token}` };
  } catch {
    return {};
  }
}

// --- Fetcher ---

const fetcher = async (url: string) => {
  const headers = await authHeaders();
  const r = await fetch(url, { headers });
  if (!r.ok) {
    if (r.status === 401) {
      window.location.href = "/login";
      throw new Error("Unauthorized");
    }
    throw new Error(`API error: ${r.status}`);
  }
  return r.json();
};

// --- SWR Hooks ---

export function useMeetings(
  page = 1,
  perPage = 20,
  status?: string
): SWRResponse<MeetingListResponse> {
  const params = new URLSearchParams({
    page: String(page),
    per_page: String(perPage),
  });
  if (status) params.set("status", status);
  return useSWR(`/api/meetings?${params}`, fetcher);
}

export function useMeeting(id: number): SWRResponse<MeetingDetail> {
  return useSWR(`/api/meetings/${id}`, fetcher);
}

export function useTranscript(id: number): SWRResponse<TranscriptResponse> {
  return useSWR(`/api/meetings/${id}/transcript`, fetcher);
}

export function useMeetingActionItems(id: number): SWRResponse<ActionItem[]> {
  return useSWR(`/api/meetings/${id}/action-items`, fetcher);
}

export function useActionItems(
  page = 1,
  perPage = 20,
  status?: string
): SWRResponse<ActionItemListResponse> {
  const params = new URLSearchParams({
    page: String(page),
    per_page: String(perPage),
  });
  if (status) params.set("status", status);
  return useSWR(`/api/action-items?${params}`, fetcher);
}

// --- Mutations ---

export async function updateActionItem(
  id: number,
  update: ActionItemUpdate
): Promise<ActionItem> {
  const headers = await authHeaders();
  const res = await fetch(`/api/action-items/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(update),
  });
  if (!res.ok) throw new Error(`Failed to update action item: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/lib/api.ts
git commit -m "feat(auth): add Bearer token injection to API client

Fetcher and mutation functions now include Authorization header.
Token provider registered at runtime by AuthGuard."
```

---

### Task 5: AuthGuard & Route Group Restructure

**Files:**
- Create: `web/src/components/AuthGuard.tsx`
- Create: `web/src/app/(protected)/layout.tsx`
- Move: `web/src/app/page.tsx` → `web/src/app/(protected)/page.tsx`
- Move: `web/src/app/meetings/` → `web/src/app/(protected)/meetings/`
- Move: `web/src/app/action-items/` → `web/src/app/(protected)/action-items/`
- Modify: `web/src/app/layout.tsx`

- [ ] **Step 1: Create AuthGuard component**

Create `web/src/components/AuthGuard.tsx`:

```tsx
"use client";

import { ReactNode, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/useAuth";
import { setTokenProvider } from "@/lib/api";

export default function AuthGuard({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading, login, getIdToken } = useAuth();
  const router = useRouter();

  // Register token provider for API client
  useEffect(() => {
    if (isAuthenticated) {
      setTokenProvider(getIdToken);
    }
  }, [isAuthenticated, getIdToken]);

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace("/login");
    }
  }, [isLoading, isAuthenticated, router]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return <>{children}</>;
}
```

- [ ] **Step 2: Create (protected) route group directory and layout**

```bash
mkdir -p "C:/Projects/meeting-notetaker/web/src/app/(protected)"
```

Create `web/src/app/(protected)/layout.tsx`:

```tsx
import AuthGuard from "@/components/AuthGuard";
import Nav from "@/components/Nav";

export default function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      <Nav />
      <main className="flex-1 p-8 overflow-auto min-h-screen">{children}</main>
    </AuthGuard>
  );
}
```

- [ ] **Step 3: Move pages into (protected) route group**

```bash
cd C:/Projects/meeting-notetaker/web/src/app

# Move dashboard
mv page.tsx "(protected)/page.tsx"

# Move meetings
mv meetings/ "(protected)/meetings/"

# Move action-items
mv action-items/ "(protected)/action-items/"
```

Verify:
```bash
ls -la "C:/Projects/meeting-notetaker/web/src/app/(protected)/"
```
Expected: `layout.tsx`, `page.tsx`, `meetings/`, `action-items/`

- [ ] **Step 4: Update root layout.tsx**

Replace `web/src/app/layout.tsx` with:

```tsx
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import AuthProvider from "@/components/AuthProvider";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Meeting Note-Taker",
  description: "AI-powered meeting transcription and summarisation",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${inter.className} flex bg-gray-50`}>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
```

Key changes:
- Wrapped children with `AuthProvider` (MSAL needs to be present for login callback handling)
- Removed `Nav` and `<main>` wrapper (moved to protected layout)

- [ ] **Step 5: Commit**

```bash
git add web/src/components/AuthGuard.tsx "web/src/app/(protected)/" web/src/app/layout.tsx
git add -u  # pick up deleted files from moves
git commit -m "feat(auth): add AuthGuard and (protected) route group

AuthGuard redirects unauthenticated users to /login and registers
the token provider for API calls. All pages except /login are
inside the (protected) route group."
```

---

### Task 6: Login Page & Nav Updates

**Files:**
- Modify: `web/src/app/login/page.tsx`
- Modify: `web/src/components/Nav.tsx`

- [ ] **Step 1: Update login page**

Replace `web/src/app/login/page.tsx` with:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/useAuth";

export default function LoginPage() {
  const { isAuthenticated, isLoading, login } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  // If already authenticated, redirect to dashboard
  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace("/");
    }
  }, [isLoading, isAuthenticated, router]);

  const handleLogin = async () => {
    try {
      setError(null);
      await login();
    } catch (err) {
      setError("Sign-in failed. Please try again.");
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen w-full">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">
          Meeting Note-Taker
        </h1>
        <p className="text-gray-600 mb-6">
          Sign in with your Microsoft account to continue.
        </p>
        {error && (
          <p className="text-red-600 text-sm mb-4">{error}</p>
        )}
        <button
          onClick={handleLogin}
          disabled={isLoading}
          className="bg-blue-600 text-white px-6 py-2.5 rounded-md font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoading ? "Loading..." : "Sign in with Microsoft"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update Nav with user display and sign-out**

Replace `web/src/components/Nav.tsx` with:

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/useAuth";

const links = [
  { href: "/", label: "Meetings", icon: "📋" },
  { href: "/action-items", label: "Action Items", icon: "✅" },
];

export default function Nav() {
  const pathname = usePathname();
  const { user, logout } = useAuth();

  return (
    <nav className="w-56 bg-gray-900 text-gray-300 flex flex-col min-h-screen p-4">
      <div className="text-white font-bold text-lg mb-8 px-2">
        Meeting Notes
      </div>
      <ul className="space-y-1 flex-1">
        {links.map((link) => {
          const active =
            link.href === "/"
              ? pathname === "/"
              : pathname.startsWith(link.href);
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                  active
                    ? "bg-gray-800 text-white"
                    : "hover:bg-gray-800 hover:text-white"
                }`}
              >
                <span>{link.icon}</span>
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>

      {/* User info & sign out */}
      {user && (
        <div className="border-t border-gray-700 pt-4 mt-4">
          <div className="px-2 mb-3">
            <p className="text-sm text-white truncate">{user.name}</p>
            <p className="text-xs text-gray-400 truncate">{user.email}</p>
          </div>
          <button
            onClick={() => logout()}
            className="w-full text-left px-3 py-2 text-sm rounded-md hover:bg-gray-800 hover:text-white transition-colors"
          >
            Sign out
          </button>
        </div>
      )}
    </nav>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add web/src/app/login/page.tsx web/src/components/Nav.tsx
git commit -m "feat(auth): update login page and Nav with MSAL integration

Login page now triggers real Azure AD redirect.
Nav shows authenticated user name/email and sign-out button."
```

---

### Task 7: Manual End-to-End Verification

- [ ] **Step 1: Ensure backend is running with bypass OFF**

Verify `backend/.env.local` has `USE_DEV_AUTH_BYPASS=false`. Restart the FastAPI server:
```bash
cd C:/Projects/meeting-notetaker/backend
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

- [ ] **Step 2: Restart Next.js dev server**

```bash
cd C:/Projects/meeting-notetaker/web
npm run dev
```

- [ ] **Step 3: Test unauthenticated redirect**

Open `http://localhost:3000` in browser.
Expected: Redirected to `/login` page with "Sign in with Microsoft" button.

- [ ] **Step 4: Test login flow**

Click "Sign in with Microsoft".
Expected: Redirected to `login.microsoftonline.com`. Sign in with company Microsoft account. Redirected back to dashboard showing meetings.

- [ ] **Step 5: Test API calls work with auth**

Navigate to a meeting detail page (click a meeting).
Expected: Transcript, summary, and action items load. No 401 errors in browser console.

- [ ] **Step 6: Test Nav shows user info**

Expected: Nav sidebar shows your name and email at the bottom with a "Sign out" button.

- [ ] **Step 7: Test sign-out**

Click "Sign out" in the Nav.
Expected: Redirected to `/login`. Visiting `http://localhost:3000` redirects to `/login` again.

- [ ] **Step 8: Test dev bypass still works**

Set `USE_DEV_AUTH_BYPASS=true` in `backend/.env.local`, restart backend.
```bash
curl -s http://localhost:8000/api/meetings
```
Expected: Returns meeting list without auth token.

Set `USE_DEV_AUTH_BYPASS=false` again when done.

- [ ] **Step 9: Commit any fixes from verification**

If any issues were found and fixed during verification, commit them:
```bash
git add -u
git commit -m "fix(auth): address issues found during e2e verification"
```
