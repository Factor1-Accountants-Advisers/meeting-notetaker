import type { User } from '../screens/LoginScreen'

export interface StartupAuthStatus {
  signedIn: boolean
  email?: string
  name?: string
}

export interface StartupUserDecision {
  user: User | null
  /** What to do with localStorage mn.user. */
  stored: 'keep' | 'clear' | 'write'
}

/**
 * Cold-start reconciliation of the cached renderer user with main's real
 * Microsoft sign-in (FD-2265). A stored mn.user is only a display cache; when
 * main reports no usable account it must be dropped so the login screen
 * shows, instead of the voiceprint gate failing on a session that is gone.
 * `status` null = the auth-status IPC failed: stay fail-soft (the enrolment
 * gate still fails closed if identity is really missing).
 */
export function reconcileStartupUser(
  status: StartupAuthStatus | null,
  stored: User | null
): StartupUserDecision {
  if (!status) return { user: stored, stored: 'keep' }
  if (!status.signedIn) return { user: null, stored: 'clear' }
  if (stored) return { user: stored, stored: 'keep' }
  if (!status.email) return { user: null, stored: 'keep' }
  return {
    user: { name: status.name ?? status.email.split('@')[0], email: status.email },
    stored: 'write'
  }
}
