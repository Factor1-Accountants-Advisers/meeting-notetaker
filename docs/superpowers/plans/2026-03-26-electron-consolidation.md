# Electron Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the Next.js web app into the Electron desktop app so users run a single app with a single sign-in — no separate browser-based web app.

**Architecture:** Next.js builds to a static export (`output: 'export'`). In production, Electron's main `BrowserWindow` loads the static HTML from disk (`file://`). In dev, it loads `http://localhost:3000` for hot reload. Auth is unified: the Electron main process handles MSAL token acquisition (device code flow via `safeStorage`-cached tokens), and the renderer gets tokens via IPC — eliminating `@azure/msal-browser` entirely. API calls from the renderer are intercepted by the main process and proxied to the backend (replacing Next.js `rewrites()`).

**Tech Stack:** Electron 29, Next.js 14 (static export), TypeScript 5, `@azure/msal-node` 2.x, SWR, Tailwind CSS

---

## Scope Check

This is a single self-contained deliverable: merging the web UI into the Electron shell. It depends on Step 9 (desktop agent) being complete.

---

## Key Design Decisions

### Auth: IPC-based token flow (not msal-browser)

The web app currently uses `@azure/msal-browser` with redirect flow. This won't work in Electron's `file://` context (no redirect URI). Instead:

- Electron main process already has `auth.ts` with `acquireToken()` (device code → `safeStorage` cache)
- **Two token types are needed:** (1) an **id token** for backend API auth (what the web app currently sends), and (2) a **Graph access token** for calendar queries. The existing `acquireToken()` returns an access token. We add a new `acquireIdToken()` function that requests `openid profile` scopes and returns the id token from the result.
- The renderer calls `window.electronAPI.getToken()` via IPC to get an **id token** for API auth
- `api.ts` in the web app is modified to use this IPC token provider instead of MSAL
- `AuthProvider`, `msal-config.ts`, `useAuth.ts`, and `@azure/msal-browser`/`@azure/msal-react` are removed from the renderer entirely
- User info (name, email) is decoded from the id token JWT payload in the renderer

### API Routing: Electron protocol intercept

The web app fetches `/api/meetings`, `/api/action-items`, etc. In the browser, Next.js `rewrites()` proxied these to `http://localhost:8000`. In Electron:

- Register a custom `app://` protocol in the main process
- Load the static export via `app://renderer/index.html` (not `file://`)
- Intercept requests matching `/api/*` in the custom protocol handler and proxy them to the backend URL
- This is transparent to the renderer — SWR hooks keep fetching `/api/*` as before

### Static Export Adjustments

- `next.config.mjs`: add `output: 'export'` but **keep `rewrites()`** — `output: 'export'` silently ignores `rewrites()` at build time, but they still work in dev mode (`next dev`) for API proxying
- Remove `next/font/google` (no network at build time in CI) — use system font or local font file
- Remove `export const metadata` from `layout.tsx` (static export supports it, but we set `<title>` in Electron)
- The `[id]` dynamic route works because it uses client-side `useParams()` — but static export needs `generateStaticParams` or we switch to hash-based routing. **Solution:** use optional catch-all `[[...id]]` since meeting IDs are dynamic and unknown at build time.

---

## File Structure

