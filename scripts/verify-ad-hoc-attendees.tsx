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
import {
  MENU_MAX_HEIGHT,
  MENU_MIN_HEIGHT,
  SELECT_ROW_HEIGHT,
  SUGGESTION_ROW_HEIGHT,
  clampActiveIndex,
  computeMenuPlacement,
  nextActiveIndex
} from '../src/renderer/src/lib/menuPlacement'
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

// --- Suggestion-menu placement (ported from SelectMenu, 6 Aug 2026) ---------
// A 600px-tall <main> viewport is the reference frame in every case below.
const VIEWPORT = { viewportTop: 0, viewportBottom: 600 }

// Roomy anchor near the top: opens downward, capped at MENU_MAX_HEIGHT.
const roomy = computeMenuPlacement({
  ...VIEWPORT,
  anchorTop: 100,
  anchorBottom: 128,
  itemCount: 6,
  itemHeight: SUGGESTION_ROW_HEIGHT
})
assert.equal(roomy.openUp, false, 'a menu that fits below opens downward')
assert.equal(roomy.maxHeight, MENU_MAX_HEIGHT, 'ample room is capped at the max height')

// Anchor pinned near the bottom with plenty of room above: flips up.
const tight = computeMenuPlacement({
  ...VIEWPORT,
  anchorTop: 520,
  anchorBottom: 548,
  itemCount: 6,
  itemHeight: SUGGESTION_ROW_HEIGHT
})
assert.equal(tight.openUp, true, 'no room below but room above flips the menu up')
assert.equal(tight.maxHeight, MENU_MAX_HEIGHT, 'flipped menus still cap at the max height')

// Squeezed both ways: still returns a usable height rather than a sliver.
const squeezed = computeMenuPlacement({
  viewportTop: 300,
  viewportBottom: 400,
  anchorTop: 330,
  anchorBottom: 358,
  itemCount: 6,
  itemHeight: SUGGESTION_ROW_HEIGHT
})
assert.equal(squeezed.maxHeight, MENU_MIN_HEIGHT, 'a cramped viewport falls back to the min height')

// Below-space wins ties. Sized so the menu genuinely does NOT fit either way
// (200px each side vs a 240px menu) — otherwise this passes for the wrong
// reason, by fitting below rather than by the tie-break.
const tied = computeMenuPlacement({
  viewportTop: 0,
  viewportBottom: 456,
  anchorTop: 208,
  anchorBottom: 248,
  itemCount: 6,
  itemHeight: SUGGESTION_ROW_HEIGHT
})
assert.equal(tied.openUp, false, 'equal space above and below opens downward')
assert.equal(tied.maxHeight, 200, 'a tied menu takes the space actually available')

// A short list that fits below never flips, even low in the viewport.
const shortList = computeMenuPlacement({
  ...VIEWPORT,
  anchorTop: 460,
  anchorBottom: 488,
  itemCount: 1,
  itemHeight: SUGGESTION_ROW_HEIGHT
})
assert.equal(shortList.openUp, false, 'a one-row menu that fits below stays below')

// The maxHeight cap is what forces internal scrolling: a full 6-row suggestion
// list is taller than the cap, so the menu must scroll rather than grow.
assert.ok(
  6 * SUGGESTION_ROW_HEIGHT > MENU_MAX_HEIGHT,
  'a full suggestion list exceeds the cap, so the menu scrolls internally'
)

// Parity: fed SelectMenu's own row height, the shared helper reproduces the
// numbers SelectMenu computed inline before the port.
const selectParity = computeMenuPlacement({
  ...VIEWPORT,
  anchorTop: 520,
  anchorBottom: 548,
  itemCount: 4,
  itemHeight: SELECT_ROW_HEIGHT
})
assert.deepEqual(
  selectParity,
  { openUp: true, maxHeight: 240 },
  'placement matches SelectMenu for SelectMenu-shaped input'
)

// --- Arrow-key traversal ----------------------------------------------------
assert.equal(nextActiveIndex(0, 1, 3), 1, 'ArrowDown advances')
assert.equal(nextActiveIndex(2, 1, 3), 0, 'ArrowDown wraps to the top')
assert.equal(nextActiveIndex(0, -1, 3), 2, 'ArrowUp wraps to the bottom')
assert.equal(nextActiveIndex(1, -1, 3), 0, 'ArrowUp retreats')
assert.equal(nextActiveIndex(0, 1, 0), 0, 'an empty menu has no active row')

// A remembered index survives the list shrinking as the query narrows.
assert.equal(clampActiveIndex(5, 2), 1, 'a stale index clamps onto the shorter list')
assert.equal(clampActiveIndex(0, 0), 0, 'an empty list clamps to zero')
assert.equal(clampActiveIndex(1, 4), 1, 'a valid index is left alone')

console.log('Ad-hoc attendee verification passed')
