import { PublicClientApplication, AccountInfo, LogLevel } from '@azure/msal-node';
import { app, safeStorage, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

function getCacheFile(): string {
  return path.join(app.getPath('userData'), 'msal-cache.enc');
}

// Graph API scopes for calendar access
const GRAPH_SCOPES = [
  'https://graph.microsoft.com/Calendars.Read',
  'https://graph.microsoft.com/User.Read',
];

// ID token scopes for web app authentication
const ID_SCOPES = ['openid', 'profile', 'User.Read'];

// All scopes requested together during sign-in so subsequent silent
// acquisitions for either scope set work from the same refresh token
const ALL_SCOPES = [
  'openid', 'profile', 'offline_access',
  'https://graph.microsoft.com/Calendars.Read',
  'https://graph.microsoft.com/User.Read',
];

function buildPca(): PublicClientApplication {
  const clientId = process.env.AZURE_AD_CLIENT_ID;
  const tenantId = process.env.AZURE_AD_TENANT_ID;
  if (!clientId || !tenantId) throw new Error('AZURE_AD_CLIENT_ID and AZURE_AD_TENANT_ID must be set');
  return new PublicClientApplication({
    auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}` },
    system: {
      loggerOptions: { loggerCallback: () => {}, piiLoggingEnabled: false, logLevel: LogLevel.Warning },
    },
  });
}

let _pca: PublicClientApplication | null = null;
function getPca(): PublicClientApplication {
  if (!_pca) _pca = buildPca();
  return _pca;
}

function canEncrypt(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function loadCache(pca: PublicClientApplication): void {
  try {
    if (!canEncrypt()) return;
    if (!fs.existsSync(getCacheFile())) return;
    const encrypted = fs.readFileSync(getCacheFile());
    const data = safeStorage.decryptString(encrypted);
    pca.getTokenCache().deserialize(data);
  } catch {
    // Cache corrupt or unreadable — start fresh
  }
}

function saveCache(pca: PublicClientApplication): void {
  try {
    if (!canEncrypt()) return;
    const serialized = pca.getTokenCache().serialize();
    const encrypted = safeStorage.encryptString(serialized);
    fs.writeFileSync(getCacheFile(), encrypted);
  } catch (err) {
    console.warn('[auth] Failed to persist token cache:', err);
  }
}

function isJwtExpiredOrNearExpiry(token: string, skewSeconds = 300): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number };
    if (!payload.exp) return false;
    return payload.exp <= Math.floor(Date.now() / 1000) + skewSeconds;
  } catch {
    // If the token shape is unexpected, let backend validation be the source of truth.
    return false;
  }
}

/**
 * Silent-only Graph API token. Throws immediately if no accounts are cached.
 * Used by the scheduler and calendar IPC — never blocks on interactive flow.
 */
export async function acquireToken(): Promise<string> {
  const pca = getPca();
  loadCache(pca);
  const accounts = await pca.getTokenCache().getAllAccounts();
  if (accounts.length === 0) throw new Error('[auth] No cached accounts — sign in first');

  const result = await pca.acquireTokenSilent({ account: accounts[0] as AccountInfo, scopes: GRAPH_SCOPES });
  if (!result?.accessToken) throw new Error('[auth] Silent token returned no accessToken');
  saveCache(pca);
  return result.accessToken;
}

/**
 * Silent-only ID token. Throws immediately if no accounts are cached.
 * Used for the initial auth check on app load — never blocks on interactive flow.
 */
export async function acquireIdToken(): Promise<string> {
  const pca = getPca();
  loadCache(pca);
  const accounts = await pca.getTokenCache().getAllAccounts();
  if (accounts.length === 0) throw new Error('[auth] No cached accounts — sign in first');

  const account = accounts[0] as AccountInfo;
  let result = await pca.acquireTokenSilent({ account, scopes: ID_SCOPES });
  if (result?.idToken && !isJwtExpiredOrNearExpiry(result.idToken)) {
    saveCache(pca);
    return result.idToken;
  }

  console.warn('[auth] Cached ID token is expired or near expiry; forcing refresh');
  result = await pca.acquireTokenSilent({ account, scopes: ID_SCOPES, forceRefresh: true });
  if (!result?.idToken) throw new Error('[auth] Silent token returned no idToken');
  if (isJwtExpiredOrNearExpiry(result.idToken)) throw new Error('[auth] Silent token returned expired idToken');
  saveCache(pca);
  return result.idToken;
}

/**
 * Interactive sign-in via the system browser.
 * MSAL spins up a localhost loopback server, opens the browser to the Azure AD
 * authorize endpoint, and waits for the redirect with the auth code.
 * Requests all scopes at once so both acquireToken() and acquireIdToken()
 * can be satisfied silently afterward from the same refresh token.
 */
export async function signIn(): Promise<string> {
  const pca = getPca();
  loadCache(pca);

  // Try silent first in case tokens are already cached
  const accounts = await pca.getTokenCache().getAllAccounts();
  if (accounts.length > 0) {
    try {
      return await acquireIdToken();
    } catch { /* fall through to interactive */ }
  }

  const result = await pca.acquireTokenInteractive({
    scopes: ALL_SCOPES,
    openBrowser: async (url) => {
      console.log('[auth] Opening system browser for sign-in...');
      await shell.openExternal(url);
    },
    successTemplate: '<html><body><h1>Sign-in successful</h1><p>You can close this tab and return to Meeting Note-Taker.</p></body></html>',
    errorTemplate: '<html><body><h1>Sign-in failed</h1><p>Error: {{error}}. Close this tab and try again from the app.</p></body></html>',
  });

  if (!result?.idToken) throw new Error('[auth] Sign-in failed — no idToken returned');
  saveCache(pca);
  return result.idToken;
}

export async function clearTokenCache(): Promise<void> {
  try { fs.unlinkSync(getCacheFile()); } catch { /* ignore */ }
  _pca = null;
}
