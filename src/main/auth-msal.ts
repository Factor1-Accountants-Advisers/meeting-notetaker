import { randomBytes, createHash } from 'crypto'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { execFile } from 'child_process'
import { app, shell } from 'electron'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { logger } from './logger'
import {
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
  type Configuration
} from '@azure/msal-node'

export const GRAPH_DETECTION_SCOPES = ['User.Read', 'Calendars.Read'] as const
export const GRAPH_EMAIL_SCOPES = ['User.Read', 'Mail.Send'] as const
export const GRAPH_SHAREPOINT_SCOPES = ['User.Read', 'Files.ReadWrite.All'] as const
const SIGN_IN_SCOPES = ['User.Read', 'Calendars.Read', 'Mail.Send', 'Files.ReadWrite.All'] as const

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

export interface MsalSignInResult {
  ok: boolean
  name?: string
  email?: string
  error?: string
}

let cachedApp: PublicClientApplication | null = null
let cachedConfigKey: string | null = null
let currentAccount: AccountInfo | null = null

// ---------------------------------------------------------------------------
// Token cache persistence (Slice 1 stand-in for encrypted OS keychain)
// ---------------------------------------------------------------------------

const CACHE_DIR = 'auth'
const CACHE_FILE = 'msal-cache.json'

function cachePath(): string {
  return join(app.getPath('userData'), CACHE_DIR, CACHE_FILE)
}

export function getPersistedCache(): string | null {
  try {
    return readFileSync(cachePath(), 'utf-8')
  } catch {
    return null
  }
}

export function persistTokenCache(serialized: string): void {
  const path = cachePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, serialized, 'utf-8')
}

export function clearPersistedCache(): void {
  try {
    unlinkSync(cachePath())
  } catch {
    // already absent or never written
  }
}

function restoreTokenCache(app: PublicClientApplication): void {
  const serialized = getPersistedCache()
  if (!serialized) return
  try {
    app.getTokenCache().deserialize(serialized)
  } catch {
    // stale or corrupt cache — discard and re-sign-in
    clearPersistedCache()
  }
}

async function saveTokenCache(app: PublicClientApplication): Promise<void> {
  const serialized = app.getTokenCache().serialize()
  persistTokenCache(serialized)
}

function usableEnvValue(value: string | undefined): string | undefined {
  if (!value || value === 'undefined' || value === 'null') return undefined
  return value
}

export function getMsalConfigStatus(env: NodeJS.ProcessEnv = process.env): MsalConfigStatus {
  const clientId = usableEnvValue(env.MN_ENTRA_CLIENT_ID) ?? usableEnvValue(env.AZURE_AD_CLIENT_ID)
  const tenantId = usableEnvValue(env.MN_ENTRA_TENANT_ID) ?? usableEnvValue(env.AZURE_AD_TENANT_ID)
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
    restoreTokenCache(app)
    const account = currentAccount ?? (await getFirstCachedAccount(app))
    if (!account) return { accessToken: null, reason: 'no_cached_account' }

    const result = await app.acquireTokenSilent({ account, scopes: [...scopes] })
    currentAccount = result?.account ?? account
    await saveTokenCache(app)
    return toTokenResult(result)
  } catch (err) {
    if (isInteractionRequired(err)) {
      return { accessToken: null, reason: 'interaction_required' }
    }
    return {
      accessToken: null,
      reason: 'error',
      errorMessage: err instanceof Error ? err.message : String(err)
    }
  }
}

