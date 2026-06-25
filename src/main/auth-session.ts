import { ipcMain } from 'electron'

// Signed-in display name; sent as the audit actor on every backend call.
// Replaced by the Entra ID token subject once real auth lands.
let currentUser = 'Unknown user'

export function getCurrentUser(): string {
  return currentUser
}

export function registerAuthSessionIpc(): void {
  ipcMain.on('auth:set-user', (_event, name: string) => {
    currentUser = name || 'Unknown user'
  })
}
