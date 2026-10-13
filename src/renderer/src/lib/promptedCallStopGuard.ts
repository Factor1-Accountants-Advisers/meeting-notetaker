/** Every automatic stop/retry is bound to the renderer's exact current capture. */
export function shouldHandleAutoStop(
  idempotencyKey: string,
  currentRecordingKey: string | null | undefined,
  currentCallNonce: string | null | undefined
): boolean {
  return Boolean(currentRecordingKey) && idempotencyKey === currentRecordingKey &&
    shouldHandlePromptedStop(idempotencyKey, currentCallNonce, true)
}

/** A late prompted-call stop IPC must not stop a new manual or scheduled capture. */
export function shouldHandlePromptedStop(
  idempotencyKey: string,
  currentCallNonce: string | null | undefined,
  hasActiveCapture: boolean
): boolean {
  if (!idempotencyKey.startsWith('teams-prompt-')) return true
  return hasActiveCapture && typeof currentCallNonce === 'string' &&
    idempotencyKey === 'teams-prompt-' + currentCallNonce
}
