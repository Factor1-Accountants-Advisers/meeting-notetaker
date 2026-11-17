// Pure "is there a usable Microsoft sign-in?" decision (FD-2265). No Electron
// or MSAL imports, so verify-sign-in-gate.tsx can exercise it directly.
//
// The audit actor display name (auth:set-user) is deliberately NOT an input:
// the renderer pushes it from localStorage, so it can outlive the token cache
// it was derived from. Treating it as "signed in" let a cleared/undecryptable
// cache present as a voiceprint failure instead of a sign-in prompt.

import type { MsalTokenResult } from './auth-msal'

export type SilentTokenFailure = NonNullable<MsalTokenResult['reason']>

export interface AuthStateInputs {
  /** An MSAL account is held in memory (set by silent or interactive auth). */
  msalAccountKnown: boolean
  /** A decryptable token cache exists on disk (cold start, before any token call). */
  persistedCachePresent: boolean
  /** Outcome of the most recent Storage API silent token attempt; null after a success. */
  lastStorageTokenFailure: SilentTokenFailure | null
}

/** Failures that only an interactive Microsoft sign-in can fix. A transient
 *  'error' (network, Entra outage) is not evidence the sign-in was lost. */
const SIGN_IN_REQUIRED_FAILURES: ReadonlySet<SilentTokenFailure> = new Set([
  'no_cached_account',
  'interaction_required'
])

export function isSignedIn(inputs: AuthStateInputs): boolean {
  if (inputs.lastStorageTokenFailure && SIGN_IN_REQUIRED_FAILURES.has(inputs.lastStorageTokenFailure)) {
    return false
  }
  return inputs.msalAccountKnown || inputs.persistedCachePresent
}
