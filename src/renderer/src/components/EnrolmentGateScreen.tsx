/**
 * Staff voiceprint gate screen (IN-379). FD-2265: each failure names its real
 * cause — a lost Microsoft sign-in was previously headed "Voiceprint required",
 * which sent users looking for a voiceprint problem that did not exist.
 * "Voiceprint required" is reserved for a successfully checked, genuinely
 * unenrolled user.
 */
export type GateView =
  | { kind: 'checking' }
  | { kind: 'sign-in-required' }
  | { kind: 'central-unavailable' }
  | { kind: 'load-failed'; message: string | null }
  | { kind: 'not-enrolled' }

interface Props {
  view: GateView
  /** Interactive Microsoft sign-in (sign-in-required only). */
  onSignIn: () => void
  onRetry: () => void
  onSignOut: () => void
  signingIn?: boolean
  signInError?: string | null
}

const NO_REENROL = 'You don’t need to record a new voiceprint.'
const LOAD_FAILED_FALLBACK =
  'Could not load your staff enrollment record. Check that the backend is running, then try again.'

const PRIMARY_BUTTON =
  'rounded-md border-[0.5px] border-edge-info bg-bg-info px-3 py-2 text-[13px] text-content-info hover:opacity-90 disabled:opacity-60'
const SECONDARY_BUTTON =
  'rounded-md border-[0.5px] border-edge-secondary px-3 py-2 text-[13px] text-content-primary hover:bg-bg-secondary'

function copyFor(view: GateView): { heading: string; body: string } {
  switch (view.kind) {
    case 'checking':
      return {
        heading: 'Checking your voiceprint',
        body: 'Notetaker checks your Microsoft sign-in and voiceprint before you start.'
      }
    case 'sign-in-required':
      return {
        heading: 'Sign in again',
        body: `Notetaker needs you to sign in with Microsoft again before it can check your voiceprint. ${NO_REENROL}`
      }
    case 'central-unavailable':
      return {
        heading: 'Couldn’t check your voiceprint',
        body: `We couldn’t check your voiceprint right now. Check your connection and try again. ${NO_REENROL}`
      }
    case 'load-failed':
      return { heading: 'Couldn’t check your voiceprint', body: view.message ?? LOAD_FAILED_FALLBACK }
    case 'not-enrolled':
      return {
        heading: 'Voiceprint required',
        body:
          'Factor1 staff must enroll a voiceprint after Microsoft sign-in before using Notetaker. This helps identify speakers accurately in meeting transcripts.'
      }
  }
}

export function EnrolmentGateScreen({
  view,
  onSignIn,
  onRetry,
  onSignOut,
  signingIn = false,
  signInError = null
}: Props): JSX.Element {
  const { heading, body } = copyFor(view)
  const failed = view.kind === 'central-unavailable' || view.kind === 'load-failed'
  return (
    <div className="w-full max-w-[520px] rounded-lg border-[0.5px] border-edge-secondary bg-bg-primary p-5 text-center">
      <h1 className="m-0 text-[18px] font-medium text-content-primary">{heading}</h1>
      <p
        className={
          failed
            ? 'mb-0 mt-4 rounded-md border-[0.5px] border-edge-danger bg-bg-danger px-3 py-2 text-[12px] leading-relaxed text-content-danger'
            : 'mx-auto mb-0 mt-2 max-w-[420px] text-[12px] leading-relaxed text-content-tertiary'
        }
      >
        {body}
      </p>
      {view.kind === 'checking' && (
        <p className="mb-0 mt-4 flex items-center justify-center gap-2 text-[13px] text-content-secondary">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-edge-tertiary border-t-brand-blue" />
          Loading your enrollment status…
        </p>
      )}
      {view.kind === 'sign-in-required' && signInError && (
        <p className="mb-0 mt-4 rounded-md border-[0.5px] border-edge-danger bg-bg-danger px-3 py-2 text-[12px] leading-relaxed text-content-danger">
          {signInError}
        </p>
      )}
      <div className="mt-4 flex items-center justify-center gap-2">
        {view.kind === 'sign-in-required' && (
          <button type="button" disabled={signingIn} onClick={onSignIn} className={PRIMARY_BUTTON}>
            {signingIn ? 'Signing in…' : 'Sign in again'}
          </button>
        )}
        {failed && (
          <button type="button" onClick={onRetry} className={PRIMARY_BUTTON}>
            Try again
          </button>
        )}
        <button type="button" onClick={onSignOut} className={SECONDARY_BUTTON}>
          Sign out
        </button>
      </div>
    </div>
  )
}