```
web/
├── src/
│   ├── app/
│   │   ├── layout.tsx              # MODIFY: remove google font, add electron bridge check
│   │   ├── (protected)/
│   │   │   ├── layout.tsx          # MODIFY: swap AuthGuard for ElectronAuthGuard
│   │   │   └── ... (pages unchanged)
│   │   └── login/page.tsx          # MODIFY: show device-code instructions instead of MSAL redirect
│   ├── components/
│   │   ├── AuthProvider.tsx        # MODIFY: replace MSAL with IPC-based auth context
│   │   ├── AuthGuard.tsx           # MODIFY: use IPC token check instead of MSAL
│   │   └── Nav.tsx                 # NO CHANGE: already uses useAuth() which is rewritten transparently
│   ├── lib/
│   │   ├── api.ts                  # MODIFY: token provider uses IPC
│   │   ├── electron-bridge.ts      # CREATE: contextBridge type-safe wrapper
│   │   ├── msal-config.ts          # DELETE
│   │   └── useAuth.ts              # MODIFY: rewrite to use IPC
│   └── types/
│       └── index.ts                # unchanged
├── next.config.mjs                 # MODIFY: add output: 'export'
└── package.json                    # MODIFY: remove msal-browser, msal-react

desktop/
├── src/
│   ├── main/
│   │   ├── index.ts                # MODIFY: create main BrowserWindow (dev vs prod loading)
│   │   ├── ipc.ts                  # MODIFY: add auth + API proxy IPC handlers for renderer
│   │   ├── protocol.ts             # CREATE: custom app:// protocol for serving static files
│   │   ├── auth.ts                 # MODIFY: add acquireIdToken() for renderer API auth
│   │   ├── tray.ts                 # MODIFY: "Open App" opens main window instead of external browser
│   │   └── ... (graph, recorder, uploader unchanged)
│   └── renderer/
│       └── preload-web.ts          # CREATE: contextBridge for web app (auth, API, app info)
├── package.json                    # MODIFY: add build script for web + electron
└── ... (existing files unchanged)
```

**Responsibility boundaries (new/modified):**
- `protocol.ts` — custom Electron protocol. Serves static files from `web/out/`. Intercepts `/api/*` and proxies to backend. No business logic.
- `preload-web.ts` — contextBridge for the main BrowserWindow (not the meeting-selector popup). Exposes `getToken`, `signOut`, `getBackendUrl`, `getAppVersion`.
- `electron-bridge.ts` — type-safe wrapper around `window.electronAPI`. Provides fallback for when the web app runs in a regular browser (dev without Electron).

---

## Task 1: Next.js Static Export Config

**Files:**
- Modify: `web/next.config.mjs`
- Modify: `web/src/app/layout.tsx`

- [ ] **Step 1: Update `next.config.mjs` for static export**

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  // rewrites() is silently ignored by `next build` with output: 'export',
  // but still works in `next dev` for local API proxying.
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:8000/api/:path*",
      },
    ];
  },
};

export default nextConfig;
```

- [ ] **Step 2: Remove Google Font from `layout.tsx`**

Replace the `Inter` import from `next/font/google` with a system font stack. Google Font fetches require network at build time and add complexity in offline Electron.

```tsx
import type { Metadata } from "next";
import "./globals.css";
import AuthProvider from "@/components/AuthProvider";

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
      <body className="flex bg-gray-50 font-sans">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
```

Update `tailwind.config.ts` to use system font stack in `fontFamily.sans`:

```ts
fontFamily: {
  sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif'],
},
```

- [ ] **Step 3: Test static export builds**

```bash
cd C:/Projects/meeting-notetaker/web
npx next build
```

Expected: `out/` directory created with static HTML/JS/CSS. If there are errors about dynamic routes, we'll handle them in Task 2.

- [ ] **Step 4: Commit**

```bash
git add web/next.config.mjs web/src/app/layout.tsx web/tailwind.config.ts
git commit -m "feat(web): configure static export and remove Google Font dependency"
```

---

## Task 2: Handle Dynamic Route for Static Export

**Files:**
- Modify: `web/src/app/(protected)/meetings/[id]/page.tsx`

Static export with dynamic routes requires either `generateStaticParams` (which we can't use since meeting IDs aren't known at build time) or a different approach.

**Solution:** Convert the `[id]` route to use a query parameter via a catch-all or simply make it work with `trailingSlash` and client-side routing. Since the app is fully client-rendered, the simplest approach is to make the meeting detail page a single static page that reads the ID from the URL at runtime.

- [ ] **Step 1: Convert dynamic route to catch-all**

Rename `web/src/app/(protected)/meetings/[id]/page.tsx` to `web/src/app/(protected)/meetings/[[...id]]/page.tsx` (optional catch-all).

This generates a single static page at `/meetings/` that handles all sub-paths client-side.

- [ ] **Step 2: Verify the page still reads `id` correctly**

The page already uses `useParams()` which works with catch-all segments:

```tsx
const { id } = useParams<{ id: string[] | string }>();
const meetingId = Array.isArray(id) ? id[0] : id;
```

Update the component to handle the array form:

```tsx
"use client";

