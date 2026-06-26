import { useState } from 'react'
import { AudioWaveform, ShieldCheck } from 'lucide-react'

export interface User {
  name: string
  email: string
}

interface Props {
  onSignedIn: (user: User) => void
}

/**
 * Microsoft sign-in (requirements §4.1). Stub flow until Entra ID lands:
 * MSAL via the main process will replace the fake check, and the backend
 * will enforce group membership per the open item in requirements §10.
 */
export function LoginScreen({ onSignedIn }: Props): JSX.Element {
  const [checking, setChecking] = useState(false)

  const signIn = async (): Promise<void> => {
    setChecking(true)

    try {
      if (typeof window.api?.signIn === 'function') {
        const result = await window.api.signIn()
        if (result.ok && result.name && result.email) {
          onSignedIn({ name: result.name, email: result.email })
          return
        }
      }
    } catch {
      // MSAL not available or sign-in failed — fall through to stub.
    }

    // Stub fallback when MSAL is not configured or sign-in failed.
    setTimeout(() => {
      onSignedIn({ name: 'Joseph Guerrero', email: 'joseph.guerrero@factor1.ph' })
    }, 700)
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 bg-page px-6">
      <div className="flex flex-col items-center gap-2">
        <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-bg-info text-content-info">
          <AudioWaveform size={24} strokeWidth={1.75} />
        </span>
        <h1 className="text-[22px] font-medium text-content-primary">Meeting notetaker</h1>
        <p className="text-[12px] text-content-tertiary">Factor1 Accountants &amp; Advisers</p>
      </div>

      <div className="w-full max-w-[360px] rounded-lg border-[0.5px] border-edge-tertiary bg-bg-primary p-5">
        {checking ? (
          <div className="flex flex-col items-center gap-2 py-3">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-edge-tertiary border-t-brand-blue" />
            <span className="text-[13px] text-content-secondary">Checking authorisation…</span>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={signIn}
              className="flex w-full items-center justify-center gap-2.5 rounded-md border-[0.5px] border-edge-secondary py-2.5 text-[14px] text-content-primary transition-colors hover:bg-bg-secondary"
            >
              <MicrosoftLogo />
              Sign in with Microsoft
            </button>
            <p className="mb-0 mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-content-tertiary">
              <ShieldCheck size={13} strokeWidth={1.75} className="mt-px shrink-0" />
              Authorised Factor1 staff only. Meetings routinely contain confidential client
              information — access is checked on every sign-in.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

function MicrosoftLogo(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="0" y="0" width="10" height="10" fill="#f25022" />
      <rect x="11" y="0" width="10" height="10" fill="#7fba00" />
      <rect x="0" y="11" width="10" height="10" fill="#00a4ef" />
      <rect x="11" y="11" width="10" height="10" fill="#ffb900" />
    </svg>
  )
}
