import { ipcMain } from 'electron'
import { logger } from './logger'

// Signed-in display name; sent as the audit actor on every backend call.
// Replaced by the Entra ID token subject once real auth lands.
let currentUser = 'Unknown user'
let currentUserEmail: string | undefined

export function getCurrentUser(): string {
  return currentUser
}

export function getCurrentUserEmail(): string | undefined {
  return currentUserEmail
}

export async function getGraphAccessToken(): Promise<string | null> {
  // Stub until MSAL/Entra lands. Keeping the token supplier explicit lets the
  // Graph runtime stay wired but inert without leaking or inventing credentials.
  return null
}

export function registerAuthSessionIpc(): void {
  ipcMain.on('auth:set-user', (_event, name: string) => {
    currentUser = name || 'Unknown user'
    currentUserEmail = undefined
    logger().info('[auth] actor updated', { actorKnown: currentUser !== 'Unknown user' })
  })
}
