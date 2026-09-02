/**
 * Pure decision for the live capture warnings shown on the recording screen.
 *
 * Kept framework-free so it can be unit-verified (scripts/verify-capture-warnings)
 * without a DOM; RecordingScreen maps the returned icon keys to lucide icons and
 * renders `severity: 'banner'` prominently.
 *
 * The headline case (2026-09-01, recurring): on Bluetooth headsets — AirPods
 * especially — Windows routes the user's voice to the "communications" capture
 * endpoint (what Teams uses) while the notetaker records the "console" default
 * input, a different device. The mic track is then digital silence even though
 * the meeting audio (loopback) is captured fine. The old warning was a quiet
 * generic row ("check your selected microphone") that users missed live. When
 * we are online AND the loopback is healthy AND the mic is silent, we can name
 * the cause and the fix — so that case escalates to a prominent banner.
 */
import type { CaptureStatus } from './capture'

export interface CaptureWarningInput {
  source: 'online' | 'in_person'
  mic: CaptureStatus['mic']
  loopback: CaptureStatus['loopback']
  recording: boolean
  hasMeeting: boolean
}

export type WarningIcon = 'mic-off' | 'alert' | 'cloud-off'

export interface CaptureWarning {
  /** Stable identifier for tests and React keys. */
  id: string
  /** 'banner' renders large and bordered; 'row' is a compact line. */
  severity: 'banner' | 'row'
  icon: WarningIcon
  title?: string
  text: string
  tone: 'danger' | 'warning'
}

const WRONG_DEVICE_BANNER: CaptureWarning = {
  id: 'mic-silent-wrong-device',
  severity: 'banner',
  icon: 'mic-off',
  tone: 'danger',
  title: "Your microphone isn't being recorded",
  text:
    'The meeting audio is being captured, but your microphone is silent. This usually means a ' +
    'Bluetooth headset (e.g. AirPods) is receiving your voice while the notetaker is recording a ' +
    'different microphone. Set your headset as the default input device in Windows Sound settings ' +
    '(or switch your input), then check the mic meter moves when you speak.'
}

export function buildCaptureWarnings(input: CaptureWarningInput): CaptureWarning[] {
  const warnings: CaptureWarning[] = []
  const online = input.source === 'online'

  // Most urgent first: a confident wrong-device diagnosis (online meeting, the
  // remote side IS captured, only the mic is dead) gets the actionable banner.
  if (input.mic === 'error') {
    warnings.push({
      id: 'mic-unavailable',
      severity: 'row',
      icon: 'mic-off',
      tone: 'danger',
      text: 'Microphone unavailable — check microphone access in system settings.'
    })
  } else if (input.mic === 'silent') {
    if (online && input.loopback === 'active') {
      warnings.push(WRONG_DEVICE_BANNER)
    } else {
      warnings.push({
        id: 'mic-silent',
        severity: 'row',
        icon: 'mic-off',
        tone: 'danger',
        text:
          'Microphone appears silent — check that the microphone you are speaking into is set as ' +
          'your default input device.'
      })
    }
  }

  if (online && input.loopback === 'error') {
    warnings.push({
      id: 'loopback-error',
      severity: 'row',
      icon: 'alert',
      tone: 'danger',
      text: 'System audio failed — remote participants are not being captured.'
    })
  } else if (online && input.loopback === 'silent') {
    warnings.push({
      id: 'loopback-silent',
      severity: 'row',
      icon: 'alert',
      tone: 'danger',
      text: 'System audio has been silent for over a minute — check your audio output device.'
    })
  }

  if (!input.recording) {
    warnings.push({
      id: 'not-recording',
      severity: 'row',
      icon: 'alert',
      tone: 'danger',
      text: 'No audio is being captured — the timer is still running.'
    })
  }

  if (!input.hasMeeting) {
    warnings.push({
      id: 'backend-unsaved',
      severity: 'row',
      icon: 'cloud-off',
      tone: 'warning',
      text: 'Backend unavailable — this meeting is not saved yet.'
    })
  }

  // Ensure any banner sorts ahead of rows (order within a tier is preserved).
  return warnings.sort((a, b) => Number(b.severity === 'banner') - Number(a.severity === 'banner'))
}
