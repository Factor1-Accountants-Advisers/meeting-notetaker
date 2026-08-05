import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AttendeePicker,
  MAX_MANUAL_ATTENDEES,
  addAttendee,
  filterAttendeeSuggestions,
  isValidAttendeeEmail,
  type ManualAttendee
} from '../src/renderer/src/components/AttendeePicker'
import { HomeScreen } from '../src/renderer/src/screens/HomeScreen'
import { enrollmentState } from '../src/renderer/src/lib/api'
import type { StaffMember } from '../src/renderer/src/data/mock'

const people: StaffMember[] = [
  {
    id: 'davidahlhaus@factor1.com.au',
    name: 'David Ahlhaus',
    role: 'Factor1 staff',
    tone: 'info',
    enrollment: 'enrolled',
    modelVersion: 'precision-2'
  },
  {
    id: 'benjaminbryant@factor1.com.au',
    name: 'Benjamin Bryant',
    role: 'Factor1 staff',
    tone: 'success',
    enrollment: 'enrolled',
    modelVersion: 'precision-2'
  },
  {
    id: 'notready@factor1.com.au',
    name: 'Not Enrolled',
    role: 'Factor1 staff',
    tone: 'secondary',
    enrollment: 'not_enrolled',
    modelVersion: null
  }
]

assert.equal(isValidAttendeeEmail(' david@factor1.com.au '), true)
assert.equal(isValidAttendeeEmail('not-an-email'), false)

const selected: ManualAttendee[] = []
const withDavid = addAttendee(selected, {
  name: ' David Ahlhaus ',
  email: ' DAVIDAHLHAUS@Factor1.com.au '
})
assert.deepEqual(withDavid, [
  {
    name: 'David Ahlhaus',
    email: 'davidahlhaus@factor1.com.au'
  }
])
assert.equal(
  addAttendee(withDavid, {
    name: 'Duplicate David',
    email: 'davidahlhaus@factor1.com.au'
  }),
  withDavid,
  'duplicate email returns the existing array'
)

assert.deepEqual(
  filterAttendeeSuggestions(people, 'ben', [] as ManualAttendee[]).map((person) => person.id),
  ['benjaminbryant@factor1.com.au']
)
assert.deepEqual(
  filterAttendeeSuggestions(people, '@factor1', withDavid).map((person) => person.id),
  ['benjaminbryant@factor1.com.au'],
  'selected and unenrolled people are excluded'
)

let capped: ManualAttendee[] = []
for (let index = 0; index < MAX_MANUAL_ATTENDEES; index += 1) {
  capped = addAttendee(capped, {
    name: `Person ${index}`,
    email: `person${index}@factor1.com.au`
  })
}
assert.equal(capped.length, MAX_MANUAL_ATTENDEES)
assert.equal(
  addAttendee(capped, {
    name: 'Over cap',
    email: 'overcap@factor1.com.au'
  }),
  capped
)

const picker = renderToStaticMarkup(
  <AttendeePicker
    people={people}
    selected={withDavid}
    onChange={() => undefined}
  />
)
assert.match(picker, /Attendees:/)
assert.match(picker, /David Ahlhaus/)
assert.match(picker, /aria-label="Remove David Ahlhaus"/)
assert.match(picker, /Add another person/)
assert.match(picker, /Search staff or enter a work email/)

const disabledPicker = renderToStaticMarkup(
  <AttendeePicker
    people={people}
    selected={withDavid}
    onChange={() => undefined}
    disabled
  />
)
assert.match(disabledPicker, /disabled/)

const home = renderToStaticMarkup(
  <HomeScreen
    previewMode
    onStartRecording={() => undefined}
    onUploadRecording={() => undefined}
  />
)
assert.match(home, /Add attendees/)
assert.match(home, /Optional/)
assert.match(home, /aria-expanded="false"/)

// Central cutover (5 Aug 2026): a colleague enrolled centrally but absent
// from the local registry must map to 'enrolled' — that is what puts them in
// the dropdown's suggestions. Local reenroll flags still win.
const centralDto = {
  employee_id: 'melissahall@factor1.com.au',
  display_name: 'Melissa Hall',
  role: 'Factor1 staff',
  enrolled: false,
  model_version: null,
  reenrollment_required: false,
  centrally_enrolled: true
}
assert.equal(enrollmentState(centralDto), 'enrolled')
assert.equal(enrollmentState({ ...centralDto, reenrollment_required: true }), 'reenroll_required')
assert.equal(enrollmentState({ ...centralDto, centrally_enrolled: false }), 'not_enrolled')
// A centrally enrolled colleague flows through to the suggestion list.
const centralMember: StaffMember = {
  id: centralDto.employee_id,
  name: centralDto.display_name,
  role: centralDto.role,
  tone: 'info',
  enrollment: enrollmentState(centralDto),
  modelVersion: null
}
assert.deepEqual(
  filterAttendeeSuggestions([centralMember], 'melissa', []).map((person) => person.id),
  ['melissahall@factor1.com.au']
)

console.log('Ad-hoc attendee verification passed')
