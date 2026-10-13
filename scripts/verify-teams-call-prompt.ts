import assert from 'node:assert/strict'
import {
  createTeamsCallCore,
  isPromptedTeamsCallRecording,
  readTeamsCallPromptEnabled,
  type TeamsCallCalendarDecision,
  type TeamsCallObservation
} from '../src/main/teams-call-core'
import { buildTeamsCallPromptToastXml, buildTeamsCallUncertaintyToastXml, parseToastArgv, teamsCallDecisionToastUri, teamsCallToastUri } from '../src/main/toast-xml'
import { shouldHandlePromptedStop } from '../src/renderer/src/lib/promptedCallStopGuard'

type Timer = { at: number; fn: () => void; cancelled: boolean }

function harness(options: { enabled?: boolean; calendarStaleMs?: number; observationStaleMs?: number } = {}) {
  let now = 1_000_000
  const timers: Timer[] = []
  const prompts: string[] = []
  const starts: Array<{ nonce: string; startedAtUtc: string; title: string }> = []
  const ends: Array<{ nonce: string; endedAtUtc: string }> = []
  let stops = 0
  let recordingActive = false
  let paused = false
  const pauses: string[] = []
  const resumes: string[] = []
  const uncertainPrompts: Array<{ callNonce: string; decisionNonce: string }> = []
  let ready = true
  let signedIn = true
  let unavailable = false
  const schedule = (fn: () => void, ms: number): Timer => {
    const timer = { at: now + ms, fn, cancelled: false }
    timers.push(timer)
    return timer
  }
  const cancel = (timer: Timer): void => { timer.cancelled = true }
  const advance = (ms: number): void => {
    now += ms
    for (;;) {
      const next = timers.filter((timer) => !timer.cancelled && timer.at <= now).sort((a, b) => a.at - b.at)[0]
      if (!next) return
      next.cancelled = true
      next.fn()
    }
  }
  const core = createTeamsCallCore({
    enabled: options.enabled ?? true,
    now: () => now,
    isRecordingActive: () => recordingActive,
    isCurrentRecording: (call) => recordingActive && starts.some((start) => start.nonce === call.nonce),
    isRecordingPaused: () => paused,
    isReady: () => ready && signedIn,
    timers: { setTimeout: schedule, clearTimeout: cancel },
    promptDelayMs: 5_000,
    falseObservationDebounceMs: 1_000,
    calendarStaleMs: options.calendarStaleMs ?? 60_000,
    observationStaleMs: options.observationStaleMs,
    actions: {
      showPrompt: (call) => prompts.push(call.nonce),
      closePrompt: () => undefined,
      start: (call) => {
        starts.push(call)
        recordingActive = true
        return true
      },
      observedEnd: (call, endedAtUtc) => ends.push({ nonce: call.nonce, endedAtUtc }),
      pause: (call) => { pauses.push(call.nonce) },
      resume: (call) => { resumes.push(call.nonce) },
      showUncertainty: (call, decisionNonce) => uncertainPrompts.push({ callNonce: call.nonce, decisionNonce }),
      closeUncertainty: () => undefined,
      stop: () => { stops += 1; recordingActive = false; paused = false }
    }
  })
  return {
    core,
    prompts,
    starts,
    ends,
    pauses,
    resumes,
    uncertainPrompts,
    pauseAck: () => { paused = true; core.onRecordingPaused() },
    get stops() { return stops },
    set recordingActive(value: boolean) { recordingActive = value },
    set paused(value: boolean) { paused = value },
    set ready(value: boolean) { ready = value },
    set signedIn(value: boolean) { signedIn = value },
    set unavailable(value: boolean) { unavailable = value },
    advance,
    now: () => now
  }
}

const connected = (title = 'Alex External | Microsoft Teams'): TeamsCallObservation => ({
  schemaVersion: 1,
  kind: 'teams-call',
  generation: 1,
  active: true,
  preJoin: false,
  windowTitles: [title]
})

const disconnected: TeamsCallObservation = {
  ...connected(),
  active: false,
  windowTitles: []
}

function calendar(title: string, startMs: number, endMs: number, reason: TeamsCallCalendarDecision['reason'] = 'eligible'): TeamsCallCalendarDecision {
  return {
    title,
    startUtc: new Date(startMs).toISOString(),
    endUtc: new Date(endMs).toISOString(),
    status: reason === 'not_organizer' ? 'candidate' : 'candidate',
    reason
  }
}

function testConnectionDelayAndAcceptance(): void {
  const h = harness()
  h.core.setCalendar([{ ...calendar('Other non-Teams meeting', 900_000, 1_100_000), isTeamsMeeting: false }], h.now())
  h.core.observe(connected())
  h.advance(4_999)
  assert.deepEqual(h.prompts, [])
  h.advance(1)
  assert.equal(h.prompts.length, 1)
  assert.equal(h.core.accept(h.prompts[0]), true)
  assert.equal(h.starts.length, 1)
}

