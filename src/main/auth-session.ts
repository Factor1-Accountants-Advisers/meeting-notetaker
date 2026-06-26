import { ipcMain } from 'electron'
import { acquireGraphTokenSilent, clearCurrentMsalAccount, getCurrentMsalAccountEmail, getMsalConfigStatus } from './auth-msal'
import { logger } from './logger'

// Signed-in display name; sent as the audit actor on every backend call.
// Replaced by the Entra ID token subject once real auth lands.
let currentUser = 'Unknown user'
let currentUserEmail: string | undefined

export function getCurrentUser(): string {
  return currentUser
}

export function getCurrentUserEmail(): string | undefined {
  return currentUserEmail ?? getCurrentMsalAccountEmail()
}

export async function getGraphAccessToken(): Promise<string | null> {
  const status = getMsalConfigStatus()
  if (!status.configured) {
    logger().info('[auth] Graph token unavailable: MSAL public-client config missing', {
      missing: status.missing
    })
    return null
  }

  const result = await acquireGraphTokenSilent()
  if (result.accountEmail) currentUserEmail = result.accountEmail
  if (!result.accessToken) {
    logger().info('[auth] Graph token unavailable', { reason: result.reason })
    return null
  }

  logger().info('[auth] Graph token acquired', { accountKnown: Boolean(result.accountEmail) })
  return result.accessToken
}

export function registerAuthSessionIpc(): void {
  ipcMain.on('auth:set-user', (_event, name: string) => {
    currentUser = name || 'Unknown user'
    currentUserEmail = undefined
    if (currentUser === 'Unknown user') clearCurrentMsalAccount()
    logger().info('[auth] actor updated', { actorKnown: currentUser !== 'Unknown user' })
  })
}
