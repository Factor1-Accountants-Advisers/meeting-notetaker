/** Persisted user preferences (localStorage until per-user backend settings). */

export interface Prefs {
  micDeviceId: string // '' = system default
  language: string
  /**
   * Follow the Windows *communications* capture endpoint (what Teams uses) for
   * the mic instead of the console default — the reliable fix for Bluetooth /
   * AirPods "my mic wasn't recorded". Default on since 2.0.36: validated
   * 2 Sep 2026 on AirPods (mic captured, transcript + voiceprint match at
   * 0.77 through the alias). Set to false to restore the console-default
   * capture. See micDeviceChoice.
   */
  followCommunicationsMic: boolean
}

const KEY = 'mn.prefs'
const DEFAULTS: Prefs = { micDeviceId: '', language: 'auto', followCommunicationsMic: true }

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