function testPrejoinDoesNotPromptUntilJoined(): void {
  const h = harness()
  h.core.setCalendar([], h.now())
  h.core.observe({ ...connected(), preJoin: true })
  h.advance(6_000)
  assert.deepEqual(h.prompts, [])
  h.core.observe(connected())
  h.advance(5_000)
  assert.equal(h.prompts.length, 1)
}

function testRingingMuteAndDeclineDoNotPrompt(): void {
  const h = harness()
  h.core.setCalendar([], h.now())
  h.core.observe({ ...connected(), active: false })
  h.advance(6_000)
  assert.deepEqual(h.prompts, [])
  h.core.observe({ ...connected(), active: true })
  h.advance(5_000)
  assert.equal(h.prompts.length, 1)
  h.core.observe({ ...connected(), active: false })
  h.advance(1_001)
  assert.equal(h.stops, 0)
}

function testActiveManualPausedAndPendingAutoSuppress(): void {
  const h = harness()
  h.core.setCalendar([], h.now())
  h.recordingActive = true
  h.core.observe(connected())
  h.advance(6_000)
  assert.deepEqual(h.prompts, [])
}

function testScheduledHostAndAttendeeSuppress(): void {
  const h = harness()
  const start = h.now() - 1_000
  h.core.setCalendar([
    calendar('Scheduled host | Microsoft Teams', start, h.now() + 60_000),
    calendar('Scheduled attendee | Microsoft Teams', start, h.now() + 60_000, 'not_organizer')
  ], h.now())
  h.core.observe(connected('Scheduled host | Microsoft Teams'))
  h.advance(6_000)
  assert.deepEqual(h.prompts, [])
  h.core.observe({ ...connected('Scheduled attendee | Microsoft Teams'), generation: 2 })
  h.advance(6_000)
  assert.deepEqual(h.prompts, [])
}

function testUnknownStaleAndAmbiguousCalendarFailClosed(): void {
  const h = harness({ calendarStaleMs: 100 })
  h.core.observe(connected())
  h.advance(6_000)
  assert.deepEqual(h.prompts, [])
  const g = harness({ calendarStaleMs: 100 })
  g.core.setCalendar([calendar('Known', g.now() - 1_000, g.now() + 50_000)], g.now())
  g.advance(101)
  g.core.observe(connected())
  g.advance(6_000)
  assert.deepEqual(g.prompts, [])
  const a = harness()
  a.core.setCalendar([
    calendar('Alex External | Microsoft Teams', a.now() - 1_000, a.now() + 60_000),
    calendar('Alex External | Microsoft Teams', a.now() - 1_000, a.now() + 60_000)
  ], a.now())
  a.core.observe(connected())
  a.advance(6_000)
  assert.deepEqual(a.prompts, [])
}

function testStaleClickAndObserverFailureCannotStop(): void {
  const h = harness()
  h.core.setCalendar([], h.now())
  h.core.observe(connected())
  h.advance(5_000)
  const nonce = h.prompts[0]
  h.core.observerUnavailable()
  assert.equal(h.core.accept(nonce), false)
  h.core.observe(disconnected)
  h.advance(2_000)
  assert.equal(h.stops, 0)
}

function testObserverGenerationResetCannotStopOnUnknown(): void {
  const h = harness()
  h.core.setCalendar([], h.now())
  h.core.observe(connected())
  h.advance(5_000)
  assert.equal(h.core.accept(h.prompts[0]), true)
  h.core.observerUnavailable()
  h.core.observe({ ...disconnected, active: null, generation: 1 })
  h.advance(2_000)
  assert.equal(h.stops, 0)
  h.core.observe({ ...disconnected, generation: 2 })
  h.advance(1_000)
  assert.equal(h.stops, 0, 'after observer replacement a false signal cannot identify the original call')
  assert.equal(h.ends.length, 0)
}

function testHangupStopsAndEndsExactlyOnce(): void {
  const h = harness()
  h.core.setCalendar([], h.now())
  h.core.observe(connected())
  h.advance(5_000)
  const nonce = h.prompts[0]
  assert.equal(h.core.accept(nonce), true)
  h.core.observe(disconnected)
  h.advance(999)
  assert.equal(h.stops, 0)
  h.advance(1)
  assert.equal(h.stops, 1)
  assert.equal(h.ends.length, 1)
  h.core.observe(disconnected)
  h.advance(2_000)
  assert.equal(h.stops, 1)
}

