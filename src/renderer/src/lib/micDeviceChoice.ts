/**
 * Chooses which microphone the recorder should capture — the reliable fix for
 * the recurring Bluetooth/AirPods "my mic wasn't recorded" problem.
 *
 * Root cause (see [[notetaker-airpods-mic-not-captured]] / capture.ts header):
 * Windows keeps two capture-device *roles* — the "communications" default (what
 * Teams uses) and the "console" default. With a Bluetooth headset the user's
 * voice goes to the communications endpoint (AirPods) while getUserMedia({audio:
 * true}) records the console default (e.g. a webcam mic), so the mic track is
 * digital silence. crbug 40199570 is exactly this "does not follow the OS
 * default" behaviour.
 *
 * The fix uses Chromium's Windows-special `deviceId: 'communications'`, which
 * binds capture to — and follows — the communications-default endpoint, the
 * same one Teams uses. We only override when the native endpoint snapshot shows
 * the two roles are genuinely DIFFERENT devices (the split), the platform
 * actually enumerates a `communications` input, and the user has not pinned a
 * mic. Otherwise we leave today's behaviour untouched.
 *
 * Pure and framework-free so it is unit-verified (scripts/verify-mic-device-choice)
 * and safe to gate behind a flag until validated on a real Bluetooth device —
 * the v2.0.17 native-routing rollback is why this ships cautiously.
 */
import type { AudioEndpointSnapshot } from '../../../shared/audio-endpoints'

/** The subset of MediaDeviceInfo we need — keeps the helper testable. */
export interface EnumeratedDevice {
  deviceId: string
  kind: string
  label: string
}

export interface MicDeviceChoiceInput {
  /** Feature flag — false keeps the pre-fix behaviour (default input). */
  enabled: boolean
  /** A mic the user explicitly selected in settings ('' = none). */
  explicitMicDeviceId: string
  /** Native communications/console endpoint snapshot, or null if unavailable. */
  snapshot: AudioEndpointSnapshot | null
  /** navigator.mediaDevices.enumerateDevices() result. */
  devices: EnumeratedDevice[]
}

export interface MicDeviceChoice {
  /** Pass straight to capture.start(...); '' means "browser default input". */
  deviceId: string
  reason:
    | 'user-selected'
    | 'disabled'
    | 'no-snapshot'
    | 'no-split'
    | 'no-communications-device'
    | 'follow-communications'
}

const COMMUNICATIONS = 'communications'

export function chooseMicDeviceId(input: MicDeviceChoiceInput): MicDeviceChoice {
  // An explicit choice is the user's, always honoured.
  if (input.explicitMicDeviceId) {
    return { deviceId: input.explicitMicDeviceId, reason: 'user-selected' }
  }
  if (!input.enabled) return { deviceId: '', reason: 'disabled' }

  const endpoints = input.snapshot?.endpoints
  const commsId = endpoints?.captureCommunications?.id ?? null
  const consoleId = endpoints?.captureConsole?.id ?? null
  if (!commsId || !consoleId) return { deviceId: '', reason: 'no-snapshot' }

  // Same physical endpoint for both roles → the default input is already the
  // right one; forcing the alias would change nothing.
  if (commsId === consoleId) return { deviceId: '', reason: 'no-split' }

  // Split confirmed. Only follow if the platform actually exposes the
  // `communications` input alias (Windows); otherwise fall back safely.
  const hasCommunicationsInput = input.devices.some(
    (d) => d.kind === 'audioinput' && d.deviceId === COMMUNICATIONS
  )
  if (!hasCommunicationsInput) return { deviceId: '', reason: 'no-communications-device' }

  return { deviceId: COMMUNICATIONS, reason: 'follow-communications' }
}
