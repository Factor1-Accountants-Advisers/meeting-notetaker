import { ipcMain } from 'electron'
import {
  acquireGraphTokenSilent,
  cancelInteractiveSignIn,
  clearCurrentMsalAccount,
  getCurrentMsalAccountEmail,
  getCurrentMsalAccountName,
  getCurrentMsalAccountOid,
  getMsalConfigStatus,
  getPersistedCache,
  signInInteractively,
  type MsalSignInResult
} from './auth-msal'
import { isSignedIn, type SilentTokenFailure } from './auth-state'
import { logger } from './logger'
import {
  hasStorageAdminRole,
  isStorageApiEnabled,
  storageTokenAcquireOptions
} from './storage-api-identity'

// Signed-in display name; sent as the audit actor on every backend call.
// Replaced by the Entra ID token subject once real auth lands.
let currentUser = 'Unknown user'
let currentUserEmail: string | undefined
let currentUserOid: string | undefined
let afterMsalSignIn: (() => void | Promise<void>) | undefined
// Most recent Storage API silent-token outcome (FD-2265). Only the Storage
// path is tracked: it is the token the enrolment gate depends on, and a
// Graph-scope consent gap must not read as a lost sign-in.
let lastStorageTokenFailure: SilentTokenFailure | null = null

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
  lastStorageTokenFailure = result.accessToken ? null : (result.reason ?? null)
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

export type StorageAccess = 'ok' | 'failed' | 'not-configured'

/** Can the voiceprint store (Storage API) issue a token for the current
 *  account? Run right after an interactive sign-in (FD-2265 review R-1): that
 *  sign-in only requests Graph scopes, so a policy or consent problem on the
 *  Storage API itself would otherwise make "Sign in again" loop silently. */
export async function verifyStorageAccess(): Promise<StorageAccess> {
  const scope = process.env.MN_STORAGE_API_SCOPE
  if (!scope || !isStorageApiEnabled(process.env)) return 'not-configured'
  return (await getStorageApiAccessToken(scope)) ? 'ok' : 'failed'
}

export function getSignedInState(): { signedIn: boolean; email?: string; name?: string } {
  // Signed in = a usable MSAL account (in memory, or a decryptable cache on a
  // cold start) that the last Storage token attempt did not disprove. The
  // audit actor name is renderer-supplied and never counts (FD-2265).
  const msalAccountKnown = Boolean(getCurrentMsalAccountEmail() || getCurrentMsalAccountOid())
  const signedIn = isSignedIn({
    msalAccountKnown,
    persistedCachePresent: msalAccountKnown ? false : Boolean(getPersistedCache()),
    lastStorageTokenFailure
  })
  if (!signedIn) return { signedIn: false }
  return {
    signedIn: true,
    email: getCurrentUserEmail(),
    name: getCurrentMsalAccountName() ?? (currentUser !== 'Unknown user' ? currentUser : undefined)
  }
}

export const SIGNED_OUT_DURING_SIGN_IN = 'Signed out during sign-in'

export type InteractiveSignInResult = MsalSignInResult & { storageAccess?: StorageAccess }

// Bumped by every sign-out; an interactive sign-in that started under an older
// generation was superseded and must not leave a session behind.
let signOutGeneration = 0
// Bumped by every sign-in attempt; only the newest attempt may undo itself.
let signInAttempt = 0
let cancelPendingSignIn: (() => void) | null = null

function resetSession(): void {
  currentUser = 'Unknown user'
  currentUserEmail = undefined
  currentUserOid = undefined
  lastStorageTokenFailure = null
  clearCurrentMsalAccount()
}

/**
 * Interactive Microsoft sign-in where sign-out always wins (FD-2265 review R-3).
 * A sign-out while the browser step is pending returns at once; if that browser
 * step still completes later (and persists the token cache), the late session
 * is undone; a sign-out during the post-sign-in Storage check also wins.
 * `deps` exists for the verify harness; production uses the defaults.
 */
