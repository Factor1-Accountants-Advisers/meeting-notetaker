import type {
  AudioEndpoint,
  AudioEndpointSet,
  AudioEndpointSnapshot,
  TeamsCallObservation
} from '../shared/audio-endpoints'

export const MAX_TEAMS_WINDOW_TITLES = 16
export const MAX_TEAMS_WINDOW_TITLE_LENGTH = 256

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

const TEAMS_CALL_KEYS = [
  'schemaVersion',
  'kind',
  'generation',
  'active',
  'preJoin',
  'windowTitles'
] as const

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value)
  return actualKeys.length === keys.length && keys.every((key) => actualKeys.includes(key))
}

export function parseTeamsCallLine(line: string): TeamsCallObservation | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(raw) || !hasExactKeys(raw, TEAMS_CALL_KEYS)) return null
  if (raw.schemaVersion !== 1 || raw.kind !== 'teams-call') return null
  if (
    typeof raw.generation !== 'number' ||
    !Number.isSafeInteger(raw.generation) ||
    raw.generation < 0
  ) {
    return null
  }
  if (raw.active !== null && typeof raw.active !== 'boolean') return null
  if (typeof raw.preJoin !== 'boolean') return null
  if (!Array.isArray(raw.windowTitles) || raw.windowTitles.length > MAX_TEAMS_WINDOW_TITLES) {
    return null
  }
  if (
    raw.windowTitles.some(
      (title) => typeof title !== 'string' || title.length > MAX_TEAMS_WINDOW_TITLE_LENGTH
    )
  ) {
    return null
  }

  return {
    schemaVersion: 1,
    kind: 'teams-call',
    generation: raw.generation,
    active: raw.active,
    preJoin: raw.preJoin,
    windowTitles: raw.windowTitles
  }
}
