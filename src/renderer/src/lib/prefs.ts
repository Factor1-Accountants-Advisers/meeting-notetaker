/** Persisted user preferences (localStorage until per-user backend settings). */

export interface Prefs {
  micDeviceId: string // '' = system default
  language: string
}

const KEY = 'mn.prefs'
const DEFAULTS: Prefs = { micDeviceId: '', language: 'auto' }

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) } : { ...DEFAULTS }
  } catch {
    return { ...DEFAULTS }
  }
}

export function savePrefs(prefs: Prefs): void {
  localStorage.setItem(KEY, JSON.stringify(prefs))
}