function testOnePromptPerConnectionAndReadiness(): void {
  const h = harness()
  h.core.setCalendar([], h.now())
  h.ready = false
  h.core.observe(connected())
  h.advance(6_000)
  assert.deepEqual(h.prompts, [])
  h.ready = true
  h.core.observe(connected())
  h.advance(6_000)
  assert.equal(h.prompts.length, 1)
  h.core.observe(disconnected)
  h.advance(1_000)
  h.core.observe({ ...connected(), generation: 2 })
  h.advance(5_000)
  assert.equal(h.prompts.length, 2)
}

function testFeatureDefaultsOff(): void {
  const h = harness({ enabled: false })
  h.core.setCalendar([], h.now())
  h.core.observe(connected())
  h.advance(6_000)
  assert.deepEqual(h.prompts, [])
}

function testFlagLayersAndTitleExclusions(): void {
  assert.equal(readTeamsCallPromptEnabled({}, {}), false)
  assert.equal(readTeamsCallPromptEnabled({}, { MN_TEAMS_CALL_PROMPT_ENABLED: 'true' }), true)
  assert.equal(
    readTeamsCallPromptEnabled(
      { MN_TEAMS_CALL_PROMPT_ENABLED: 'true' },
      { MN_TEAMS_CALL_PROMPT_ENABLED: 'false' }
    ),
    true
  )
  assert.equal(readTeamsCallPromptEnabled({ MN_TEAMS_CALL_PROMPT_ENABLED: 'FALSE' }, {}), false)
  const h = harness()
  h.core.setCalendar([], h.now())
  h.core.observe({ ...connected(), windowTitles: ['Chat | Microsoft Teams', 'Calendar | Microsoft Teams'] })
  h.advance(6_000)
  assert.deepEqual(h.prompts, [])
}

