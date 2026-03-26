export interface ElectronAPI {
  getToken: () => Promise<string>;
  signOut: () => Promise<void>;
  getBackendUrl: () => Promise<string>;
  getAppVersion: () => string;
  isElectron: true;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

/**
 * Returns true when running inside Electron (preload-web.ts injected the bridge).
 * Returns false in a regular browser (dev server without Electron).
 */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI?.isElectron;
}

/**
 * Get the Electron API. Throws if not running in Electron.
 */
export function getElectronAPI(): ElectronAPI {
  if (!window.electronAPI) {
    throw new Error('electronAPI not available — not running in Electron');
  }
  return window.electronAPI;
}