export async function signInInteractively(): Promise<MsalSignInResult> {
  const status = getMsalConfigStatus()
  if (!status.configured || !status.config) {
    return { ok: false, error: 'MSAL public-client config missing' }
  }

  const app = getPublicClientApplication(status.config)
  restoreTokenCache(app)
  const { verifier, challenge } = generatePkceCodes()
  const state = randomBytes(16).toString('base64url')
  const redirectUri = await startAuthRedirectServer()

  try {
    const authCodeUrl = await app.getAuthCodeUrl({
      scopes: [...SIGN_IN_SCOPES],
      redirectUri,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      state
    })

    const code = await openBrowserAndWaitForCode(authCodeUrl, redirectUri, state)
    if (!code) return { ok: false, error: 'Sign-in was cancelled or timed out' }

    const result = await app.acquireTokenByCode({
      code,
      scopes: [...SIGN_IN_SCOPES],
      redirectUri,
      codeVerifier: verifier
    })

    if (!result) return { ok: false, error: 'Token acquisition returned no result' }

    currentAccount = result.account ?? null
    await saveTokenCache(app)
    const email = currentAccount?.username ||
      currentAccount?.idTokenClaims?.preferred_username?.toString()
    const name = currentAccount?.name ||
      currentAccount?.idTokenClaims?.name?.toString() ||
      email ||
      'Unknown user'

    return { ok: true, name, email }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

export function getCurrentMsalAccountEmail(): string | undefined {
  return currentAccount?.username || currentAccount?.idTokenClaims?.preferred_username?.toString()
}

export function clearCurrentMsalAccount(): void {
  currentAccount = null
  clearPersistedCache()
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
  restoreTokenCache(cachedApp)
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

function isInteractionRequired(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const errObj = err as Record<string, unknown>
  const name = errObj.name as string | undefined
  const code = errObj.errorCode as string | undefined
  return name === 'InteractionRequiredAuthError' ||
    code === 'interaction_required' ||
    code === 'consent_required' ||
    code === 'login_required'
}

function generatePkceCodes(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

function startAuthRedirectServer(): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer()
    // In WSL dev the browser runs on Windows, while this listener runs inside
    // WSL. Binding only to WSL 127.0.0.1 makes Windows Chrome land on
    // ERR_CONNECTION_REFUSED at localhost:<port>. Keep the redirect URI as
    // localhost for Entra loopback compatibility, but listen on all interfaces
    // so WSL localhost forwarding can deliver the callback.
    const isWsl = process.platform === 'linux' && Boolean(process.env.WSL_DISTRO_NAME)
    const host = isWsl ? '0.0.0.0' : '127.0.0.1'
    const requestedPort = Number(process.env.MN_ENTRA_REDIRECT_PORT ?? (isWsl ? 46623 : 0))
    const port = Number.isInteger(requestedPort) && requestedPort >= 0 ? requestedPort : 0
    // A fixed port can collide (abandoned prior sign-in, another process).
    // Without this handler the 'error' event is an uncaught exception that
    // kills the main process; fall back to an OS-assigned loopback port.
    server.once('error', (err) => {
      logger().warn('[auth] redirect listener failed; retrying on loopback', {
        message: err instanceof Error ? err.message : String(err)
      })
      server.listen(0, '127.0.0.1')
    })
    server.on('listening', () => {
      const actualPort = (server.address() as AddressInfo).port
      const redirectUri = `http://localhost:${actualPort}`
      // Store the server reference for the code capture
      activeAuthServer = { server, redirectUri }
      resolve(redirectUri)
    })
    server.listen(port, host)
  })
}

let activeAuthServer: { server: ReturnType<typeof createServer>; redirectUri: string } | null = null

function openBrowserAndWaitForCode(
  authUrl: string,
  redirectUri: string,
  expectedState: string,
  timeoutMs = 120_000
): Promise<string | null> {
  return new Promise((resolve) => {
    const server = activeAuthServer?.server
    if (!server || !activeAuthServer || activeAuthServer.redirectUri !== redirectUri) {
      resolve(null)
      return
    }

    const timeout = setTimeout(() => {
      server.close()
      activeAuthServer = null
      resolve(null)
    }, timeoutMs)

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', redirectUri)
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      const returnedState = url.searchParams.get('state')

      if (!code && !error) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Waiting for Microsoft sign-in callback')
        return
      }

      // Reject callbacks whose state does not match (CSRF protection).
      if (returnedState !== expectedState) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Sign-in state mismatch')
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(AUTH_RESPONSE_HTML)

      clearTimeout(timeout)
      server.close()
      activeAuthServer = null
      resolve(error ? null : code)
    })

    server.on('close', () => {
      clearTimeout(timeout)
      activeAuthServer = null
      if (timeout) resolve(null) // shouldn't double-resolve, but safe
    })

    // Open the system browser. In WSL dev, Electron's shell.openExternal may
    // resolve without opening a Windows browser, so prefer cmd.exe there.
    openAuthUrl(authUrl).catch(() => {
      clearTimeout(timeout)
      server.close()
      activeAuthServer = null
      resolve(null)
    })
  })
}

async function openAuthUrl(authUrl: string): Promise<void> {
  if (process.platform === 'linux' && process.env.WSL_DISTRO_NAME) {
    // Use PowerShell instead of `cmd.exe /c start`: OAuth URLs contain `&`,
    // which cmd treats as a command separator and truncates query parameters
    // like `scope`, causing AADSTS900144.
    const escapedAuthUrl = authUrl.replace(/'/g, "''")
    await execFileAsync('/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe', [
      '-NoProfile',
      '-Command',
      `Start-Process -FilePath '${escapedAuthUrl}'`
    ])
    return
  }

  await shell.openExternal(authUrl)
}

function execFileAsync(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

const AUTH_RESPONSE_HTML = [
  '<!doctype html>',
  '<html>',
  '<head><meta charset="utf-8"><title>Sign-in complete</title></head>',
  '<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#eee;text-align:center">',
  '  <p style="font-size:14px">Sign-in complete — you may close this window.</p>',
  '</body>',
  '</html>'
].join('\n')
