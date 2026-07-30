export type FailureCategory =
  | 'network'
  | 'azure_signin'
  | 'provider_credentials'
  | 'service_unavailable'
  | 'audio_problem'
  | 'processing_error'
  | 'interrupted'
  | 'stalled'

export const CATEGORY_LABELS: Record<FailureCategory, string> = {
  network: 'Network',
  azure_signin: 'Microsoft sign-in',
  provider_credentials: 'Provider credentials',
  service_unavailable: 'Service unavailable',
  audio_problem: 'Audio problem',
  processing_error: 'Processing error',
  interrupted: 'Interrupted',
  stalled: 'Stalled'
}

export interface FailureChipInput {
  pipelineStatus: string
  processingErrorCode: string | null
  blobStatus: string
  blobErrorCode: string | null
  sharePointStatus: string
  sharePointErrorCode: string | null
  deliveryStatus: string
  deliveryErrorCode: string | null
}

// Worst-first (spec §3): processing → blob → sharepoint → email.
// Returns the single card chip label, or null when nothing has failed.
// `unconfirmed` is NOT a failure and never yields a Failed chip.
export function failedChipLabel(m: FailureChipInput): string | null {
  const ordered: Array<[string, string | null]> = [
    [m.pipelineStatus, m.processingErrorCode],
    [m.blobStatus, m.blobErrorCode],
    [m.sharePointStatus, m.sharePointErrorCode],
    [m.deliveryStatus, m.deliveryErrorCode]
  ]
  for (const [status, code] of ordered) {
    if (status === 'failed') {
      return `Failed: ${categoryLabel(code)}`
    }
  }
  return null
}

export function showUnconfirmedChip(m: FailureChipInput): boolean {
  return m.deliveryStatus === 'unconfirmed'
}

/** Same code→label fallback as failedChipLabel, exposed for per-concern rows
 * (review screen) that need the label without the "Failed: " prefix. */
export function categoryLabel(code: string | null): string {
  return code && code in CATEGORY_LABELS ? CATEGORY_LABELS[code as FailureCategory] : 'Processing error'
}
