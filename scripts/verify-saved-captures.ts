import assert from 'node:assert/strict'
import {
  primarySavedMeetingId,
  savedCaptureSetNames
} from '../src/main/recording-storage.ts'

// Resurface on restart (25 Aug 2026): the startup scan identifies saved
// capture sets by their primary `{uuid}.webm` and deletes/uploads the whole
// set together. Names are the contract between scan, retry, and cleanup.

assert.equal(
  primarySavedMeetingId('d579bc13-17eb-48ac-94e9-fe2ffbb079b4.webm'),
  'd579bc13-17eb-48ac-94e9-fe2ffbb079b4',
  'a bare uuid.webm is a primary capture'
)
assert.equal(
  primarySavedMeetingId('D579BC13-17EB-48AC-94E9-FE2FFBB079B4.webm'),
  'D579BC13-17EB-48AC-94E9-FE2FFBB079B4',
  'case-insensitive uuid match'
)
assert.equal(
  primarySavedMeetingId('d579bc13-17eb-48ac-94e9-fe2ffbb079b4.system.webm'),
  null,
  'system tracks are not primaries'
)
assert.equal(
  primarySavedMeetingId('d579bc13-17eb-48ac-94e9-fe2ffbb079b4.system.7550.webm'),
  null,
  'system segments are not primaries'
)
assert.equal(primarySavedMeetingId('notes.webm'), null, 'non-uuid names are ignored')
assert.equal(primarySavedMeetingId('spill'), null, 'directories are ignored')

const listing = [
  'd579bc13-17eb-48ac-94e9-fe2ffbb079b4.webm',
  'd579bc13-17eb-48ac-94e9-fe2ffbb079b4.system.webm',
  'd579bc13-17eb-48ac-94e9-fe2ffbb079b4.system.7550.webm',
  'd579bc13-17eb-48ac-94e9-fe2ffbb079b4.system.segments.json',
  '83722781-f737-44c8-8f53-f33b0e266714.webm',
  'spill'
]
assert.deepEqual(
  savedCaptureSetNames(listing, 'd579bc13-17eb-48ac-94e9-fe2ffbb079b4'),
  [
    'd579bc13-17eb-48ac-94e9-fe2ffbb079b4.webm',
    'd579bc13-17eb-48ac-94e9-fe2ffbb079b4.system.webm',
    'd579bc13-17eb-48ac-94e9-fe2ffbb079b4.system.7550.webm',
    'd579bc13-17eb-48ac-94e9-fe2ffbb079b4.system.segments.json'
  ],
  'the set covers mic, system tracks, segments, and manifest — nothing else'
)
assert.deepEqual(
  savedCaptureSetNames(listing, '83722781-f737-44c8-8f53-f33b0e266714'),
  ['83722781-f737-44c8-8f53-f33b0e266714.webm'],
  'sets never bleed across meetings'
)

console.log('Saved-capture verification passed')
