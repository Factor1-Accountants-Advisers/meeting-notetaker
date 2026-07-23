import { ipcMain } from 'electron'
import {
  acquireGraphTokenSilent,
  clearCurrentMsalAccount,
  getCurrentMsalAccountEmail,
  getCurrentMsalAccountName,
  getCurrentMsalAccountOid,
  getMsalConfigStatus,
  getPersistedCache,
  signInInteractively
} from './auth-msal'
import { logger } from './logger'
import { storageTokenAcquireOptions } from './storage-api-identity'

// Signed-in display name; sent as the audit actor on every backend call.
// Replaced by the Entra ID token subject once real auth lands.
let currentUser = 'Unknown user'
let currentUserEmail: string | undefined
let currentUserOid: string | undefined
let afterMsalSignIn: (() => void | Promise<void>) | undefined

export function onMsalSignedIn(callback: () => void | Promise<void>): void {
  afterMsalSignIn = callback
}

export function getCurrentUser(): string {
  // Silent cached sign-in never runs the interactive path that sets
  // currentUser, so fall back to the MSAL account's display name.
  if (currentUser === 'Unknown user') return getCurrentMsalAccountName() ?? currentUser
  return currentUser
}

export function getCurrentUserEmail(): string | undefined {
  return currentUserEmail ?? getCurrentMsalAccountEmail()
}

export function getCurrentUserOid(): string | undefined {
  return currentUserOid ?? getCurrentMsalAccountOid()
}

export async function getGraphAccessToken(scopes?: readonly string[]): Promise<string | null> {
  const status = getMsalConfigStatus()
  if (!status.configured) {
    logger().info('[auth] Graph token unavailable: MSAL public-client config missing', {
      missing: status.missing
    })
    return null
  }

  const result = await acquireGraphTokenSilent(scopes)
  if (result.accountEmail) currentUserEmail = result.accountEmail
  if (result.accountOid) currentUserOid = result.accountOid
  if (result.accountName && currentUser === 'Unknown user') currentUser = result.accountName
  if (!result.accessToken) {
    logger().info('[auth] Graph token unavailable', { reason: result.reason })
    return null
  }

  logger().info('[auth] Graph token acquired', { accountKnown: Boolean(result.accountEmail) })
  return result.accessToken
}

/** Delegated Storage API token for enrolment routes (IN-379/IN-471).
 *  Callers pass the MN_STORAGE_API_SCOPE value; absent scope = stub mode, no token. */
export async function getStorageApiAccessToken(scope: string): Promise<string | null> {
  const status = getMsalConfigStatus()
  if (!status.configured) {
    logger().info('[auth] Storage API token unavailable: MSAL public-client config missing', {
      missing: status.missing
    })
    return null
  }

  // Force a refresh for this custom resource. Entra token version is controlled
  // by the API registration, so a cached token can retain an obsolete issuer
  // after a provisioning correction even though the requested scope matches.
  const options = storageTokenAcquireOptions(scope)
  const result = await acquireGraphTokenSilent(options.scopes, process.env, options.forceRefresh)
  if (result.accountEmail) currentUserEmail = result.accountEmail
  if (result.accountOid) currentUserOid = result.accountOid
  if (result.accountName && currentUser === 'Unknown user') currentUser = result.accountName
  if (!result.accessToken) {
    logger().info('[auth] Storage API token unavailable', { reason: result.reason })
    return null
  }

  logger().info('[auth] Storage API token acquired', { accountKnown: Boolean(result.accountEmail) })
  return result.accessToken
}

export function getSignedInState(): { signedIn: boolean; email?: string; name?: string } {
  if (currentUser !== 'Unknown user') return { signedIn: true, email: currentUserEmail, name: currentUser }
  // On cold start, check whether a persisted cache exists so the renderer can skip the login
  // screen without a fresh interactive sign-in.
  const hasCache = Boolean(getPersistedCache())
  return {
    signedIn: hasCache,
    email: currentUserEmail ?? getCurrentMsalAccountEmail(),
    name: hasCache ? (getCurrentMsalAccountName() ?? currentUser) : undefined
  }
}

export function registerAuthSessionIpc(): void {
  ipcMain.on('auth:set-user', (_event, name: string) => {
    currentUser = name || 'Unknown user'
    currentUserEmail = undefined
    currentUserOid = undefined
    if (currentUser === 'Unknown user') clearCurrentMsalAccount()
    logger().info('[auth] actor updated', { actorKnown: currentUser !== 'Unknown user' })
  })

  ipcMain.handle('auth:sign-in', async () => {
    logger().info('[auth] sign-in requested')

    const status = getMsalConfigStatus()
    if (!status.configured) {
      logger().info('[auth] sign-in falling back: MSAL config missing')
      return { ok: false, error: 'MSAL config missing' }
    }

    const result = await signInInteractively()
    if (!result.ok) {
      logger().info('[auth] sign-in failed', { error: result.error })
      return result
    }

    currentUser = result.name ?? 'Unknown user'
    currentUserEmail = result.email
    currentUserOid = result.oid
    if (currentUser !== 'Unknown user') {
      logger().info('[auth] actor updated via MSAL sign-in', {
        nameKnown: Boolean(result.name),
        emailKnown: Boolean(result.email)
      })
    }
    if (afterMsalSignIn) {
      void Promise.resolve(afterMsalSignIn()).catch((err) => {
        logger().warn('[auth] post-sign-in hook failed', {
          message: err instanceof Error ? err.message : String(err)
        })
      })
    }
    return result
  })

  ipcMain.handle('auth:sign-out', async () => {
    logger().info('[auth] sign-out requested')
    currentUser = 'Unknown user'
    currentUserEmail = undefined
    currentUserOid = undefined
    clearCurrentMsalAccount()
    return { ok: true }
  })

  ipcMain.handle('auth:status', () => getSignedInState())
}
