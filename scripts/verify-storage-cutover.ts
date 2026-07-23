import assert from 'node:assert/strict'
import { isStorageRoute, timeoutMsFor } from '../src/main/api-request-policy'
import {
  getAccountOid,
  isStorageApiEnabled,
  storageIdentityHeaders
} from '../src/main/storage-api-identity'

assert.equal(getAccountOid({ idTokenClaims: { oid: ' oid-from-claim ' } }), 'oid-from-claim')
assert.equal(
  getAccountOid({ idTokenClaims: {}, localAccountId: ' cached-local-oid ' }),
  'cached-local-oid'
)
assert.equal(getAccountOid({ idTokenClaims: { oid: '   ' }, localAccountId: '   ' }), undefined)

assert.equal(isStorageApiEnabled({}), true)
assert.equal(isStorageApiEnabled({ MN_STORAGE_API_ENABLED: 'false' }), false)
assert.equal(isStorageApiEnabled({ MN_STORAGE_API_ENABLED: ' FALSE ' }), false)

assert.equal(
  isStorageRoute({ method: 'GET', path: '/api/v1/people/me/enrolment-status?refresh=1' }),
  true
)
assert.equal(
  isStorageRoute({ method: 'POST', path: '/api/v1/people/joseph%40factor1.com.au/enroll' }),
  true
)
assert.equal(
  isStorageRoute({
    method: 'POST',
    path: '/api/v1/people/joseph%40factor1.com.au/flag-reenrollment'
  }),
  false
)
assert.equal(
  timeoutMsFor({ method: 'POST', path: '/api/v1/people/joseph%40factor1.com.au/enroll' }),
  180_000
)

assert.deepEqual(
  storageIdentityHeaders({
    email: ' joseph@factor1.com.au ',
    oid: ' oid-123 ',
    accessToken: ' token-value '
  }),
  {
    'X-MN-User-Email': 'joseph@factor1.com.au',
    'X-MN-User-Oid': 'oid-123',
    'X-MN-Storage-Token': 'token-value'
  }
)
assert.deepEqual(storageIdentityHeaders({ email: 'joseph@factor1.com.au' }), {
  'X-MN-User-Email': 'joseph@factor1.com.au'
})

console.log('Storage API cutover verification passed')
