import type { StaffMember } from '../data/mock'
import type { EnrolmentStatus } from './api'

/**
 * Outcome of the staff voiceprint gate check (IN-379, FD-2265).
 *
 * - ready: person + status resolved. The caller still decides pass/fail from
 *   the status — a confirmed central absence is `ready` and opens the wizard.
 *   status null = backend answered the person but not the status (Slice 1
 *   fallback, unchanged).
 * - sign-in-required: the central store could not be consulted AND main
 *   reports no usable Microsoft sign-in. Retrying cannot help.
 * - central-unavailable: the central store could not be consulted while
 *   sign-in is present or undetermined. Never claims the user is signed out.
 * - load-failed: the local person/status calls themselves failed.
 */
export type GateOutcome =
  | { kind: 'ready'; person: StaffMember; status: EnrolmentStatus | null }
  | { kind: 'sign-in-required' }
  | { kind: 'central-unavailable' }
  | { kind: 'load-failed'; message: string | null }

export interface GateDeps {
  fetchPerson(): Promise<StaffMember | null>
  fetchStatus(): Promise<EnrolmentStatus | null>
  /** Main's authoritative sign-in state; undefined when there is no IPC bridge. */
  getAuthStatus?: () => Promise<{ signedIn: boolean }>
  /** Backoff between attempts; its length is the retry count. */
  delaysMs: readonly number[]
  sleep(ms: number): Promise<void>
  isCancelled(): boolean
}

function isCentrallyUnknown(status: EnrolmentStatus | null): boolean {
  return Boolean(
    status && status.central_required && !status.centrally_enrolled && status.centrally_unknown
  )
}

/** Only an explicit signedIn:false counts; an unreachable bridge is "don't know". */
async function signInIsMissing(getAuthStatus: GateDeps['getAuthStatus']): Promise<boolean> {
  if (!getAuthStatus) return false
  try {
    return (await getAuthStatus()).signedIn === false
  } catch {
    return false
  }
}

export interface SignInAgainResult {
  ok: boolean
  name?: string
  email?: string
  error?: string
  /** Main's post-sign-in voiceprint-store check (absent from older mains). */
  storageAccess?: 'ok' | 'failed' | 'not-configured'
}

export const STORAGE_STILL_UNREACHABLE =
  'You’re signed in, but Notetaker still can’t reach the voiceprint service. Contact the IT service desk.'

/**
 * What "Sign in again" leads to (FD-2265 review R-1). A successful sign-in is
 * a real session even if the voiceprint store still refuses a token, so the
 * identity is kept — but the user is told why the gate is still closed instead
 * of being shown the same button again with no explanation.
 */
export function signInAgainOutcome(result: SignInAgainResult): {
  user: { name: string; email: string } | null
  error: string | null
} {
  if (!result.ok || !result.name || !result.email) {
    return { user: null, error: result.error || 'Microsoft sign-in did not complete. Try again.' }
  }
  const user = { name: result.name, email: result.email }
  return { user, error: result.storageAccess === 'failed' ? STORAGE_STILL_UNREACHABLE : null }
}

/** Resolves null when cancelled mid-flight. */
export async function resolveEnrolmentGate(deps: GateDeps): Promise<GateOutcome | null> {
  let lastErrorMessage: string | null = null
  // A person that resolves alongside a null status means the backend
  // answered one call but not the other — retry, then fall back to the
  // person (Slice 1 behaviour) rather than surface an error it never sent.
  let lastPersonWithNullStatus: StaffMember | null = null
  let lastStatusWasUnknown = false
  for (let attempt = 0; ; attempt++) {
    try {
      const [person, status] = await Promise.all([deps.fetchPerson(), deps.fetchStatus()])
      if (deps.isCancelled()) return null
      // "Could not check the central store" must never funnel an
      // already-enrolled person into the wizard (3 Aug incident).
      const statusUnknown = isCentrallyUnknown(status)
      if (person && status && !statusUnknown) return { kind: 'ready', person, status }
      if (statusUnknown) {
        // The status call's Storage token attempt has already recorded its
        // outcome in main (the proxy awaits the token before forwarding), so
        // this read reflects THIS attempt. A lost sign-in will not heal by
        // waiting — stop now instead of spinning through the backoff.
        const missing = await signInIsMissing(deps.getAuthStatus)
        if (deps.isCancelled()) return null
        if (missing) return { kind: 'sign-in-required' }
      }
      lastStatusWasUnknown = statusUnknown
      lastPersonWithNullStatus = person && !status ? person : null
      lastErrorMessage = null
    } catch (err) {
      if (deps.isCancelled()) return null
      lastErrorMessage = err instanceof Error ? err.message : null
      lastPersonWithNullStatus = null
      lastStatusWasUnknown = false
    }
    const delay = deps.delaysMs[attempt]
    if (delay === undefined) break
    await deps.sleep(delay)
    if (deps.isCancelled()) return null
  }
  if (lastPersonWithNullStatus) return { kind: 'ready', person: lastPersonWithNullStatus, status: null }
  if (lastStatusWasUnknown) return { kind: 'central-unavailable' }
  return { kind: 'load-failed', message: lastErrorMessage }
}
