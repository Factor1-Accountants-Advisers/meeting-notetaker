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

export type ToastAction =
  | 'open'
  | 'extend'
  | 'update-restart'
  | 'update-defer'
  | 'upload-now'
  | 'resume-recording'
  | 'record-now'

export function toastUri(action: ToastAction): string {
  return `${TOAST_PROTOCOL_SCHEME}://${action}`
}

/**
 * Extract the toast action from a process argv. Understands the current
 * `notetaker://<action>` URIs and the legacy `mn-*` foreground arguments
 * (still emitted by toasts shown by app versions before the IN-483 fix,
 * which can outlive the update that fixes them). `upload-now`,
 * `resume-recording`, and `record-now` postdate that fix, so they have no
 * legacy `mn-*` form.
 */
export function toastActionFromArgv(argv: readonly string[]): ToastAction | null {
  for (const raw of argv) {
    const arg = raw.replace(/\/$/, '')
    if (arg === toastUri('extend') || arg === 'mn-extend') return 'extend'
    if (arg === toastUri('update-restart') || arg === 'mn-update-restart') return 'update-restart'
    if (arg === toastUri('update-defer') || arg === 'mn-update-defer') return 'update-defer'
    if (arg === toastUri('open') || arg === 'mn-open') return 'open'
    if (arg === toastUri('upload-now')) return 'upload-now'
    if (arg === toastUri('resume-recording')) return 'resume-recording'
    if (arg === toastUri('record-now')) return 'record-now'
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
 * "Recording paused because you left the meeting" prompt (meeting-call-events,
 * spec 2026-08-12). scenario="reminder" pins it on screen until the user acts,
 * same rationale as buildEndingSoonToastXml. Silent audio: the renderer plays
 * the chime via the notification:chime IPC (see notifyMeetingEndingSoon).
 */
export function buildRecordingPausedToastXml(body: string): string {
  return (
    `<toast scenario="reminder" activationType="protocol" launch="${toastUri('open')}">` +
    '<visual><binding template="ToastGeneric">' +
    '<text>Meeting Notetaker</text>' +
    `<text>${xmlEscape(body)}</text>` +
    '</binding></visual>' +
    '<audio silent="true"/>' +
    '<actions>' +
    `<action content="Upload now" activationType="protocol" arguments="${toastUri('upload-now')}"/>` +
    `<action content="Keep recording" activationType="protocol" arguments="${toastUri('resume-recording')}"/>` +
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

/**
 * Join-trigger prompt (spec J3): shown once at start + 2 min when the
 * meeting is armed and nothing is recording — the fail-closed path for
 * hybrid/in-room meetings and blind watches. `scenario="reminder"` keeps
 * it on screen; the runtime closes it after JOIN_WATCH_PROMPT_LIFETIME_MS
 * (transient toasts slide into Action Center after ~5 s, same rationale as
 * the paused toast). An empty `title` (Graph gave no subject) gets plain
 * wording rather than "Meeting  has started" with a hole in it.
 */
export function buildJoinPromptToastXml(title: string): string {
  const headline = title ? `Meeting ${xmlEscape(title)} has started` : 'Your meeting has started'
  return (
    `<toast scenario="reminder" activationType="protocol" launch="${toastUri('open')}">` +
    '<visual><binding template="ToastGeneric">' +
    `<text>${headline}</text>` +
    '<text>Recording will begin when you join.</text>' +
    '</binding></visual>' +
    '<audio silent="true"/>' +
    '<actions>' +
    `<action content="Record now" activationType="protocol" arguments="${toastUri('record-now')}"/>` +
    '</actions>' +
    '</toast>'
  )
}

/**
 * On-screen lifetimes for the app's `scenario="reminder"` toasts (notifications
 * review with DA, 19 Aug 2026). Reminder toasts are sticky by design — the
 * transient default slid into the Action Center after ~5 s and was routinely
 * missed — so the runtime closes them itself: 2 min as the standard, and the
 * full 5 min for the ending-soon warning, which also goes the moment the
 * recording stops or is extended (a stale "ends in 5 minutes" is worse than
 * none). The join prompt (`JOIN_WATCH_PROMPT_LIFETIME_MS`) follows the
 * standard.
 */
export const TOAST_LIFETIME_MS = 2 * 60_000
export const ENDING_SOON_TOAST_LIFETIME_MS = 5 * 60_000

/**
 * "Recording started" (IN-83 reworked, 19 Aug 2026 with DA): shown on every
 * auto-triggered start — join, prompt, or calendar — as the confirmation that
 * the trigger fired (an early joiner learns from its absence) and as the cue
 * to tell everyone the meeting is being recorded. Sticky like the others;
 * recording-ipc closes it after TOAST_LIFETIME_MS or when the recording ends.
 * Manual starts are not toasted: the user is in the app window when they
 * click Record.
 */
export function buildRecordingStartedToastXml(title: string): string {
  const what = title ? `Recording ${xmlEscape(title)}.` : 'Meeting Notetaker is recording.'
  return (
    `<toast scenario="reminder" activationType="protocol" launch="${toastUri('open')}">` +
    '<visual><binding template="ToastGeneric">' +
    '<text>Recording started</text>' +
    `<text>${what}</text>` +
    '<text>Let everyone in the meeting know it is being recorded.</text>' +
    '</binding></visual>' +
    '<audio silent="true"/>' +
    '<actions>' +
    '<action content="Dismiss" activationType="system" arguments="dismiss"/>' +
    '</actions>' +
    '</toast>'
  )
}
