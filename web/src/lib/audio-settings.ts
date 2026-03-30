const MIC_STORAGE_KEY = "settings:micName";
const LOOPBACK_STORAGE_KEY = "settings:loopbackName";
const DEFAULTS_APPLIED_KEY = "settings:defaultsApplied";

export interface SavedAudioSettings {
  micName: string;
  loopbackName: string;
}

export function readAudioSettings(): SavedAudioSettings {
  if (typeof window === "undefined") {
    return { micName: "", loopbackName: "" };
  }

  return {
    micName: window.localStorage.getItem(MIC_STORAGE_KEY) ?? "",
    loopbackName: window.localStorage.getItem(LOOPBACK_STORAGE_KEY) ?? "",
  };
}

export function saveAudioSettings(settings: SavedAudioSettings): void {
  window.localStorage.setItem(MIC_STORAGE_KEY, settings.micName);
  window.localStorage.setItem(LOOPBACK_STORAGE_KEY, settings.loopbackName);
}

export function hasCompleteAudioSettings(
  settings: SavedAudioSettings
): boolean {
  return (
    settings.micName.trim() !== "" && settings.loopbackName.trim() !== ""
  );
}

/**
 * Returns true if defaults have never been applied (first launch).
 * After calling applyDefaultsIfNeeded(), this will return false.
 */
export function needsDefaultAudioSettings(): boolean {
  if (typeof window === "undefined") return false;
  const current = readAudioSettings();
  const alreadyApplied = window.localStorage.getItem(DEFAULTS_APPLIED_KEY);
  return !alreadyApplied && !hasCompleteAudioSettings(current);
}

/**
 * Auto-populate audio settings from system defaults (once).
 * Returns the applied settings, or null if defaults were already set.
 */
export function applyDefaultAudioSettings(
  defaults: SavedAudioSettings
): SavedAudioSettings | null {
  if (typeof window === "undefined") return null;
  if (!needsDefaultAudioSettings()) return null;

  const current = readAudioSettings();
  const merged: SavedAudioSettings = {
    micName: current.micName || defaults.micName,
    loopbackName: current.loopbackName || defaults.loopbackName,
  };

  saveAudioSettings(merged);
  window.localStorage.setItem(DEFAULTS_APPLIED_KEY, "1");
  return merged;
}
