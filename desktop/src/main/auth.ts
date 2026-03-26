import { PublicClientApplication, AccountInfo, LogLevel } from '@azure/msal-node';
import * as keytar from 'keytar';

const SERVICE = 'MeetingNoteTaker';
const ACCOUNT = 'msal-cache';
const SCOPES = [
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

async function loadCache(pca: PublicClientApplication): Promise<void> {
  const data = await keytar.getPassword(SERVICE, ACCOUNT);
  if (data) await pca.getTokenCache().deserialize(data);
}

async function saveCache(pca: PublicClientApplication): Promise<void> {
  await keytar.setPassword(SERVICE, ACCOUNT, await pca.getTokenCache().serialize());
}

export async function acquireToken(): Promise<string> {
  const pca = getPca();
  await loadCache(pca);
  const accounts = await pca.getTokenCache().getAllAccounts();

  if (accounts.length > 0) {
    try {
      const result = await pca.acquireTokenSilent({ account: accounts[0] as AccountInfo, scopes: SCOPES });
      if (result?.accessToken) {
        await saveCache(pca);
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
  await saveCache(pca);
  return result.accessToken;
}

export async function clearTokenCache(): Promise<void> {
  await keytar.deletePassword(SERVICE, ACCOUNT);
  _pca = null;
}
