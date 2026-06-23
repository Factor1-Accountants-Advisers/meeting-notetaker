import assert from 'node:assert/strict';
import { filterInternalRecipients, isAllowedInternalDomain, parseRecipientList } from './recipient-filter.mjs';

assert.equal(isAllowedInternalDomain('Joseph@Factor1.com.au'), true);
assert.equal(isAllowedInternalDomain('client@external.com'), false);
assert.equal(isAllowedInternalDomain('not-an-email'), false);

const { allowed, rejected } = filterInternalRecipients([
  { email: 'joseph@factor1.com.au', name: 'Joseph' },
  { email: 'client@bigcorp.com', name: 'Client' },
  { email: 'david@factor1.com.au', name: 'David' },
  { email: '', name: 'Empty' },
]);

assert.deepEqual(allowed.map((r) => r.email), ['joseph@factor1.com.au', 'david@factor1.com.au']);
assert.equal(rejected.length, 2);

assert.deepEqual(parseRecipientList('a@factor1.com.au, b@external.com'), [
  { email: 'a@factor1.com.au', name: 'a' },
  { email: 'b@external.com', name: 'b' },
]);

console.log('recipient-filter tests passed');