export async function runInteractiveSignIn(
  deps: {
    signIn?: () => Promise<MsalSignInResult>
    verify?: () => Promise<StorageAccess>
  } = {}
): Promise<InteractiveSignInResult> {
  const signIn = deps.signIn ?? signInInteractively
  const verify = deps.verify ?? verifyStorageAccess
  const generation = signOutGeneration
  const attempt = ++signInAttempt
  const signedOutSince = (): boolean => generation !== signOutGeneration

  const browser = signIn()
  // Browser step finished after a sign-out (code already redeemed, cache
  // saved): undo it, unless a newer sign-in has started meanwhile.
  void browser.then(
    (late) => {
      if (late.ok && signedOutSince() && attempt === signInAttempt) {
        logger().info('[auth] sign-in completed after sign-out; discarded')
        resetSession()
      }
    },
    () => {}
  )
  const cancelled = new Promise<null>((resolve) => {
    cancelPendingSignIn = () => resolve(null)
  })
  const result = await Promise.race([browser, cancelled])
  if (attempt === signInAttempt) cancelPendingSignIn = null

  if (!result || signedOutSince()) {
    logger().info('[auth] sign-in superseded by sign-out')
    return { ok: false, error: SIGNED_OUT_DURING_SIGN_IN }
  }
  if (!result.ok) {
    logger().info('[auth] sign-in failed', { error: result.error })
    return result
  }

  currentUser = result.name ?? 'Unknown user'
  currentUserEmail = result.email
  currentUserOid = result.oid
  lastStorageTokenFailure = null
  if (currentUser !== 'Unknown user') {
    logger().info('[auth] actor updated via MSAL sign-in', {
      nameKnown: Boolean(result.name),
      emailKnown: Boolean(result.email)
    })
  }
  // Callers that don't use the field (login screen, email retry) are
  // unaffected; the voiceprint gate turns 'failed' into a specific error.
  const storageAccess = await verify()
  if (signedOutSince()) {
    // The Storage token call may have re-persisted the cache after sign-out.
    logger().info('[auth] sign-in superseded by sign-out during storage check')
    resetSession()
    return { ok: false, error: SIGNED_OUT_DURING_SIGN_IN }
  }
  if (storageAccess === 'failed') {
    logger().warn('[auth] signed in, but the Storage API token is still unavailable')
  }
  if (afterMsalSignIn) {
    void Promise.resolve(afterMsalSignIn()).catch((err) => {
      logger().warn('[auth] post-sign-in hook failed', {
        message: err instanceof Error ? err.message : String(err)
      })
    })
  }
  return { ...result, storageAccess }
}

export function registerAuthSessionIpc(): void {
  ipcMain.on('auth:set-user', (_event, name: string) => {
    currentUser = name || 'Unknown user'
    currentUserEmail = undefined
    currentUserOid = undefined
    // The audit actor is not the MSAL account (FD-2265): an empty actor must
    // not delete the token cache. Only auth:sign-out clears it — otherwise a
    // cache that is temporarily unreadable (DPAPI unavailable, kept on disk
    // by token-cache-store on purpose) would be destroyed at startup.
    logger().info('[auth] actor updated', { actorKnown: currentUser !== 'Unknown user' })
  })

  ipcMain.handle('auth:sign-in', async () => {
    logger().info('[auth] sign-in requested')

    const status = getMsalConfigStatus()
    if (!status.configured) {
      logger().info('[auth] sign-in falling back: MSAL config missing')
      return { ok: false, error: 'MSAL config missing' }
    }
    return runInteractiveSignIn()
  })

  ipcMain.handle('auth:sign-out', async () => {
    logger().info('[auth] sign-out requested')
    // Sign-out always wins (FD-2265 review R-3): release any sign-in still
    // waiting on the browser, and mark in-flight sign-ins as superseded.
    signOutGeneration += 1
    cancelPendingSignIn?.()
    cancelInteractiveSignIn()
    resetSession()
    return { ok: true }
  })

  ipcMain.handle('auth:status', () => getSignedInState())

  ipcMain.handle('auth:storage-admin-status', async () => {
    const scope = process.env.MN_STORAGE_API_SCOPE
    if (!scope || !isStorageApiEnabled(process.env)) return { isAdmin: false }
    const token = await getStorageApiAccessToken(scope)
    return { isAdmin: hasStorageAdminRole(token) }
  })
}
