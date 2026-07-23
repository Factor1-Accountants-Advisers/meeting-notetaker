import assert from 'node:assert/strict'
import { isStorageRoute, timeoutMsFor } from '../src/main/api-request-policy'
import { applyPublicEnvDefaults, PUBLIC_APP_CONFIG } from '../src/main/env'
import {
  getAccountOid,
  isStorageApiEnabled,
  storageTokenAcquireOptions,
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
assert.deepEqual(storageTokenAcquireOptions('api://example/access_as_user'), {
  scopes: ['api://example/access_as_user'],
  forceRefresh: true
})

assert.equal(
  PUBLIC_APP_CONFIG.MN_STORAGE_API_URL,
  'https://func-innov-nt-storage-prod-eqg7dzf8gfbqawea.australiaeast-01.azurewebsites.net'
)
assert.equal(
  PUBLIC_APP_CONFIG.MN_STORAGE_API_SCOPE,
  'api://13298042-714a-4d57-a1c5-481c22753087/access_as_user'
)

const emptyEnv: NodeJS.ProcessEnv = {}
applyPublicEnvDefaults(emptyEnv)
assert.equal(emptyEnv.MN_STORAGE_API_URL, PUBLIC_APP_CONFIG.MN_STORAGE_API_URL)
assert.equal(emptyEnv.MN_STORAGE_API_SCOPE, PUBLIC_APP_CONFIG.MN_STORAGE_API_SCOPE)

const overrideEnv: NodeJS.ProcessEnv = {
  MN_STORAGE_API_URL: 'https://override.example',
  MN_STORAGE_API_SCOPE: 'api://override/scope',
  MN_STORAGE_API_ENABLED: 'false'
}
applyPublicEnvDefaults(overrideEnv)
assert.equal(overrideEnv.MN_STORAGE_API_URL, 'https://override.example')
assert.equal(overrideEnv.MN_STORAGE_API_SCOPE, 'api://override/scope')
assert.equal(overrideEnv.MN_STORAGE_API_ENABLED, 'false')

console.log('Storage API cutover verification passed')
