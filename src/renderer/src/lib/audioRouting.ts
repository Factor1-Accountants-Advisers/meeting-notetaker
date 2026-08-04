import type { AudioEndpointSnapshot } from '../../../shared/audio-endpoints'
import type { MicRoutingMode, Prefs } from './prefs'

export type MicRouteDegradedReason =
  | 'native_snapshot_unavailable'
  | 'communications_endpoint_unavailable'
  | 'communications_match_missing'
  | 'communications_match_ambiguous'
  | 'pinned_device_not_selected'
  | 'pinned_device_missing'

export interface MicRoute {
  mode: MicRoutingMode
  audioConstraints: true | MediaTrackConstraints
  requestedDeviceId: string | null
  targetLabel: string | null
  degradedReason: MicRouteDegradedReason | null
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function fallback(
  mode: MicRoutingMode,
  reason: MicRouteDegradedReason,
  targetLabel: string | null = null
): MicRoute {
  return {
    mode,
    audioConstraints: true,
    requestedDeviceId: null,
    targetLabel,
    degradedReason: reason
  }
}

function audioInputs(devices: readonly MediaDeviceInfo[]): readonly MediaDeviceInfo[] {
  return devices.filter((device) => device.kind === 'audioinput')
}

/** Resolve a native Windows communications endpoint into Chromium constraints. */
export function resolveMicRoute(
  prefs: Prefs,
  nativeSnapshot: AudioEndpointSnapshot | null,
  devices: readonly MediaDeviceInfo[]
): MicRoute {
  const inputs = audioInputs(devices)

  if (prefs.micRoutingMode === 'pinned') {
    if (!prefs.pinnedMicDeviceId) return fallback('pinned', 'pinned_device_not_selected')
    const selected = inputs.find((device) => device.deviceId === prefs.pinnedMicDeviceId)
    if (!selected) return fallback('pinned', 'pinned_device_missing')
    return {
      mode: 'pinned',
      audioConstraints: { deviceId: { exact: selected.deviceId } },
      requestedDeviceId: selected.deviceId,
      targetLabel: selected.label || null,
      degradedReason: null
    }
  }

  if (!nativeSnapshot) {
    return fallback('follow_communications', 'native_snapshot_unavailable')
  }
  const endpoint = nativeSnapshot.endpoints.captureCommunications
  if (!endpoint) {
    return fallback('follow_communications', 'communications_endpoint_unavailable')
  }

  const normalizedTarget = normalizeLabel(endpoint.label)
  const matches = inputs.filter(
    (device) => normalizeLabel(device.label) === normalizedTarget
  )
  if (matches.length === 0) {
    return fallback('follow_communications', 'communications_match_missing', endpoint.label)
  }
  if (matches.length > 1) {
    return fallback('follow_communications', 'communications_match_ambiguous', endpoint.label)
  }

  const selected = matches[0]
  return {
    mode: 'follow_communications',
    audioConstraints: { deviceId: { exact: selected.deviceId } },
    requestedDeviceId: selected.deviceId,
    targetLabel: selected.label || endpoint.label,
    degradedReason: null
  }
}