function testToastNonceRoundTrip(): void {
  const nonce = 'teams-call-17'
  const uri = teamsCallToastUri('accept', nonce)
  assert.deepEqual(parseToastArgv([uri]), { action: 'teams-call-accept', meetingId: null, callNonce: nonce })
  assert.match(buildTeamsCallPromptToastXml('Alex External', nonce), new RegExp(uri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal(parseToastArgv([teamsCallToastUri('accept', 'old')])?.callNonce, 'old')
}

function testFailureCancelsPendingHangup(): void {
  const h = harness()
  h.core.setCalendar([], h.now())
  h.core.observe(connected())
  h.advance(5_000)
  assert.equal(h.core.accept(h.prompts[0]), true)
  h.core.observe(disconnected)
  h.core.observerUnavailable()
  h.advance(2_000)
  assert.equal(h.stops, 0)
  assert.equal(h.ends.length, 0)
}

function testUnknownCancelsPendingHangupAndSuggestion(): void {
  const h = harness()
  h.core.setCalendar([], h.now())
  h.core.observe(connected())
  h.advance(5_000)
  assert.equal(h.core.accept(h.prompts[0]), true)
  h.core.observe(disconnected)
  h.core.observe({ ...connected(), active: null })
  h.advance(2_000)
  assert.equal(h.stops, 0)
  const p = harness()
  p.core.setCalendar([], p.now())
  p.core.observe(connected())
  p.advance(5_000)
  p.core.observe({ ...connected(), active: null })
  assert.equal(p.core.isPromptOpen(), false)
}

function testHelperRestartAcceptsLowGenerationAndPreservesInterval(): void {
  const h = harness()
  h.core.setCalendar([], h.now())
  h.core.observe({ ...connected(), generation: 20 })
  h.advance(5_000)
  assert.equal(h.core.accept(h.prompts[0]), true)
  const original = h.core.getCurrentCall()
  h.core.observerUnavailable()
  h.core.observe({ ...connected(), generation: 1 })
  assert.equal(h.core.getCurrentCall()?.observedStartUtc, original?.observedStartUtc)
  h.core.observe({ ...disconnected, generation: 2 })
  h.advance(1_000)
  assert.equal(h.stops, 0, 'replacement helper cannot prove the original call is still active')
  assert.equal(h.ends.length, 0)
}

function testOldProcessActivationCannotAcceptNewCall(): void {
  const before = harness()
  before.core.setCalendar([], before.now())
  before.core.observe(connected())
  before.advance(5_000)
  const after = harness()
  after.core.setCalendar([], after.now())
  after.core.observe(connected())
  after.advance(5_000)
  assert.notEqual(before.prompts[0], after.prompts[0])
  assert.equal(after.core.accept(before.prompts[0]), false)
  assert.equal(after.starts.length, 0)
}

function testGenericScheduledWindowFailsClosed(): void {
  const h = harness()
  h.core.setCalendar([calendar('Quarterly review', h.now() - 1_000, h.now() + 60_000, 'not_organizer')], h.now())
  h.core.observe(connected('Meeting | Microsoft Teams'))
  h.advance(5_000)
  assert.equal(h.prompts.length, 0)
}

function testCalendarInvalidationRequiresFreshSnapshot(): void {
  const h = harness()
  h.core.setCalendar([], h.now())
  h.core.observe({ ...connected(), generation: 20 })
  h.core.invalidate()
  h.core.observe({ ...connected(), generation: 1 })
  h.advance(5_000)
  assert.equal(h.prompts.length, 0)
  h.core.setCalendar([], h.now())
  h.core.observe({ ...connected(), generation: 1 })
  h.advance(5_000)
  assert.equal(h.prompts.length, 1)
}

function testCalendarDeltaPreservesUnchangedEvents(): void {
  const h = harness()
  const event = { ...calendar('Scheduled attendee', h.now() - 1_000, h.now() + 60_000), eventId: 'event-1' }
  h.core.setCalendar([event], h.now())
  h.core.setCalendar([], h.now(), false)
  h.core.observe(connected('Scheduled attendee | Microsoft Teams'))
  h.advance(5_000)
  assert.equal(h.prompts.length, 0)
}

function testDeltaCannotEstablishAnUnknownCalendar(): void {
  const h = harness()
  h.core.setCalendar([], h.now(), false)
  h.core.observe(connected())
  h.advance(5_000)
  assert.equal(h.prompts.length, 0)
}

function testCalendarDeltaReplacesSameEvent(): void {
  const h = harness()
  const event = { ...calendar('Scheduled attendee', h.now() - 1_000, h.now() + 60_000), eventId: 'event-1' }
  h.core.setCalendar([event], h.now())
  h.core.setCalendar([{ ...event, title: 'Rescheduled different subject' }], h.now(), false)
  h.core.observe(connected('Scheduled attendee | Microsoft Teams'))
  h.advance(5_000)
  assert.equal(h.prompts.length, 0, 'renaming an overlapping booking does not prove an unscheduled call')
}

function testHeartbeatWatchdogInvalidatesWithoutStopping(): void {
  const h = harness({ observationStaleMs: 3_500 })
  h.core.setCalendar([], h.now())
  h.core.observe(connected())
  for (let i = 0; i < 7; i++) { h.advance(750); h.core.observe(connected()) }
  assert.equal(h.prompts.length, 1)
  const nonce = h.prompts[0]
  h.advance(3_500)
  assert.equal(h.core.isPromptOpen(), false)
  assert.equal(h.core.accept(nonce), false)
  assert.equal(h.stops, 0)
  const accepted = harness({ observationStaleMs: 3_500 })
  accepted.core.setCalendar([], accepted.now())
  accepted.core.observe(connected())
  for (let i = 0; i < 7; i++) { accepted.advance(750); accepted.core.observe(connected()) }
  assert.equal(accepted.core.accept(accepted.prompts[0]), true)
  const start = accepted.core.getCurrentCall()?.observedStartUtc
  accepted.advance(3_500)
  assert.equal(accepted.stops, 0)
  accepted.core.observe({ ...connected(), generation: 1 })
  assert.equal(accepted.core.getCurrentCall()?.observedStartUtc, start)
}

function testStopIsBoundToTheSameRecording(): void {
  const call = { nonce: 'current-call', title: 'Fixture', observedStartUtc: '2026-10-06T05:00:00Z' }
  const own = { trigger: 'prompt', metadata: { promptedTeamsCall: { nonce: call.nonce } } }
  assert.equal(isPromptedTeamsCallRecording(call, own), true)
  assert.equal(isPromptedTeamsCallRecording(call, null), false)
  assert.equal(isPromptedTeamsCallRecording(call, { trigger: 'manual', metadata: own.metadata }), false)
  assert.equal(isPromptedTeamsCallRecording(call, { trigger: 'prompt', metadata: { promptedTeamsCall: { nonce: 'next-call' } } }), false)
  assert.equal(isPromptedTeamsCallRecording(call, { trigger: 'calendar', metadata: {} }), false)
}

function testTitleChangeCannotEndPreviousCall(): void {
  const h = harness()
  h.core.setCalendar([], h.now())
  h.core.observe(connected('Alex | Microsoft Teams'))
  h.advance(5_000)
  assert.equal(h.core.accept(h.prompts[0]), true)
  h.core.observe(connected('Another caller | Microsoft Teams'))
  h.core.observe(disconnected)
  h.advance(1_000)
  assert.equal(h.stops, 0, 'a different call must never end the consented interval')
  assert.equal(h.ends.length, 0)
}

function testAudioLossWithCallWindowCannotEndRecording(): void {
  const h = harness()
  h.core.setCalendar([], h.now())
  h.core.observe(connected())
  h.advance(5_000)
  assert.equal(h.core.accept(h.prompts[0]), true)
  h.core.observe({ ...connected(), active: false })
  h.advance(2_000)
  assert.equal(h.stops, 0, 'lost audio while the call window remains is not hang-up')
  assert.equal(h.ends.length, 0)
  h.core.observe(disconnected)
  h.advance(1_000)
  assert.equal(h.stops, 1, 'a cleared window after audio loss is a confirmed hang-up')
  assert.equal(h.ends.length, 1)
}

function testLingeringCallWindowAtHangupStopsOnceWindowClears(): void {
  // Live finding 8 Oct 2026: Teams ends the audio session about a second
  // before it closes the call window. That must read as a normal hang-up,
  // not as uncertainty that permanently detaches automatic control.
  const h = harness()
  h.core.setCalendar([], h.now())
  h.core.observe(connected())
  h.advance(5_000)
  assert.equal(h.core.accept(h.prompts[0]), true)
  h.core.observe({ ...connected(), active: false })
  h.advance(750)
  assert.equal(h.stops, 0)
  h.core.observe({ ...connected(), active: false })
  h.advance(750)
  assert.equal(h.stops, 0, 'a lingering call window still suppresses the end')
  assert.equal(h.ends.length, 0)
  h.core.observe(disconnected)
  h.advance(999)
  assert.equal(h.stops, 0)
  h.advance(1)
  assert.equal(h.stops, 1)
  assert.equal(h.ends.length, 1)
  h.core.observe(disconnected)
  h.advance(2_000)
  assert.equal(h.stops, 1, 'a hang-up ends exactly once')
}

function testDeviceBlipWithCallWindowDoesNotEndOrDetach(): void {
  const h = harness()
  h.core.setCalendar([], h.now())
  h.core.observe(connected())
  h.advance(5_000)
  assert.equal(h.core.accept(h.prompts[0]), true)
  h.core.observe({ ...connected(), active: false })
  h.advance(2_000)
  assert.equal(h.stops, 0, 'audio loss with the window up never ends the recording')
  assert.equal(h.ends.length, 0)
  h.core.observe(connected())
  h.advance(2_000)
  assert.equal(h.stops, 0, 'the call resumed when audio returned')
  h.core.observe(disconnected)
  h.advance(1_000)
  assert.equal(h.stops, 1, 'the later real hang-up still stops automatically')
  assert.equal(h.ends.length, 1)
}

function testFalsePrejoinCannotEndRecording(): void {
  const h = harness()
  h.core.setCalendar([], h.now())
  h.core.observe(connected())
  h.advance(5_000)
  assert.equal(h.core.accept(h.prompts[0]), true)
  h.core.observe({ ...disconnected, preJoin: true })
  h.advance(2_000)
  assert.equal(h.stops, 0)
  assert.equal(h.ends.length, 0)
}

function testPreconnectionTitlesCannotPromptOrAccept(): void {
  for (const title of ['Calling Alex', 'Incoming call', 'Outgoing call', 'Ringing', 'Connecting']) {
    const h = harness()
    h.core.setCalendar([], h.now())
    h.core.observe(connected(title + ' | Microsoft Teams'))
    h.advance(6_000)
    assert.equal(h.prompts.length, 0, title + ' is not joined evidence')
    assert.equal(h.starts.length, 0)
  }
  const pending = harness()
  pending.core.setCalendar([], pending.now())
  pending.core.observe(connected())
  pending.advance(5_000)
  const nonce = pending.prompts[0]
  pending.core.observe(connected('Connecting | Microsoft Teams'))
  assert.equal(pending.core.isPromptOpen(), false)
  assert.equal(pending.core.accept(nonce), false)
}

function testJoinedDelayStartsAfterRinging(): void {
  const h = harness()
  h.core.setCalendar([], h.now())
  h.core.observe(connected('Calling Alex | Microsoft Teams'))
  h.advance(6_000)
  assert.equal(h.prompts.length, 0)
  h.core.observe(connected('Alex | Microsoft Teams'))
  h.advance(4_999)
  assert.equal(h.prompts.length, 0)
  h.advance(1)
  assert.equal(h.prompts.length, 1)
}

function testScheduledHostAndAttendeeDifferentTitlesSuppress(): void {
  for (const reason of ['eligible', 'not_organizer']) {
    const h = harness()
    h.core.setCalendar([{ ...calendar('Weekly client sync', h.now() - 1_000, h.now() + 60_000, reason), isTeamsMeeting: true }], h.now())
    h.core.observe(connected('Alex Smith | Microsoft Teams'))
    h.advance(6_000)
    assert.equal(h.prompts.length, 0, reason + ' must not depend on the window subject')
  }
}

function testCalendarRescheduleOutsideOverlapAllowsPrompt(): void {
  const h = harness()
  const event = { ...calendar('Scheduled attendee', h.now() - 1_000, h.now() + 60_000), eventId: 'rescheduled', isTeamsMeeting: true }
  h.core.setCalendar([event], h.now())
  h.core.setCalendar([{ ...event, startUtc: new Date(h.now() + 3_600_000).toISOString(), endUtc: new Date(h.now() + 3_660_000).toISOString() }], h.now(), false)
  h.core.observe(connected())
  h.advance(5_000)
  assert.equal(h.prompts.length, 1)
}

function testCalendarRefreshClosesVisiblePrompt(): void {
  for (const fullSnapshot of [true, false]) {
    const h = harness()
    h.core.setCalendar([], h.now())
    h.core.observe(connected())
    h.advance(5_000)
    assert.equal(h.core.isPromptOpen(), true)
    const nonce = h.prompts[0]
    h.core.setCalendar([{ ...calendar('New overlapping booking', h.now() - 1_000, h.now() + 60_000), eventId: 'late-calendar', isTeamsMeeting: true }], h.now(), fullSnapshot)
    assert.equal(h.core.isPromptOpen(), false, 'both snapshot and delta refresh must close prohibited suggestions')
    assert.equal(h.core.accept(nonce), false)
    assert.equal(h.starts.length, 0)
  }
}

function testUncertainPauseAndOneMinuteTimeout(): void {
  const h = harness()
  h.core.setCalendar([], h.now())
  h.core.observe(connected())
  h.advance(5_000)
  assert.equal(h.core.accept(h.prompts[0]), true)
  h.core.observe({ ...connected(), active: null })
  assert.equal(h.pauses.length, 1)
  assert.equal(h.uncertainPrompts.length, 0, 'ask only after the renderer confirms capture paused')
  h.pauseAck()
  assert.equal(h.uncertainPrompts.length, 1)
  h.advance(59_999)
  assert.equal(h.stops, 0)
  h.advance(1)
  assert.equal(h.stops, 1, 'no answer finalizes this recording after one minute')
  assert.equal(h.ends.length, 0, 'uncertainty must not invent a confirmed Teams hang-up')
  assert.equal(h.core.respondToUncertainty(h.uncertainPrompts[0].decisionNonce, 'continue'), false)
}

function testContinueNeedsExplicitActionAndIsBounded(): void {
  const h = harness()
  h.core.setCalendar([], h.now())
  h.core.observe(connected())
  h.advance(5_000)
  assert.equal(h.core.accept(h.prompts[0]), true)
  h.core.observerUnavailable()
  h.pauseAck()
  const first = h.uncertainPrompts[0].decisionNonce
  h.core.observe({ ...connected(), generation: 1 })
  assert.equal(h.resumes.length, 0, 'recovered evidence must never resume without consent')
  assert.equal(h.core.respondToUncertainty(first, 'continue'), true)
  h.paused = false
  assert.equal(h.resumes.length, 1)
  h.advance(60_000)
  assert.equal(h.pauses.length, 2, 'one Continue does not authorize indefinite uncertain recording')
  h.pauseAck()
  assert.equal(h.core.respondToUncertainty(first, 'stop'), false, 'old toast cannot control the next episode')
  assert.equal(h.core.respondToUncertainty(h.uncertainPrompts[1].decisionNonce, 'stop'), true)
  assert.equal(h.stops, 1)
}

function testPauseAckFailureAndReplacementRecordingCannotBeStopped(): void {
  const h = harness()
  h.core.setCalendar([], h.now())
  h.core.observe(connected())
  h.advance(5_000)
  assert.equal(h.core.accept(h.prompts[0]), true)
  h.core.observe({ ...connected(), active: null })
  h.advance(4_999)
  assert.equal(h.stops, 0)
  h.advance(1)
  assert.equal(h.stops, 1, 'missing pause acknowledgement must fail safe, not record for hours')
  const replacement = harness()
  replacement.core.setCalendar([], replacement.now())
  replacement.core.observe(connected())
  replacement.advance(5_000)
  assert.equal(replacement.core.accept(replacement.prompts[0]), true)
  replacement.recordingActive = false
  replacement.core.observe({ ...connected(), active: null })
  replacement.advance(120_000)
  assert.equal(replacement.pauses.length, 0)
  assert.equal(replacement.stops, 0, 'the original call cannot pause or stop a replacement recording')
}

function testUncertaintyToastIsEpisodeBound(): void {
  const continueUri = teamsCallDecisionToastUri('continue', 'call-1', 'episode-1')
  const stopUri = teamsCallDecisionToastUri('stop', 'call-1', 'episode-1')
  assert.deepEqual(parseToastArgv([continueUri]), {
    action: 'teams-call-continue', meetingId: null, callNonce: 'call-1', decisionNonce: 'episode-1'
  })
  assert.deepEqual(parseToastArgv([stopUri]), {
    action: 'teams-call-stop', meetingId: null, callNonce: 'call-1', decisionNonce: 'episode-1'
  })
  assert.equal(parseToastArgv([teamsCallDecisionToastUri('stop', '', '')]), null)
  const xml = buildTeamsCallUncertaintyToastXml('call-1', 'episode-1')
  assert.match(xml, /Is the call still live\?/)
  assert.match(xml, /Continue recording/)
  assert.match(xml, /Stop and process/)
  assert.ok(xml.includes(continueUri.replace(/&/g, '&amp;')))
  assert.ok(xml.includes(stopUri.replace(/&/g, '&amp;')))
}

function testPromptedStopRequestCannotHitReplacement(): void {
  assert.equal(shouldHandlePromptedStop('teams-prompt-n1', 'n1', true), true)
  assert.equal(shouldHandlePromptedStop('teams-prompt-n1', 'n2', true), false)
  assert.equal(shouldHandlePromptedStop('teams-prompt-n1', 'n1', false), false)
  assert.equal(shouldHandlePromptedStop('teams-prompt-n1', null, true), false)
  assert.equal(shouldHandlePromptedStop('scheduled-meeting', null, true), true)
}

function acceptedCallForRecovery() {
  const h = harness()
  h.core.setCalendar([], h.now())
  h.core.observe(connected())
  h.advance(5_000)
  assert.equal(h.core.accept(h.prompts[0]), true)
  return h
}

function testScreenSharingSurfacesPreserveOriginalCall(): void {
  const h = acceptedCallForRecovery()
  for (const windowTitles of [
    ['Meeting compact view | Alex External | Microsoft Teams', ...connected().windowTitles],
    ['Sharing control bar | Microsoft Teams', ...connected().windowTitles],
    ['Meeting compact view | Alex External | Microsoft Teams', 'Sharing control bar | Microsoft Teams', ...connected().windowTitles]
  ]) h.core.observe({ ...connected(), windowTitles })
  assert.equal(h.pauses.length, 0, 'screen sharing surfaces are not separate calls')
  h.core.observe(disconnected)
  h.advance(1_000)
  assert.equal(h.stops, 1, 'screen sharing must not disable real hang-up')
}

function testContinueRecoversOriginalCallAndHangup(): void {
  const h = acceptedCallForRecovery()
  h.core.observe({ ...connected(), active: null })
  h.pauseAck()
  assert.equal(h.core.respondToUncertainty(h.uncertainPrompts[0].decisionNonce, 'continue'), true)
  h.paused = false
  h.core.onRecordingResumed()
  for (let n = 0; n < 61; n++) {
    h.core.observe(connected())
    h.advance(1_000)
  }
  assert.equal(h.pauses.length, 1, 'stable recovery cancels the repeated one-minute pause')
  h.core.observe(disconnected)
  h.advance(1_000)
  assert.equal(h.stops, 1)
  assert.equal(h.ends.length, 1, 'recovered original call regains hang-up tracking')
}

function testRecoveryRequiresContinueAndStableSameCall(): void {
  const noConsent = acceptedCallForRecovery()
  noConsent.core.observe({ ...connected(), active: null })
  noConsent.pauseAck()
  for (let n = 0; n < 5; n++) { noConsent.core.observe(connected()); noConsent.advance(1_000) }
  assert.equal(noConsent.resumes.length, 0)
  noConsent.core.observe(disconnected)
  noConsent.advance(1_000)
  assert.equal(noConsent.ends.length, 0)
  const different = acceptedCallForRecovery()
  different.core.observe({ ...connected(), active: null })
  different.pauseAck()
  different.core.respondToUncertainty(different.uncertainPrompts[0].decisionNonce, 'continue')
  different.paused = false
  for (let n = 0; n < 60; n++) { different.core.observe(connected('Different Person | Microsoft Teams')); different.advance(1_000) }
  assert.equal(different.pauses.length, 2, 'different call cannot restore the original call identity')
}

function testRecoveryInterruptedAndReplacementRemainDetached(): void {
  for (const interruption of ['unknown', 'different', 'observer', 'paused', 'not-ready', 'replacement']) {
    const h = acceptedCallForRecovery()
    h.core.observe({ ...connected(), active: null })
    h.pauseAck()
    h.core.respondToUncertainty(h.uncertainPrompts[0].decisionNonce, 'continue')
    h.paused = false
    h.core.observe(connected())
    h.advance(1_000)
    if (interruption === 'observer') h.core.observerUnavailable()
    else if (interruption === 'paused') { h.paused = true; h.core.observe(connected()); h.paused = false }
    else if (interruption === 'not-ready') { h.ready = false; h.core.observe(connected()); h.ready = true }
    else if (interruption === 'replacement') { h.recordingActive = false; h.core.observe(connected()) }
    else h.core.observe(interruption === 'unknown' ? { ...connected(), active: null } : connected('Different | Microsoft Teams'))
    h.advance(1_000)
    h.core.observe(connected())
    h.core.observe(disconnected)
    h.advance(1_000)
    assert.equal(h.ends.length, 0, 'interrupted stability cannot restore hang-up: ' + interruption)
    assert.equal(h.stops, 0)
  }
}

function testCancelledDeclinedBookingsDoNotSuppress() {
  for (const reason of ['cancelled', 'declined']) {
    const h = harness()
    const booking = { ...calendar('Cancelled fixture', h.now() - 60_000, h.now() + 60_000, reason), status: 'excluded' as const, isTeamsMeeting: true }
    h.core.setCalendar([booking])
    h.core.observe(connected())
    h.advance(5_000)
    assert.equal(h.prompts.length, 1, reason + ' is not a live scheduled call')
    h.core.dispose()
  }
  for (const reason of ['not_organizer', 'invalid_time_range', 'future_policy_reason']) {
    const h = harness()
    h.core.setCalendar([{ ...calendar('Active fixture', h.now() - 60_000, h.now() + 60_000, reason), status: 'excluded' as const, isTeamsMeeting: true }])
    h.core.observe(connected())
    h.advance(5_000)
    assert.equal(h.prompts.length, 0, reason + ' must retain conservative scheduled suppression')
    h.core.dispose()
  }
}

const checks = [
  testCancelledDeclinedBookingsDoNotSuppress,
  testRecoveryInterruptedAndReplacementRemainDetached,
  testScreenSharingSurfacesPreserveOriginalCall,
  testContinueRecoversOriginalCallAndHangup,
  testRecoveryRequiresContinueAndStableSameCall,
  testPromptedStopRequestCannotHitReplacement,
  testUncertaintyToastIsEpisodeBound,
  testUncertainPauseAndOneMinuteTimeout,
  testContinueNeedsExplicitActionAndIsBounded,
  testPauseAckFailureAndReplacementRecordingCannotBeStopped,
  testCalendarRefreshClosesVisiblePrompt,
  testAudioLossWithCallWindowCannotEndRecording,
  testLingeringCallWindowAtHangupStopsOnceWindowClears,
  testDeviceBlipWithCallWindowDoesNotEndOrDetach,
  testFalsePrejoinCannotEndRecording,
  testPreconnectionTitlesCannotPromptOrAccept,
  testJoinedDelayStartsAfterRinging,
  testScheduledHostAndAttendeeDifferentTitlesSuppress,
  testCalendarRescheduleOutsideOverlapAllowsPrompt,
  testTitleChangeCannotEndPreviousCall,
  testConnectionDelayAndAcceptance,
  testPrejoinDoesNotPromptUntilJoined,
  testRingingMuteAndDeclineDoNotPrompt,
  testActiveManualPausedAndPendingAutoSuppress,
  testScheduledHostAndAttendeeSuppress,
  testUnknownStaleAndAmbiguousCalendarFailClosed,
  testStaleClickAndObserverFailureCannotStop,
  testObserverGenerationResetCannotStopOnUnknown,
  testHangupStopsAndEndsExactlyOnce,
  testOnePromptPerConnectionAndReadiness,
  testFeatureDefaultsOff,
  testFlagLayersAndTitleExclusions,
  testToastNonceRoundTrip,
  testFailureCancelsPendingHangup,
  testUnknownCancelsPendingHangupAndSuggestion,
  testHelperRestartAcceptsLowGenerationAndPreservesInterval,
  testOldProcessActivationCannotAcceptNewCall,
  testGenericScheduledWindowFailsClosed,
  testCalendarInvalidationRequiresFreshSnapshot,
  testCalendarDeltaPreservesUnchangedEvents,
  testDeltaCannotEstablishAnUnknownCalendar,
  testCalendarDeltaReplacesSameEvent,
  testHeartbeatWatchdogInvalidatesWithoutStopping,
  testStopIsBoundToTheSameRecording
]
let failed = 0
for (const check of checks) {
  try { check(); console.log('PASS ' + check.name) }
  catch (error) { failed++; console.error('FAIL ' + check.name + ': ' + String(error)) }
}
assert.equal(failed, 0, 'Teams-call regressions failed')
console.log('verify-teams-call-prompt: ' + checks.length + ' checks passed')
