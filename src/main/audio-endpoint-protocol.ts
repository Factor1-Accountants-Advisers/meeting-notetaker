import type {
  AudioEndpoint,
  AudioEndpointSet,
  AudioEndpointSnapshot
} from '../shared/audio-endpoints'

const ENDPOINT_KEYS = [
  'captureConsole',
  'captureCommunications',
  'renderConsole',
  'renderCommunications'
] as const satisfies readonly (keyof AudioEndpointSet)[]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseEndpoint(value: unknown): AudioEndpoint | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  if (typeof value.id !== 'string' || !value.id.trim()) return undefined
  if (typeof value.label !== 'string' || !value.label.trim()) return undefined
  return { id: value.id, label: value.label }
}

export function parseAudioEndpointLine(line: string): AudioEndpointSnapshot | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null
  if (raw.schemaVersion !== 1 || raw.kind !== 'snapshot') return null
  if (!Number.isSafeInteger(raw.generation) || Number(raw.generation) < 0) return null
  if (!isRecord(raw.endpoints)) return null

  const endpoints = {} as AudioEndpointSet
  for (const key of ENDPOINT_KEYS) {
    const endpoint = parseEndpoint(raw.endpoints[key])
    if (endpoint === undefined) return null
    endpoints[key] = endpoint
  }

  return {
    schemaVersion: 1,
    kind: 'snapshot',
    generation: Number(raw.generation),
    endpoints
  }
}
