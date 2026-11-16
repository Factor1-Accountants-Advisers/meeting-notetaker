// FD-2265: a lost Microsoft sign-in (undecryptable token cache →
// no_cached_account) was shown as "Voiceprint required". These checks pin the
// separation between missing authentication, an unreachable central store, a
// failed local load, and a genuinely unenrolled user — without touching real
// MSAL, the backend, or any voiceprint.
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { isSignedIn } from '../src/main/auth-state'
import { EnrolmentGateScreen, type GateView } from '../src/renderer/src/components/EnrolmentGateScreen'
import { resolveEnrolmentGate, signInAgainOutcome, type GateDeps } from '../src/renderer/src/lib/enrolmentGate'
import { reconcileStartupUser } from '../src/renderer/src/lib/startupUser'
import type { EnrolmentStatus } from '../src/renderer/src/lib/api'
import type { StaffMember } from '../src/renderer/src/data/mock'

async function main(): Promise<void> {
  // ---------------------------------------------------------------------------
  // Main process: signed-in means a usable MSAL account, never an audit name.
  // ---------------------------------------------------------------------------
  assert.equal(
    isSignedIn({ msalAccountKnown: false, persistedCachePresent: false, lastStorageTokenFailure: null }),
    false,
    'corrupt/cleared cache with no in-memory account is signed out (Ellen, 16 Nov)'
  )
  assert.equal(
    isSignedIn({ msalAccountKnown: false, persistedCachePresent: true, lastStorageTokenFailure: null }),
    true,
    'cold start with a decryptable cache stays signed in'
  )
  assert.equal(
    isSignedIn({ msalAccountKnown: true, persistedCachePresent: false, lastStorageTokenFailure: null }),
    true,
    'in-memory MSAL account is signed in'
  )
  assert.equal(
    isSignedIn({
      msalAccountKnown: false,
      persistedCachePresent: true,
      lastStorageTokenFailure: 'no_cached_account'
    }),
    false,
    'a cache file with no account in it is signed out once silent auth proves it'
  )
  assert.equal(
    isSignedIn({
      msalAccountKnown: true,
      persistedCachePresent: true,
      lastStorageTokenFailure: 'interaction_required'
    }),
    false,
    'an expired/revoked refresh token needs interactive sign-in'
  )
  assert.equal(
    isSignedIn({ msalAccountKnown: true, persistedCachePresent: true, lastStorageTokenFailure: 'error' }),
    true,
    'a transient network/token error is not evidence of a lost sign-in'
  )

  // ---------------------------------------------------------------------------
  // Renderer cold start: a stale mn.user must not survive a signed-out main.
  // ---------------------------------------------------------------------------
  const ellen = { name: 'Ellen Example', email: 'ellen@example.test' }
  assert.deepEqual(
    reconcileStartupUser({ signedIn: false }, ellen),
    { user: null, stored: 'clear' },
    'stale mn.user + missing/corrupt cache → login screen, stored user cleared'
  )
  assert.deepEqual(
    reconcileStartupUser({ signedIn: true, email: 'ellen@example.test' }, ellen),
    { user: ellen, stored: 'keep' },
    'healthy cache keeps the stored user'
  )
  assert.deepEqual(
    reconcileStartupUser({ signedIn: true, email: 'ellen@example.test', name: 'Ellen Example' }, null),
    { user: ellen, stored: 'write' },
    'healthy cache without mn.user restores the session from the account'
  )
  assert.deepEqual(
    reconcileStartupUser({ signedIn: true, email: 'ellen@example.test' }, null),
    { user: { name: 'ellen', email: 'ellen@example.test' }, stored: 'write' },
    'missing account name falls back to the email local part'
  )
  assert.deepEqual(
    reconcileStartupUser(null, ellen),
    { user: ellen, stored: 'keep' },
    'auth-status IPC failure is fail-soft (gate still fails closed later)'
  )

  // ---------------------------------------------------------------------------
  // Gate resolution
  // ---------------------------------------------------------------------------
  const person: StaffMember = {
    id: 'ellen@example.test',
    name: 'Ellen Example',
    role: 'Factor1 staff',
    tone: 'info',
    enrollment: 'enrolled',
    modelVersion: null
  }
  const unknown: EnrolmentStatus = {
    enrolled_locally: false,
    centrally_enrolled: false,
    central_required: true,
    centrally_unknown: true
  }
  const enrolled: EnrolmentStatus = { ...unknown, centrally_enrolled: true, centrally_unknown: false }
  const absent: EnrolmentStatus = { ...unknown, centrally_unknown: false }

  function deps(
    statuses: (EnrolmentStatus | null)[],
    auth: { signedIn: boolean } | 'unavailable' | 'throws',
    log: string[]
  ): GateDeps {
    let i = 0
    return {
      fetchPerson: async () => person,
      fetchStatus: async () => {
        log.push('status')
        return statuses[Math.min(i++, statuses.length - 1)]
      },
      getAuthStatus:
        auth === 'unavailable'
          ? undefined
          : async () => {
              log.push('auth')
              if (auth === 'throws') throw new Error('ipc down')
              return auth
            },
      delaysMs: [1, 1, 1],
      sleep: async (ms) => {
        log.push(`sleep:${ms}`)
      },
      isCancelled: () => false
    }
  }

  {
    const log: string[] = []
    const outcome = await resolveEnrolmentGate(deps([unknown], { signedIn: false }, log))
    assert.deepEqual(outcome, { kind: 'sign-in-required' }, 'unknown status + signed-out main → sign in')
    assert.deepEqual(
      log,
      ['status', 'auth'],
      'auth state is read AFTER the status call (its token attempt records the failure) and retries stop'
    )
  }
  {
    const log: string[] = []
    const outcome = await resolveEnrolmentGate(deps([unknown], { signedIn: true }, log))
    assert.deepEqual(outcome, { kind: 'central-unavailable' }, 'signed-in central outage → retry wording')
    assert.equal(log.filter((e) => e === 'status').length, 4, 'central outage still retries before failing')
  }
  {
    const log: string[] = []
    const outcome = await resolveEnrolmentGate(deps([unknown], 'throws', log))
    assert.deepEqual(outcome, { kind: 'central-unavailable' }, 'unknown auth state never claims signed out')
  }
  {
    const log: string[] = []
    const outcome = await resolveEnrolmentGate(deps([unknown], 'unavailable', log))
    assert.deepEqual(outcome, { kind: 'central-unavailable' }, 'no auth bridge never claims signed out')
  }
  {
    const log: string[] = []
    const outcome = await resolveEnrolmentGate(deps([unknown, enrolled], { signedIn: true }, log))
    assert.deepEqual(
      outcome,
      { kind: 'ready', person, status: enrolled },
      'a transient unknown that recovers passes the gate'
    )
  }
  {
    const log: string[] = []
    const outcome = await resolveEnrolmentGate(deps([absent], { signedIn: true }, log))
    assert.deepEqual(
      outcome,
      { kind: 'ready', person, status: absent },
      'confirmed absence resolves (App then shows Voiceprint required + wizard)'
    )
    assert.deepEqual(log, ['status'], 'confirmed absence needs no auth probe or retry')
  }
  {
    const outcome = await resolveEnrolmentGate({
      ...deps([enrolled], { signedIn: true }, []),
      fetchPerson: async () => {
        throw new Error('Backend unreachable')
      }
    })
    assert.deepEqual(
      outcome,
      { kind: 'load-failed', message: 'Backend unreachable' },
      'local load failure keeps its own message'
    )
  }
  {
    const outcome = await resolveEnrolmentGate({
      ...deps([unknown], { signedIn: false }, []),
      isCancelled: () => true
    })
    assert.equal(outcome, null, 'cancelled runs resolve to nothing')
  }
  // Review R-4, reproduced in the dev build on 16 Nov: every status call timed
  // out (Storage API IPv6 stall), /people/me answered, and the null-status
  // fallback opened the wizard for a person with a central voiceprint.
  {
    const notEnrolledLocally: StaffMember = { ...person, enrollment: 'not_enrolled' }
    const log: string[] = []
    const outcome = await resolveEnrolmentGate({
      ...deps([null], { signedIn: true }, log),
      fetchPerson: async () => notEnrolledLocally
    })
    assert.deepEqual(
      outcome,
      { kind: 'central-unavailable' },
      'a status that never answers is "could not check", never "Voiceprint required"'
    )
    assert.equal(log.filter((e) => e === 'status').length, 4, 'an unanswered status still retries first')
  }
  {
    const outcome = await resolveEnrolmentGate(deps([null], { signedIn: true }, []))
    assert.deepEqual(
      outcome,
      { kind: 'ready', person, status: null },
      'a locally enrolled person keeps the Slice 1 fallback when status never answers'
    )
  }

  // ---------------------------------------------------------------------------
  // "Sign in again" result (review R-1, option b): a sign-in that succeeds but
  // still can't reach the voiceprint store must say so, not silently loop.
  // ---------------------------------------------------------------------------
  const who = { name: 'Ellen Example', email: 'ellen@example.test' }
  assert.deepEqual(
    signInAgainOutcome({ ok: true, ...who, storageAccess: 'ok' }),
    { user: who, error: null },
    'sign-in with voiceprint-store access restores the session with no error'
  )
  assert.deepEqual(
    signInAgainOutcome({ ok: true, ...who }),
    { user: who, error: null },
    'no storageAccess field (store not configured / older main) is a plain success'
  )
  assert.deepEqual(
    signInAgainOutcome({ ok: true, ...who, storageAccess: 'not-configured' }),
    { user: who, error: null },
    'stub/local mode is a plain success'
  )
  const stillFailing = signInAgainOutcome({ ok: true, ...who, storageAccess: 'failed' })
  assert.deepEqual(stillFailing.user, who, 'signed in for real, so the session identity is kept')
  assert.match(String(stillFailing.error), /signed in/i, 'error acknowledges the sign-in worked')
  assert.match(String(stillFailing.error), /voiceprint service/i, 'error names what still fails')
  assert.doesNotMatch(String(stillFailing.error), /sign in again|record a new voiceprint/i, 'error does not invite a futile retry or re-enrolment')
  assert.deepEqual(
    signInAgainOutcome({ ok: false, error: 'Sign-in was cancelled or timed out' }),
    { user: null, error: 'Sign-in was cancelled or timed out' },
    'a failed sign-in keeps its own message'
  )
  assert.deepEqual(
    signInAgainOutcome({ ok: true, name: 'No Email' }),
    { user: null, error: 'Microsoft sign-in did not complete. Try again.' },
    'an account without an email is not a usable session'
  )

  // ---------------------------------------------------------------------------
  // Gate screen copy and actions
  // ---------------------------------------------------------------------------
  function render(view: GateView, extra: Partial<Parameters<typeof EnrolmentGateScreen>[0]> = {}): string {
    return renderToStaticMarkup(
      <EnrolmentGateScreen
        view={view}
        onSignIn={() => undefined}
        onRetry={() => undefined}
        onSignOut={() => undefined}
        {...extra}
      />
    )
  }

  const checking = render({ kind: 'checking' })
  assert.doesNotMatch(checking, /Voiceprint required/, 'loading is neutral')
  assert.doesNotMatch(checking, />Try again</, 'loading offers no retry')

  const signIn = render({ kind: 'sign-in-required' })
  assert.match(signIn, /<h1[^>]*>Sign in again<\/h1>/, 'missing auth asks for sign-in')
  assert.match(signIn, /sign in with Microsoft again/, 'body names Microsoft sign-in')
  assert.match(signIn, /need to record a new voiceprint/, 'reassures no re-enrolment')
  assert.match(signIn, /<button[^>]*>Sign in again<\/button>/, 'primary action performs sign-in')
  assert.doesNotMatch(signIn, /Voiceprint required/, 'auth failure is not a voiceprint failure')
  assert.doesNotMatch(signIn, /Try again/, 'retry cannot fix missing auth')

  const signingIn = render({ kind: 'sign-in-required' }, { signingIn: true })
  assert.match(signingIn, /<button[^>]*disabled=""[^>]*>Signing in…<\/button>/, 'sign-in is single-flight')

  const signInFailed = render({ kind: 'sign-in-required' }, { signInError: 'Sign-in was cancelled or timed out' })
  assert.match(signInFailed, /Sign-in was cancelled or timed out/, 'sign-in failure is shown')

  const outage = render({ kind: 'central-unavailable' })
  assert.match(outage, /<h1[^>]*>Couldn’t check your voiceprint<\/h1>/, 'outage heading')
  assert.match(outage, /Check your connection and try again/, 'outage body')
  assert.match(outage, />Try again</, 'outage keeps retry')
  assert.match(outage, />Sign out</, 'outage keeps sign-out recovery')
  assert.doesNotMatch(outage, /Sign in again|signed out/i, 'outage never claims the user is signed out')
  assert.doesNotMatch(outage, /Voiceprint required/, 'outage is not a missing voiceprint')

  const loadFailed = render({ kind: 'load-failed', message: 'Backend unreachable' })
  assert.match(loadFailed, /Backend unreachable/, 'load failure shows its message')
  assert.match(loadFailed, />Try again</, 'load failure keeps retry')
  assert.doesNotMatch(loadFailed, /Voiceprint required/, 'load failure is not a missing voiceprint')

  const notEnrolled = render({ kind: 'not-enrolled' })
  assert.match(notEnrolled, /<h1[^>]*>Voiceprint required<\/h1>/, 'genuine absence keeps Voiceprint required')
  assert.doesNotMatch(notEnrolled, /Try again|Sign in again/, 'genuine absence routes to the wizard only')

  console.log('verify-sign-in-gate: all checks passed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
