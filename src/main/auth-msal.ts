import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
  type Configuration
} from '@azure/msal-node'

export const GRAPH_DETECTION_SCOPES = ['User.Read', 'Calendars.Read'] as const

export interface MsalPublicClientConfig {
  clientId: string
  tenantId: string
  authority: string
}

export interface MsalConfigStatus {
  configured: boolean
  missing: string[]
  config?: MsalPublicClientConfig
}

export interface MsalTokenResult {
  accessToken: string | null
  accountEmail?: string
  reason?: 'missing_config' | 'no_cached_account' | 'interaction_required' | 'error'
  errorMessage?: string
}

let cachedApp: PublicClientApplication | null = null
let cachedConfigKey: string | null = null
let currentAccount: AccountInfo | null = null

export function getMsalConfigStatus(env: NodeJS.ProcessEnv = process.env): MsalConfigStatus {
  const clientId = env.MN_ENTRA_CLIENT_ID ?? env.AZURE_AD_CLIENT_ID
  const tenantId = env.MN_ENTRA_TENANT_ID ?? env.AZURE_AD_TENANT_ID
  const missing = [
    ...(clientId ? [] : ['MN_ENTRA_CLIENT_ID']),
    ...(tenantId ? [] : ['MN_ENTRA_TENANT_ID'])
  ]

  if (!clientId || !tenantId) return { configured: false, missing }

  return {
    configured: true,
    missing: [],
    config: {
      clientId,
      tenantId,
      authority: `https://login.microsoftonline.com/${tenantId}`
    }
  }
}

export async function acquireGraphTokenSilent(
  scopes: readonly string[] = GRAPH_DETECTION_SCOPES,
  env: NodeJS.ProcessEnv = process.env
): Promise<MsalTokenResult> {
  const status = getMsalConfigStatus(env)
  if (!status.configured || !status.config) return { accessToken: null, reason: 'missing_config' }

  try {
    const app = getPublicClientApplication(status.config)
    const account = currentAccount ?? (await getFirstCachedAccount(app))
    if (!account) return { accessToken: null, reason: 'no_cached_account' }

    const result = await app.acquireTokenSilent({ account, scopes: [...scopes] })
    currentAccount = result?.account ?? account
    return toTokenResult(result)
  } catch (err) {
    if (err instanceof InteractionRequiredAuthError) {
      return { accessToken: null, reason: 'interaction_required' }
    }
    return {
      accessToken: null,
      reason: 'error',
      errorMessage: err instanceof Error ? err.message : String(err)
    }
  }
}

export function getCurrentMsalAccountEmail(): string | undefined {
  return currentAccount?.username || currentAccount?.idTokenClaims?.preferred_username?.toString()
}

export function clearCurrentMsalAccount(): void {
  currentAccount = null
}

function getPublicClientApplication(config: MsalPublicClientConfig): PublicClientApplication {
  const key = `${config.tenantId}:${config.clientId}`
  if (cachedApp && cachedConfigKey === key) return cachedApp

  const msalConfig: Configuration = {
    auth: {
      clientId: config.clientId,
      authority: config.authority
    },
    system: {
      loggerOptions: {
        piiLoggingEnabled: false
      }
    }
  }

  cachedApp = new PublicClientApplication(msalConfig)
  cachedConfigKey = key
  currentAccount = null
  return cachedApp
}

async function getFirstCachedAccount(app: PublicClientApplication): Promise<AccountInfo | null> {
  const accounts = await app.getTokenCache().getAllAccounts()
  return accounts[0] ?? null
}

function toTokenResult(result: AuthenticationResult | null): MsalTokenResult {
  if (!result?.accessToken) return { accessToken: null, reason: 'interaction_required' }
  return {
    accessToken: result.accessToken,
    accountEmail: result.account?.username || result.account?.idTokenClaims?.preferred_username?.toString()
  }
}
