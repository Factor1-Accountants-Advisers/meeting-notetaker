import { PublicClientApplication, AccountInfo, LogLevel } from '@azure/msal-node';
import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const CACHE_FILE = path.join(app.getPath('userData'), 'msal-cache.enc');
const SCOPES = [
  'https://graph.microsoft.com/Calendars.Read',
  'https://graph.microsoft.com/User.Read',
];
const ID_SCOPES = ['openid', 'profile', 'User.Read'];

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

function loadCache(pca: PublicClientApplication): void {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const encrypted = fs.readFileSync(CACHE_FILE);
    const data = safeStorage.decryptString(encrypted);
    pca.getTokenCache().deserialize(data);
  } catch {
    // Cache corrupt or unreadable — start fresh
  }
}

function saveCache(pca: PublicClientApplication): void {
  const serialized = pca.getTokenCache().serialize();
  const encrypted = safeStorage.encryptString(serialized);
  fs.writeFileSync(CACHE_FILE, encrypted);
}

export async function acquireToken(): Promise<string> {
  const pca = getPca();
  loadCache(pca);
  const accounts = await pca.getTokenCache().getAllAccounts();

  if (accounts.length > 0) {
    try {
      const result = await pca.acquireTokenSilent({ account: accounts[0] as AccountInfo, scopes: SCOPES });
      if (result?.accessToken) {
        saveCache(pca);
        return result.accessToken;
      }
      console.warn('[auth] silent token resolved but returned no accessToken; falling back to device code');
    } catch (err) {
      console.warn('[auth] silent acquisition failed, falling back to device code:', err);
    }
  }

  const result = await pca.acquireTokenByDeviceCode({
    scopes: SCOPES,
    deviceCodeCallback: (r) => console.log(r.message),
  });
  if (!result?.accessToken) throw new Error('Token acquisition failed');
  saveCache(pca);
  return result.accessToken;
}

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

export async function clearTokenCache(): Promise<void> {
  try { fs.unlinkSync(CACHE_FILE); } catch { /* ignore */ }
  _pca = null;
}
