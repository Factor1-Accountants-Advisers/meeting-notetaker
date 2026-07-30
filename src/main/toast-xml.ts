/**
 * Pure Windows toast XML builders.
 *
 * Electron's cross-platform `actions` array is macOS-only, so Windows action
 * buttons require raw toast XML (IN-124). Kept free of Electron imports so the
 * verify script can pin the XML shape under plain Node.
 */

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The "recording ends in 5 minutes" warning (IN-124 Extend button, IN-477
 * adjustments). `scenario="reminder"` pins the toast on screen until the user
 * acts — the transient default slid into the Action Center after ~5 s and was
 * routinely missed in tests. Reminder toasts need actionable buttons, so an
 * explicit Dismiss accompanies Extend. The toast itself is silent: the chime
 * is played by the renderer (`notification:chime` IPC), because custom audio
 * files in toast XML are not honoured for unpackaged win32 apps.
 */
export function buildEndingSoonToastXml(body: string): string {
  return (
    '<toast scenario="reminder" activationType="foreground" launch="mn-open">' +
    '<visual><binding template="ToastGeneric">' +
    '<text>Meeting Notetaker</text>' +
    `<text>${xmlEscape(body)}</text>` +
    '</binding></visual>' +
    '<audio silent="true"/>' +
    '<actions>' +
    '<action content="Extend 10 min" activationType="foreground" arguments="mn-extend"/>' +
    '<action content="Dismiss" activationType="system" arguments="dismiss"/>' +
    '</actions>' +
    '</toast>'
  )
}

/**
 * "Update {version} is ready." (IN-469). Buttons activate the app with
 * `mn-update-restart` / `mn-update-defer`, handled by the single-instance
 * hook in index.ts (same convention as `mn-extend`).
 */
export function buildUpdateReadyToastXml(version: string): string {
  return (
    '<toast activationType="foreground" launch="mn-open">' +
    '<visual><binding template="ToastGeneric">' +
    '<text>Meeting Notetaker</text>' +
    `<text>${xmlEscape(`Update ${version} is ready.`)}</text>` +
    '</binding></visual>' +
    '<audio silent="true"/>' +
    '<actions>' +
    '<action content="Restart now" activationType="foreground" arguments="mn-update-restart"/>' +
    '<action content="Later" activationType="foreground" arguments="mn-update-defer"/>' +
    '</actions>' +
    '</toast>'
  )
}

/**
 * Pre-install countdown (IN-469). `scenario="reminder"` pins it on screen for
 * the full countdown so "Not now" stays reachable — the transient default
 * slides into the Action Center after ~5 s (same rationale as ending-soon).
 */
export function buildUpdateCountdownToastXml(version: string, seconds: number): string {
  return (
    '<toast scenario="reminder" activationType="foreground" launch="mn-open">' +
    '<visual><binding template="ToastGeneric">' +
    '<text>Meeting Notetaker</text>' +
    `<text>${xmlEscape(`Restarting to update to ${version} in ${seconds} seconds…`)}</text>` +
    '</binding></visual>' +
    '<audio silent="true"/>' +
    '<actions>' +
    '<action content="Not now" activationType="foreground" arguments="mn-update-defer"/>' +
    '</actions>' +
    '</toast>'
  )
}
