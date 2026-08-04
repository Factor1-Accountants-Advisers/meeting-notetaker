/** Persisted user preferences (localStorage until per-user backend settings). */

export type MicRoutingMode = 'follow_communications' | 'pinned'

export interface Prefs {
  version: 2
  micRoutingMode: MicRoutingMode
  pinnedMicDeviceId: string
  language: string
}

const KEY = 'mn.prefs'
const DEFAULTS: Prefs = {
  version: 2,
  micRoutingMode: 'follow_communications',
  pinnedMicDeviceId: '',
  language: 'auto'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Migrate the original micDeviceId preference without preserving its pin. */
export function migratePrefs(value: unknown): Prefs {
  if (!isRecord(value)) return { ...DEFAULTS }

  const language = typeof value.language === 'string' ? value.language : DEFAULTS.language
  if (value.version === 2) {
    return {
      version: 2,
      micRoutingMode: value.micRoutingMode === 'pinned' ? 'pinned' : 'follow_communications',
      pinnedMicDeviceId:
        typeof value.pinnedMicDeviceId === 'string' ? value.pinnedMicDeviceId : '',
      language
    }
  }

  return {
    version: 2,
    micRoutingMode: 'follow_communications',
    pinnedMicDeviceId: typeof value.micDeviceId === 'string' ? value.micDeviceId : '',
    language
  }
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY)
    return migratePrefs(raw ? JSON.parse(raw) : null)
  } catch {
    return { ...DEFAULTS }
  }
}

export function savePrefs(prefs: Prefs): void {
  localStorage.setItem(KEY, JSON.stringify(migratePrefs(prefs)))
}
