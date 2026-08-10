// IN-472 fix: picks the tray icon that stays visible against the current Windows
// taskbar. Pure logic — no Electron imports — so verify-tray-icon.ts can pin
// the truth table without booting an app.
//
// Background: IN-472 shipped a single pure-white silhouette. White on Windows
// 11's light taskbar is invisible, so every user not on dark mode saw a blank
// tray slot. The fix is a theme-paired icon plus a resolver that decides which
// one to show.

import { join } from 'node:path'

/** The taskbar theme an icon is drawn FOR (not the colour of the glyph). */
export type TrayTheme = 'light' | 'dark'

/**
 * Everything we can learn about the user's theme, gathered by tray.ts.
 *
 * Windows 11 exposes TWO independent theme settings under
 * HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize:
 *
 *   SystemUsesLightTheme -> Start menu, taskbar, and THE NOTIFICATION AREA
 *   AppsUseLightTheme    -> application windows
 *
 * Settings > Personalisation > Colours > "Custom" lets a user set these to
 * opposite values, which is exactly the case a naive implementation gets wrong.
 */
export interface TrayThemeSignals {
  /** SystemUsesLightTheme. `null` when the registry could not be read. */
  systemUsesLightTheme: boolean | null
  /** AppsUseLightTheme. `null` when the registry could not be read. */
  appsUseLightTheme: boolean | null
  /**
   * Electron's `nativeTheme.shouldUseDarkColors`. Always present, but on
   * Windows it tracks the APP theme, not the taskbar — so it is the fallback,
   * not the primary signal.
   */
  electronPrefersDark: boolean
}

/**
 * Decide which icon variant to show, most authoritative signal first.
 *
 * Measured on Windows 11 with Electron 33.4.11: flipping SystemUsesLightTheme
 * raises nativeTheme's 'updated' but does NOT move shouldUseDarkColors, while
 * flipping AppsUseLightTheme moves it. That is why the registry value leads and
 * Electron's signal is last — picking Electron's would put a white glyph on a
 * light taskbar for anyone in Custom colour mode, i.e. the IN-472 bug again.
 *
 * Every branch returns a valid theme and none can throw: a bad return here
 * means an invisible icon, so the null cases are handled explicitly rather
 * than left to a default.
 */
export function resolveTrayTheme(signals: TrayThemeSignals): TrayTheme {
  // The notification area is part of the taskbar, so this is the real answer.
  if (signals.systemUsesLightTheme !== null) {
    return signals.systemUsesLightTheme ? 'light' : 'dark'
  }

  // Registry partially unreadable. The app theme is a good proxy — it differs
  // only in Custom colour mode — and it is preferred over Electron's signal
  // because a future nativeTheme.themeSource override (an in-app "force dark"
  // setting) would detach shouldUseDarkColors from the OS entirely, whereas
  // this registry value always reflects what Windows is actually doing.
  if (signals.appsUseLightTheme !== null) {
    return signals.appsUseLightTheme ? 'light' : 'dark'
  }

  // Registry fully unreadable (locked-down profile, or not Windows at all).
  // Electron's signal is all that is left; it matches the taskbar for everyone
  // not in Custom colour mode, which is the overwhelming majority.
  return signals.electronPrefersDark ? 'dark' : 'light'
}

/** Icon filename for a taskbar theme. Both live in resources/. */
export function trayIconFileName(theme: TrayTheme): string {
  return `tray-icon-${theme}.ico`
}

export interface TrayIconPaths {
  /** app.isPackaged */
  isPackaged: boolean
  /** process.resourcesPath — where extraResources land in a packaged build. */
  resourcesPath: string
  /** __dirname of the built main bundle (out/main in dev). */
  mainDir: string
}

/**
 * Absolute path to the icon for `theme`.
 *
 * Packaged: electron-builder copies resources/ entries to resourcesPath root.
 * Dev: out/main/../../resources — matches how IN-472 resolved the old PNG.
 */
export function trayIconPath(theme: TrayTheme, paths: TrayIconPaths): string {
  const file = trayIconFileName(theme)
  return paths.isPackaged
    ? join(paths.resourcesPath, file)
    : join(paths.mainDir, '..', '..', 'resources', file)
}

/**
 * Parse a REG_DWORD out of `reg query` output into a boolean.
 * Exported for the verify script — the registry read itself lives in tray.ts,
 * using the fixed-argument, no-shell pattern from backend-supervisor.ts.
 *
 * Expected shape:  "    AppsUseLightTheme    REG_DWORD    0x1"
 * Returns null for anything unparsable, which the resolver must tolerate.
 */
export function parseRegDword(output: string, valueName: string): boolean | null {
  const match = new RegExp(`${valueName}\\s+REG_DWORD\\s+0x([0-9a-fA-F]+)`).exec(output)
  if (!match) return null
  return Number.parseInt(match[1], 16) !== 0
}
