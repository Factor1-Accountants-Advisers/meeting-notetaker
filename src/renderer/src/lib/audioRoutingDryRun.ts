/**
 * Dry-run half of the future active mic routing (v2.0.25). Computes what the
 * communications-device matcher WOULD pick and logs it; never touches capture.
 * Fleet telemetry from these lines validates the matcher (blank-label rate,
 * ambiguity rate) before any of it controls a stream — the v2.0.17 rollback
 * post-mortem is the reason this exists.
 */
import type { AudioEndpointSnapshot } from '../../../shared/audio-endpoints'

export type DryRunOutcome = 'matched' | 'labels_blank' | 'no_match' | 'ambiguous' | 'no_snapshot'

export interface DryRunMatch {
  outcome: DryRunOutcome
  deviceId: string | null
  deviceLabel: string | null
}

const PSEUDO_DEVICE_IDS = new Set(['default', 'communications'])

const normalizeLabel = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase()

export function resolveDryRunMatch(
  snapshot: AudioEndpointSnapshot | null,
  devices: MediaDeviceInfo[]
): DryRunMatch {
  const target = snapshot?.endpoints.captureCommunications
  if (!target) return { outcome: 'no_snapshot', deviceId: null, deviceLabel: null }

  const inputs = devices.filter(
    (d) => d.kind === 'audioinput' && !PSEUDO_DEVICE_IDS.has(d.deviceId)
  )
  if (inputs.length > 0 && inputs.every((d) => !d.label)) {
    return { outcome: 'labels_blank', deviceId: null, deviceLabel: null }
  }

  const wanted = normalizeLabel(target.label)
  const matches = inputs.filter((d) => normalizeLabel(d.label) === wanted)
  if (matches.length === 1) {
    return { outcome: 'matched', deviceId: matches[0].deviceId, deviceLabel: matches[0].label }
  }
  if (matches.length > 1) {
    // Distinct groupIds mean genuinely different hardware sharing a name —
    // ambiguous. A single shared groupId is duplicate enumerations of one
    // device, so the match is safe.
    const groups = new Set(matches.map((d) => d.groupId))
    if (groups.size === 1) {
      return { outcome: 'matched', deviceId: matches[0].deviceId, deviceLabel: matches[0].label }
    }
    return { outcome: 'ambiguous', deviceId: null, deviceLabel: null }
  }
  return { outcome: 'no_match', deviceId: null, deviceLabel: null }
}

export function formatDryRunLog(
  event: 'recording-start' | 'endpoint-change',
  snapshot: AudioEndpointSnapshot | null,
  match: Pick<DryRunMatch, 'outcome' | 'deviceId' | 'deviceLabel'>,
  activeMicLabel: string | null
): string {
  return JSON.stringify({
    event,
    generation: snapshot?.generation ?? null,
    commsCapture: snapshot?.endpoints.captureCommunications?.label ?? null,
    commsRender: snapshot?.endpoints.renderCommunications?.label ?? null,
    consoleCapture: snapshot?.endpoints.captureConsole?.label ?? null,
    outcome: match.outcome,
    wouldUse: match.deviceLabel,
    wouldUseId: match.deviceId,
    activeMic: activeMicLabel
  })
}
