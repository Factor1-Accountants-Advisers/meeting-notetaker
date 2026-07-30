import assert from 'node:assert/strict'
import {
  failedChipLabel,
  showUnconfirmedChip,
  type FailureChipInput
} from '../src/renderer/src/lib/failureDisplay'

function base(overrides: Partial<FailureChipInput> = {}): FailureChipInput {
  return {
    pipelineStatus: 'ready',
    processingErrorCode: null,
    blobStatus: 'uploaded',
    sharePointStatus: 'saved',
    sharePointErrorCode: null,
    deliveryStatus: 'emailed',
    deliveryErrorCode: null,
    blobErrorCode: null,
    ...overrides
  }
}

// Single failure -> correct label.
assert.equal(
  failedChipLabel(base({ blobStatus: 'failed', blobErrorCode: 'network' })),
  'Failed: Network',
  'single blob failure surfaces the Network label'
)

assert.equal(
  failedChipLabel(
    base({ pipelineStatus: 'failed', processingErrorCode: 'provider_credentials' })
  ),
  'Failed: Provider credentials',
  'processing-provider auth failure surfaces the Provider credentials label'
)

// Multi-failure -> worst-first ordering means processing wins.
assert.equal(
  failedChipLabel(
    base({
      pipelineStatus: 'failed',
      processingErrorCode: 'stalled',
      blobStatus: 'failed',
      blobErrorCode: 'network',
      sharePointStatus: 'failed',
      sharePointErrorCode: 'azure_signin',
      deliveryStatus: 'failed',
      deliveryErrorCode: 'service_unavailable'
    })
  ),
  'Failed: Stalled',
  'processing failure wins over blob/sharepoint/delivery (worst-first)'
)

// Legacy null code -> generic fallback.
assert.equal(
  failedChipLabel(base({ pipelineStatus: 'failed', processingErrorCode: null })),
  'Failed: Processing error',
  'legacy null error code falls back to "Processing error"'
)

// Unknown code string (newer server than this client knows about) -> same fallback.
assert.equal(
  failedChipLabel(base({ sharePointStatus: 'failed', sharePointErrorCode: 'quota_exceeded' })),
  'Failed: Processing error',
  'unrecognised code string falls back to "Processing error"'
)

// No failures -> no chip.
assert.equal(failedChipLabel(base()), null, 'nothing failed yields no chip')

// unconfirmed is not a failure: no Failed chip, but the unconfirmed chip shows.
const unconfirmed = base({ deliveryStatus: 'unconfirmed' })
assert.equal(failedChipLabel(unconfirmed), null, 'unconfirmed delivery never yields a Failed chip')
assert.equal(showUnconfirmedChip(unconfirmed), true, 'unconfirmed delivery shows the unconfirmed chip')

// unconfirmed + a real failure elsewhere -> both chips render together.
const both = base({ deliveryStatus: 'unconfirmed', blobStatus: 'failed', blobErrorCode: 'audio_problem' })
assert.equal(
  failedChipLabel(both),
  'Failed: Audio problem',
  'a genuine failure alongside unconfirmed email still yields the Failed chip'
)
assert.equal(showUnconfirmedChip(both), true, 'the unconfirmed chip still shows alongside the Failed chip')

console.log('Failure chip verification passed')
