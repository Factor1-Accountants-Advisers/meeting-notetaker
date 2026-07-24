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
assert.match(picker, /People attending/)
assert.match(picker, /optional/i)
assert.match(picker, /David Ahlhaus/)
assert.match(picker, /aria-label="Remove David Ahlhaus"/)

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
    userName="Joseph Guerrero"
    onStartRecording={() => undefined}
    onUploadRecording={() => undefined}
  />
)
assert.match(home, /People attending/)

console.log('Ad-hoc attendee verification passed')
