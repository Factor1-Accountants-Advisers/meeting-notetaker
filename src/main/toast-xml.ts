/**
 * Pure Windows toast XML builders.
 *
 * Electron's cross-platform `actions` array is macOS-only, so Windows action
 * buttons require raw toast XML (IN-124). Kept free of Electron imports so the
 * verify script can pin the XML shape under plain Node.
 *
 * Activation is PROTOCOL-based (IN-483): `activationType="foreground"` only
 * delivers button arguments to apps that register a COM activation callback,
 * which Electron does not implement — clicks were silently dropped (no
 * second-instance, no argv). Protocol activation is Microsoft's documented
 * path for desktop apps without a COM activator: the button launches a
 * `notetaker://` URI, Windows starts the registered handler, and the
 * single-instance lock converts that into a `second-instance` event whose
 * argv carries the URI.
 */

export const TOAST_PROTOCOL_SCHEME = 'notetaker'

export type ToastAction = 'open' | 'extend' | 'update-restart' | 'update-defer'

export function toastUri(action: ToastAction): string {
  return `${TOAST_PROTOCOL_SCHEME}://${action}`
}

/**
 * Extract the toast action from a process argv. Understands the current
 * `notetaker://<action>` URIs and the legacy `mn-*` foreground arguments
 * (still emitted by toasts shown by app versions before the IN-483 fix,
 * which can outlive the update that fixes them).
 */
export function toastActionFromArgv(argv: readonly string[]): ToastAction | null {
  for (const raw of argv) {
    const arg = raw.replace(/\/$/, '')
    if (arg === toastUri('extend') || arg === 'mn-extend') return 'extend'
    if (arg === toastUri('update-restart') || arg === 'mn-update-restart') return 'update-restart'
    if (arg === toastUri('update-defer') || arg === 'mn-update-defer') return 'update-defer'
    if (arg === toastUri('open') || arg === 'mn-open') return 'open'
  }
  return null
}

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
    `<toast scenario="reminder" activationType="protocol" launch="${toastUri('open')}">` +
    '<visual><binding template="ToastGeneric">' +
    '<text>Meeting Notetaker</text>' +
    `<text>${xmlEscape(body)}</text>` +
    '</binding></visual>' +
    '<audio silent="true"/>' +
    '<actions>' +
    `<action content="Extend 10 min" activationType="protocol" arguments="${toastUri('extend')}"/>` +
    '<action content="Dismiss" activationType="system" arguments="dismiss"/>' +
    '</actions>' +
    '</toast>'
  )
}

/**
 * "Update {version} is ready." (IN-469). Buttons launch `notetaker://` URIs
 * handled by the single-instance hook in index.ts (same convention as the
 * Extend button).
 */
export function buildUpdateReadyToastXml(version: string): string {
  return (
    `<toast activationType="protocol" launch="${toastUri('open')}">` +
    '<visual><binding template="ToastGeneric">' +
    '<text>Meeting Notetaker</text>' +
    `<text>${xmlEscape(`Update ${version} is ready.`)}</text>` +
    '</binding></visual>' +
    '<audio silent="true"/>' +
    '<actions>' +
    `<action content="Restart now" activationType="protocol" arguments="${toastUri('update-restart')}"/>` +
    `<action content="Later" activationType="protocol" arguments="${toastUri('update-defer')}"/>` +
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
    `<toast scenario="reminder" activationType="protocol" launch="${toastUri('open')}">` +
    '<visual><binding template="ToastGeneric">' +
    '<text>Meeting Notetaker</text>' +
    `<text>${xmlEscape(`Restarting to update to ${version} in ${seconds} seconds…`)}</text>` +
    '</binding></visual>' +
    '<audio silent="true"/>' +
    '<actions>' +
    `<action content="Not now" activationType="protocol" arguments="${toastUri('update-defer')}"/>` +
    '</actions>' +
    '</toast>'
  )
}