import { useState, useRef } from "react";
import { useParams } from "next/navigation";
import { useMeeting } from "@/lib/api";
import MeetingHeader from "@/components/MeetingHeader";
import AudioPlayer, { type AudioPlayerHandle } from "@/components/AudioPlayer";
import TranscriptView from "@/components/TranscriptView";
import SummaryView from "@/components/SummaryView";
import ActionItemsTable from "@/components/ActionItemsTable";

type Tab = "transcript" | "summary" | "actions";

const tabs: { key: Tab; label: string }[] = [
  { key: "transcript", label: "Transcript" },
  { key: "summary", label: "Summary" },
  { key: "actions", label: "Action Items" },
];

export default function MeetingDetailPage() {
  const params = useParams<{ id: string[] | string }>();
  const rawId = params?.id;
  const meetingId = Array.isArray(rawId) ? rawId[0] : rawId;
  const { data: meeting, error, isLoading } = useMeeting(Number(meetingId));
  const [activeTab, setActiveTab] = useState<Tab>("transcript");
  const audioRef = useRef<AudioPlayerHandle>(null);

  if (!meetingId) return <div className="text-gray-500">No meeting selected.</div>;
  if (isLoading) return <div className="text-gray-500">Loading meeting...</div>;
  if (error || !meeting) return <div className="text-red-600">Meeting not found.</div>;

  return (
    <div>
      <MeetingHeader meeting={meeting} />
      <AudioPlayer ref={audioRef} src={meeting.audio_url} />

      {/* Tabs */}
      <div className="mt-6 border-b border-gray-200">
        <nav className="flex gap-6">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {tab.label}
              {tab.key === "actions" && meeting.action_items.length > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center px-1.5 py-0.5 rounded-full text-xs bg-gray-100 text-gray-600">
                  {meeting.action_items.length}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      <div className="mt-6">
        {activeTab === "transcript" && (
          <TranscriptView
            segments={meeting.transcript?.segments ?? []}
            onSeek={(s) => audioRef.current?.seekTo(s)}
          />
        )}
        {activeTab === "summary" && <SummaryView summary={meeting.summary} />}
        {activeTab === "actions" && (
          <ActionItemsTable items={meeting.action_items} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Rebuild static export**

```bash
cd C:/Projects/meeting-notetaker/web
npx next build
```

Expected: builds successfully with `out/` containing the meetings page.

- [ ] **Step 4: Commit**

```bash
git add web/src/app/\(protected\)/meetings/
git commit -m "feat(web): convert meeting detail to optional catch-all for static export"
```

---

## Task 3: Auth Module Update + Electron Bridge + Preload Script

**Files:**
- Modify: `desktop/src/main/auth.ts`
- Create: `web/src/lib/electron-bridge.ts`
- Create: `desktop/src/renderer/preload-web.ts`

- [ ] **Step 1: Add `acquireIdToken()` to `desktop/src/main/auth.ts`**

The existing `acquireToken()` returns a Graph **access token** (scoped to `Calendars.Read`, `User.Read`). Access tokens for Microsoft Graph are opaque and may lack user claims. The web app's backend expects an **id token** for API auth. Add a new function that requests `openid profile` scopes to get an id token:

Add after the existing `acquireToken()` function:

```ts
const ID_SCOPES = ['openid', 'profile', 'User.Read'];

export async function acquireIdToken(): Promise<string> {
  const pca = getPca();
  loadCache(pca);
  const accounts = await pca.getTokenCache().getAllAccounts();

  if (accounts.length > 0) {
    try {
      const result = await pca.acquireTokenSilent({ account: accounts[0] as AccountInfo, scopes: ID_SCOPES });
      if (result?.idToken) { saveCache(pca); return result.idToken; }
    } catch { /* fall through */ }
  }

  const result = await pca.acquireTokenByDeviceCode({
    scopes: ID_SCOPES,
    deviceCodeCallback: (r) => console.log(r.message),
  });
  if (!result?.idToken) throw new Error('Id token acquisition failed');
  saveCache(pca);
  return result.idToken;
}
```

- [ ] **Step 2: Create the preload script for the main BrowserWindow**

Create `desktop/src/renderer/preload-web.ts`:

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getToken: (): Promise<string> => ipcRenderer.invoke('auth:get-id-token'),
  signOut: (): Promise<void> => ipcRenderer.invoke('auth:sign-out'),
  getBackendUrl: (): Promise<string> => ipcRenderer.invoke('app:get-backend-url'),
  getAppVersion: (): string => ipcRenderer.sendSync('app:get-version'),
  isElectron: true,
});
```

Note: uses `'auth:get-id-token'` (not `'auth:get-token'`) to get the id token for API auth.

- [ ] **Step 2: Create the renderer-side bridge wrapper**

Create `web/src/lib/electron-bridge.ts`:

```ts
export interface ElectronAPI {
  getToken: () => Promise<string>;
  signOut: () => Promise<void>;
  getBackendUrl: () => Promise<string>;
  getAppVersion: () => string;
  isElectron: true;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

/**
 * Returns true when running inside Electron (preload-web.ts injected the bridge).
 * Returns false in a regular browser (dev server without Electron).
 */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI?.isElectron;
}

/**
 * Get the Electron API. Throws if not running in Electron.
 */
export function getElectronAPI(): ElectronAPI {
  if (!window.electronAPI) {
    throw new Error('electronAPI not available — not running in Electron');
  }
  return window.electronAPI;
}
```

- [ ] **Step 3: Commit**

```bash
git add desktop/src/renderer/preload-web.ts web/src/lib/electron-bridge.ts
git commit -m "feat: add Electron contextBridge preload and renderer-side bridge wrapper"
```

---

## Task 4: Rewrite Auth to Use IPC

**Files:**
- Modify: `web/src/lib/useAuth.ts`
- Modify: `web/src/components/AuthProvider.tsx`
- Modify: `web/src/components/AuthGuard.tsx`
- Modify: `web/src/app/login/page.tsx`
- Note: `web/src/components/Nav.tsx` needs NO changes — it uses `useAuth()` which is rewritten transparently
- Delete: `web/src/lib/msal-config.ts`
- Modify: `web/package.json` (remove `@azure/msal-browser`, `@azure/msal-react`)

This is the largest change. The web app's auth currently relies on `@azure/msal-browser` redirect flow. We replace it with IPC calls to the Electron main process.

- [ ] **Step 1: Rewrite `useAuth.ts` to use Electron IPC**

```ts
"use client";

import { useState, useCallback, useEffect } from "react";
import { isElectron, getElectronAPI } from "@/lib/electron-bridge";

export interface AuthUser {
  name: string;
  email: string;
}

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);

  // On mount, try to acquire a token to check if we're signed in
  useEffect(() => {
    if (!isElectron()) {
      setIsLoading(false);
      return;
    }

    const api = getElectronAPI();
    api.getToken()
      .then((token) => {
        // Decode the JWT payload to get user info (name, email)
        try {
          const payload = JSON.parse(atob(token.split('.')[1]));
          setUser({ name: payload.name ?? '', email: payload.preferred_username ?? payload.upn ?? '' });
        } catch {
          setUser({ name: 'User', email: '' });
        }
        setIsAuthenticated(true);
      })
      .catch(() => {
        setIsAuthenticated(false);
      })
      .finally(() => setIsLoading(false));
  }, []);

  const login = useCallback(async () => {
    if (!isElectron()) return;
    const api = getElectronAPI();
    try {
      const token = await api.getToken();
      const payload = JSON.parse(atob(token.split('.')[1]));
      setUser({ name: payload.name ?? '', email: payload.preferred_username ?? payload.upn ?? '' });
      setIsAuthenticated(true);
    } catch {
      setIsAuthenticated(false);
    }
  }, []);

  const logout = useCallback(async () => {
    if (!isElectron()) return;
    const api = getElectronAPI();
    await api.signOut();
    setUser(null);
    setIsAuthenticated(false);
  }, []);

  const getIdToken = useCallback(async (): Promise<string> => {
    if (!isElectron()) throw new Error("Not in Electron");
    return getElectronAPI().getToken();
  }, []);

  return { user, isAuthenticated, isLoading, login, logout, getIdToken };
}
```

- [ ] **Step 2: Simplify `AuthProvider.tsx`**

Remove all MSAL code. The provider now just passes children through (keeping the component for minimal diff).

```tsx
"use client";

import { ReactNode } from "react";

export default function AuthProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
```

- [ ] **Step 3: Update `AuthGuard.tsx` — use IPC auth**

```tsx
"use client";

import { ReactNode, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/useAuth";
import { setTokenProvider } from "@/lib/api";

export default function AuthGuard({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading, getIdToken } = useAuth();
  const router = useRouter();
  const tokenRegistered = useRef(false);

  if (isAuthenticated && !tokenRegistered.current) {
    setTokenProvider(getIdToken);
    tokenRegistered.current = true;
  }

  useEffect(() => {
    if (isAuthenticated) {
      setTokenProvider(getIdToken);
    }
  }, [isAuthenticated, getIdToken]);

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

  if (!isAuthenticated) return null;

  return <>{children}</>;
}
```

Note: `AuthGuard.tsx` barely changes — the `useAuth` hook abstraction already isolates the auth mechanism. Only the import of `useAuth` matters, and it stays the same.

- [ ] **Step 4: Update `login/page.tsx` — device code instructions**

The login page should trigger the device code flow and display the code/URL to the user.

```tsx
"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/useAuth";

export default function LoginPage() {
  const { login, isAuthenticated, isLoading } = useAuth();
  const [signingIn, setSigningIn] = useState(false);
  const router = useRouter();

  // Redirect to dashboard if already authenticated
  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace("/");
    }
  }, [isLoading, isAuthenticated, router]);

  if (isAuthenticated) {
    return null;
  }

  const handleLogin = async () => {
    setSigningIn(true);
    try {
      await login();
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-50">
      <div className="text-center max-w-md mx-auto p-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-4">Meeting Note-Taker</h1>
        <p className="text-gray-600 mb-8">Sign in with your organisation account to continue.</p>
        <button
          onClick={handleLogin}
          disabled={signingIn}
          className="bg-blue-600 text-white px-8 py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {signingIn ? "Signing in..." : "Sign in"}
        </button>
        {signingIn && (
          <p className="mt-4 text-sm text-gray-500">
            A device code prompt will appear in a separate window. Follow the instructions to complete sign-in.
          </p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Delete `msal-config.ts`**

```bash
rm web/src/lib/msal-config.ts
```

- [ ] **Step 6: Remove MSAL browser packages**

```bash
cd C:/Projects/meeting-notetaker/web
npm uninstall @azure/msal-browser @azure/msal-react
```

- [ ] **Step 7: Verify build**

```bash
cd C:/Projects/meeting-notetaker/web
npx next build
```

Expected: builds with zero errors.

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/useAuth.ts web/src/components/AuthProvider.tsx web/src/components/AuthGuard.tsx web/src/app/login/ web/package.json web/package-lock.json
git rm web/src/lib/msal-config.ts
git commit -m "feat(web): replace MSAL browser auth with Electron IPC-based token flow"
```

---

## Task 5: API Routing via Electron Protocol

**Files:**
- Create: `desktop/src/main/protocol.ts`
- Modify: `desktop/src/main/ipc.ts`
- Modify: `web/src/lib/api.ts`

The web app's SWR hooks fetch `/api/meetings`, etc. In Electron, we need to route these to the backend. We use a custom `app://` protocol that serves static files for the UI and proxies `/api/*` requests to the backend.

- [ ] **Step 1: Create `desktop/src/main/protocol.ts`**

```ts
import { protocol, net } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

let _registered = false;

export function registerAppProtocol(staticDir: string, backendUrl: string): void {
  // Guard: protocol can only be registered once
  if (_registered) return;
  _registered = true;

  protocol.handle('app', async (request) => {
    const url = new URL(request.url);

    // Proxy API requests to the backend
    if (url.pathname.startsWith('/api/')) {
      const backendTarget = `${backendUrl}${url.pathname}${url.search}`;
      return net.fetch(backendTarget, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
    }

    // Serve static files (async reads to avoid blocking main process)
    let filePath = path.join(staticDir, url.pathname);

    // SPA fallback: if file doesn't exist, serve index.html
    const exists = fsSync.existsSync(filePath);
    if (!exists || fsSync.statSync(filePath).isDirectory()) {
      if (fsSync.existsSync(filePath + '.html')) {
        filePath = filePath + '.html';
      } else if (fsSync.existsSync(path.join(filePath, 'index.html'))) {
        filePath = path.join(filePath, 'index.html');
      } else {
        filePath = path.join(staticDir, 'index.html');
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

    try {
      const data = await fs.readFile(filePath);
      return new Response(data, {
        headers: { 'Content-Type': mimeType },
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}
```

- [ ] **Step 2: Add IPC handlers for app metadata**

Add to `desktop/src/main/ipc.ts`:

```ts
import { acquireToken, acquireIdToken, clearTokenCache } from './auth';

// Inside registerIpcHandlers(), add these new handlers:
ipcMain.handle('auth:get-id-token', (): Promise<string> => acquireIdToken());
ipcMain.handle('app:get-backend-url', (): string => process.env.BACKEND_URL ?? 'http://localhost:8000');
ipcMain.on('app:get-version', (e): void => { e.returnValue = app.getVersion(); });
```

Note: the existing `auth:get-token` handler returns a Graph access token (for calendar). The new `auth:get-id-token` handler returns an id token (for backend API auth).

- [ ] **Step 3: Update `web/src/lib/api.ts` — add backend URL resolution**

The fetcher needs to use the full backend URL when running in Electron (since `/api/*` is intercepted by the protocol handler). Actually, the protocol handler transparently proxies `/api/*`, so no change needed here — relative URLs work.

However, for **audio file URLs** (e.g., `meeting.audio_url`), these may be absolute URLs pointing to the backend. No change needed in `api.ts` for now.

- [ ] **Step 4: Commit**

```bash
git add desktop/src/main/protocol.ts desktop/src/main/ipc.ts
git commit -m "feat(desktop): add app:// protocol handler with API proxying and SPA fallback"
```

---

## Task 6: Main Window — Load Web App in Electron

**Files:**
- Modify: `desktop/src/main/index.ts`
- Modify: `desktop/src/main/tray.ts`
- Modify: `desktop/tsconfig.renderer.json`

- [ ] **Step 1: Update `index.ts` to create the main BrowserWindow**

```ts
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { createTray } from './tray';
import { registerIpcHandlers } from './ipc';
import { registerAppProtocol } from './protocol';

if (!app.requestSingleInstanceLock()) app.quit();

app.disableHardwareAcceleration();

let mainWindow: BrowserWindow | null = null;
const backendUrl = process.env.BACKEND_URL ?? 'http://localhost:8000';

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Meeting Note-Taker',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../renderer/preload-web.js'),
    },
  });

  if (!app.isPackaged && process.env.WEB_DEV_URL) {
    // Dev mode: load from Next.js dev server
    win.loadURL(process.env.WEB_DEV_URL);
  } else {
    // Production: load from static export via custom protocol
    win.loadURL('app://renderer/index.html');
  }

  win.on('close', (e) => {
    // Hide instead of quit — tray keeps running
    e.preventDefault();
    win.hide();
  });

  return win;
}

export function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

app.on('window-all-closed', (e: Event) => e.preventDefault());

app.whenReady().then(() => {
  registerIpcHandlers();

  // Register protocol once, before any window is created
  if (app.isPackaged || !process.env.WEB_DEV_URL) {
    const staticDir = path.join(__dirname, '../../web-out');
    registerAppProtocol(staticDir, backendUrl);
  }

  // Pass showMainWindow into tray to avoid circular dependency
  createTray({
    backendUrl,
    recordingOutputDir: app.getPath('temp'),
    micName: process.env.MIC_DEVICE_NAME ?? '',
    loopbackName: process.env.LOOPBACK_DEVICE_NAME ?? '',
    onOpenApp: showMainWindow,
  });

  // Show main window on startup
  mainWindow = createMainWindow();

  if (app.isPackaged) {
    void autoUpdater.checkForUpdatesAndNotify();
    setInterval(() => void autoUpdater.checkForUpdatesAndNotify(), 4 * 3600000);
  }
});
```

- [ ] **Step 2: Update `tray.ts` — "Open App" shows main window**

Replace the `shell.openExternal(_webAppUrl)` menu item with one that shows the main window:

Change in `tray.ts`:
- Remove `_webAppUrl` from `TrayConfig` (no longer needed)
- Add `onOpenApp` callback to `TrayConfig` to avoid circular dependency with `index.ts`

Update `TrayConfig` interface:
```ts
export interface TrayConfig {
  backendUrl: string;
  recordingOutputDir: string;
  micName: string;
  loopbackName: string;
  onOpenApp: () => void;
}
```

Store the callback in a module-level variable and use it in the menu:
```ts
let _onOpenApp: () => void = () => {};

// In createTray():
_onOpenApp = config.onOpenApp;

// In rebuildMenu():
{ label: 'Open App', click: () => _onOpenApp() },
```

Remove the `shell` import (no longer needed for opening external URLs) and the `_webAppUrl` variable.

- [ ] **Step 3: Add `preload-web.ts` to renderer tsconfig**

Ensure `desktop/tsconfig.renderer.json` includes the new preload file. The existing `include: ["src/renderer/**/*"]` already covers it since `preload-web.ts` is under `src/renderer/`.

- [ ] **Step 4: Commit**

```bash
git add desktop/src/main/index.ts desktop/src/main/tray.ts
git commit -m "feat(desktop): load web app in main BrowserWindow with dev/prod mode"
```

---

## Task 7: Build Pipeline

**Files:**
- Modify: `desktop/package.json`

The build pipeline needs to:
1. Build the Next.js static export (`web/out/`)
2. Copy it to `desktop/web-out/`
3. Compile Electron TypeScript
4. Package with electron-builder

- [ ] **Step 1: Update `desktop/package.json` scripts**

```json
{
  "scripts": {
    "build:web": "cd ../web && npx next build && cd ../desktop && node -e \"require('fs').cpSync('../web/out', 'web-out', { recursive: true })\"",
    "build:electron": "tsc -p tsconfig.main.json && tsc -p tsconfig.renderer.json && node -e \"require('fs').cpSync('src/renderer/meeting-selector/index.html','dist/renderer/meeting-selector/index.html')\"",
    "build": "npm run build:web && npm run build:electron",
    "dev": "concurrently \"tsc -w -p tsconfig.main.json\" \"tsc -w -p tsconfig.renderer.json\" \"electron .\"",
    "pack": "npm run build && electron-builder --dir",
    "dist": "npm run build && electron-builder",
    "dist:win": "npm run build && electron-builder --win",
    "test": "jest"
  }
}
```

- [ ] **Step 2: Add `web-out/` to `.gitignore`**

```bash
echo "web-out/" >> C:/Projects/meeting-notetaker/desktop/.gitignore
```

- [ ] **Step 3: Add `web-out/` to electron-builder files**

Update `desktop/electron-builder.yml` to include `web-out`:

```yaml
files:
  - dist/**/*
  - web-out/**/*
  - assets/**/*
  - node_modules/**/*
  - package.json
```

- [ ] **Step 4: Test full build**

```bash
cd C:/Projects/meeting-notetaker/desktop
npm run build
```

Expected: `web-out/` contains the static site, `dist/` contains compiled Electron JS.

- [ ] **Step 5: Commit**

```bash
git add desktop/package.json desktop/electron-builder.yml desktop/.gitignore
git commit -m "feat(desktop): add unified build pipeline (web export + Electron compile)"
```

---

## Task 8: Dev Workflow Setup

**Files:**
- Modify: `desktop/package.json` (dev script)

- [ ] **Step 1: Update dev script for consolidated workflow**

The dev workflow runs the Next.js dev server alongside Electron:

```json
{
  "scripts": {
    "dev": "concurrently -n web,tsc-main,tsc-rend,electron \"cd ../web && npx next dev\" \"tsc -w -p tsconfig.main.json\" \"tsc -w -p tsconfig.renderer.json\" \"wait-on http://localhost:3000 && electron .\""
  }
}
```

- [ ] **Step 2: Install `wait-on`**

```bash
cd C:/Projects/meeting-notetaker/desktop
npm install --save-dev wait-on
```

- [ ] **Step 3: Add `WEB_DEV_URL` to `.env.local`**

Add to `desktop/.env.local`:
```
WEB_DEV_URL=http://localhost:3000
```

- [ ] **Step 4: Test dev workflow**

```bash
cd C:/Projects/meeting-notetaker/desktop
npm run dev
```

Expected: Next.js dev server starts on :3000, Electron waits for it, then opens a window loading the web app with hot reload.

- [ ] **Step 5: Commit**

```bash
git add desktop/package.json
git commit -m "feat(desktop): add consolidated dev workflow with Next.js hot reload"
```

---

## Task 9: Smoke Test

- [ ] **Step 1: Production build and launch**

```bash
cd C:/Projects/meeting-notetaker/desktop
npm run build && npx electron .
```

Expected: main window shows the login page (since no cached MSAL token exists).

- [ ] **Step 2: Verify auth flow**

Click "Sign in" → device code prompt appears in terminal → complete sign-in → dashboard shows with meeting list.

- [ ] **Step 3: Verify tray still works**

Right-click tray → "Open App" shows main window. "Start Recording" works. "Stop Recording" uploads.

- [ ] **Step 4: Verify API routing**

Dashboard loads meetings from `/api/meetings` → proxied to backend. Click a meeting → detail page loads transcript/summary.

- [ ] **Step 5: Commit any fixes**

```bash
git add -p && git commit -m "fix(desktop): smoke test fixes for electron consolidation"
```

---

## Task 10: Cleanup and Final Verification

- [ ] **Step 1: Run all desktop tests**

```bash
cd C:/Projects/meeting-notetaker/desktop
npx jest --no-coverage
```

Expected: All 12 tests pass (existing tests should still pass — auth, graph, recorder, uploader modules are unchanged).

- [ ] **Step 2: Run web lint**

```bash
cd C:/Projects/meeting-notetaker/web
npx next lint
```

Expected: no errors.

- [ ] **Step 3: TypeScript compile check**

```bash
cd C:/Projects/meeting-notetaker/desktop
npx tsc -p tsconfig.main.json --noEmit
npx tsc -p tsconfig.renderer.json --noEmit
```

Expected: zero errors.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: Electron consolidation complete — single app, single sign-in"
```

---

## Environment Variables Reference (Updated)

| Variable | Where | Purpose |
|---|---|---|
| `AZURE_AD_CLIENT_ID` | `desktop/.env.local` | MSAL app registration client ID |
| `AZURE_AD_TENANT_ID` | `desktop/.env.local` | Azure AD tenant ID |
| `BACKEND_URL` | `desktop/.env.local` | Backend API base URL (default: `http://localhost:8000`) |
| `WEB_DEV_URL` | `desktop/.env.local` | Next.js dev server URL (dev only, default: `http://localhost:3000`) |
| `MIC_DEVICE_NAME` | `desktop/.env.local` | Windows DirectShow microphone device name |
| `LOOPBACK_DEVICE_NAME` | `desktop/.env.local` | Windows DirectShow loopback device name |

**Removed:** `NEXT_PUBLIC_AZURE_AD_*` vars are no longer needed in `web/.env.local` — auth is handled by Electron main process.

---

## What Changes for Users

| Before | After |
|--------|-------|
| Open browser to `localhost:3000` + run desktop agent separately | Run one Electron app |
| Sign in twice (browser MSAL redirect + desktop device code) | Sign in once (device code only) |
| Two separate processes | One process (tray + main window) |
| Browser tab can be accidentally closed | App window hides to tray on close |
