/**
 * IN-488 "ask before emailing invitees": the renderer's pure rules.
 *
 * Zero imports on purpose. The verify script bundles this file under plain
 * Node, and api.ts imports its types, so it must not pull in React, the API
 * client or the design system.
 */

export interface InviteeCandidate {
  name: string | null
  email: string
}

export type InviteeDecision = 'pending' | 'approved' | 'declined'
export type InviteeDeliveryStatus = 'not_started' | 'sending' | 'sent' | 'unconfirmed' | 'failed'
export type InviteeDecisionSource = 'toast' | 'app' | 'timeout'

/** GET /meetings/{id}/invitees. */
export interface InviteeState {
  candidates: InviteeCandidate[]
  /** The EFFECTIVE decision: `approved` under the `attendees` delivery mode. */
  decision: InviteeDecision
  invitee_delivery_status: InviteeDeliveryStatus
  invitee_recipients: string[]
  /** True only in `ask` mode. False = never prompt and never offer send-later. */
  prompt_enabled: boolean
}

const DECISIONS: readonly InviteeDecision[] = ['pending', 'approved', 'declined']
const DELIVERY_STATUSES: readonly InviteeDeliveryStatus[] = [
  'not_started',
  'sending',
  'sent',
  'unconfirmed',
  'failed'
]

/**
 * Null means "cannot ask: deliver now". That covers an older backend with no
 * /invitees route (404), an unreachable backend, a non-owner (403) and a body
 * this build does not recognise. Delivering now is safe on every backend: with
 * no stored approval the backend sends to the organiser only, never to
 * invitees.
 */
export function interpretInviteesResponse(res: {
  ok: boolean
  status: number
  body: unknown
}): InviteeState | null {
  if (!res.ok || !res.body || typeof res.body !== 'object') return null
  const body = res.body as {
    candidates?: unknown
    decision?: unknown
    invitee_delivery_status?: unknown
    invitee_recipients?: unknown
    prompt_enabled?: unknown
  }
  if (!Array.isArray(body.candidates) || typeof body.prompt_enabled !== 'boolean') return null
  if (!DECISIONS.includes(body.decision as InviteeDecision)) return null
  const candidates: InviteeCandidate[] = []
  for (const entry of body.candidates) {
    const candidate = entry as { name?: unknown; email?: unknown } | null
    if (!candidate || typeof candidate.email !== 'string' || !candidate.email) continue
    candidates.push({
      name: typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name : null,
      email: candidate.email
    })
  }
  return {
    candidates,
    decision: body.decision as InviteeDecision,
    invitee_delivery_status: DELIVERY_STATUSES.includes(
      body.invitee_delivery_status as InviteeDeliveryStatus
    )
      ? (body.invitee_delivery_status as InviteeDeliveryStatus)
      : 'not_started',
    invitee_recipients: Array.isArray(body.invitee_recipients)
      ? body.invitee_recipients.filter((value): value is string => typeof value === 'string')
      : [],
    prompt_enabled: body.prompt_enabled
  }
}

// ---- copy (mock-ups: docs/superpowers/specs/in488-invitee-prompt-mockups.html)

export const INVITEES_NOT_SENT = "Invitees haven't received it."

export function inviteeDisplayName(candidate: InviteeCandidate): string {
  return candidate.name?.trim() || candidate.email
}

export function inviteeCountLabel(count: number): string {
  return count === 1 ? '1 invitee' : `${count} invitees`
}

export function inviteeQuestion(candidates: readonly InviteeCandidate[]): string {
  return candidates.length === 1
    ? `Notes are ready. Email the transcript to ${inviteeDisplayName(candidates[0])}?`
    : `Notes are ready. Email the transcript to ${candidates.length} invitees?`
}

/** The card's full name list (the toast only fits three). Null for a single
 *  invitee, who is already named in the question. */
export function inviteeNamesLine(candidates: readonly InviteeCandidate[]): string | null {
  return candidates.length > 1 ? candidates.map(inviteeDisplayName).join(', ') : null
}

export function sendLaterLabel(count: number): string {
  return `Send to ${inviteeCountLabel(count)}`
}

export function emailingMessage(approved: boolean, count: number): string {
  return approved
    ? `Saving to SharePoint and emailing to you and ${inviteeCountLabel(count)}…`
    : 'Saving to SharePoint and emailing to you…'
}

export function sendingLaterMessage(count: number): string {
  return `Sending the transcript to ${inviteeCountLabel(count)}…`
}

// ---- rules -------------------------------------------------------------------

/** Ask only in `ask` mode, only once, and only when there is someone to ask about. */
export function shouldPrompt(state: InviteeState | null): boolean {
  return Boolean(
    state && state.prompt_enabled && state.decision === 'pending' && state.candidates.length > 0
  )
}

/**
 * Offer "Send to N invitees" on a ready card. `pending` counts as well as
 * `declined`: if the answer could not be recorded, the owner can still send.
 * False under the kill switch (prompt_enabled=false): a leftover button must
 * send nothing (Joseph, 21 Sep 2026).
 */
export function canSendLater(state: InviteeState | null): boolean {
  return Boolean(
    state &&
      state.prompt_enabled &&
      state.decision !== 'approved' &&
      state.invitee_delivery_status !== 'sent' &&
      state.candidates.length > 0
  )
}

// ---- restart resurfacing -----------------------------------------------------

export const RESURFACE_WINDOW_MS = 7 * 24 * 60 * 60_000

/** The MeetingDto fields the restart filter reads. The invitee fields are
 *  optional because a backend from before IN-488 does not send them. */
export interface ResurfaceMeeting {
  id: string
  created_at: string
  pipeline_status: string
  delivery_status: string
  invitee_decision?: InviteeDecision
  invitee_delivery_status?: InviteeDeliveryStatus
}

/**
 * Which card, if any, a meeting gets on launch.
 *
 * `pending`: the app closed during the hold, so nothing was delivered. STRICT
 * on purpose: every meeting recorded before IN-488 loads as `pending`, and
 * those are already `emailed`. Treating pending + emailed as "send later"
 * would put a card on Home for every meeting of the past week on the first
 * launch after the update.
 *
 * `deliver`: the owner answered, the decision persisted and the app died
 * before the delivery pass — nothing else ever brings that meeting back. It
 * runs under every mode (the stored decision and the mode decide who is
 * emailed), so it needs no candidates and no prompt_enabled check.
 *
 * `send_later`: the organiser has their copy and the invitees do not, either
 * because the owner said "Just me" / did not answer, or because they said yes
 * and the invitee send never completed. It requires `emailed` because the card
 * reads "Emailed to you on …".
 *
 * A pending question can never be dismissed ("Just me" is its way out); the
 * other two can — a delivery that can never succeed (e.g. a 409 "no
 * transcript") needs an exit, and blob delivery to central storage is
 * independent of this pass, so nothing is lost.
 */
export function resurfaceKind(
  meeting: ResurfaceMeeting,
  nowMs: number,
  dismissed: ReadonlySet<string>
): 'pending' | 'send_later' | 'deliver' | null {
  if (!meeting.invitee_decision || !meeting.invitee_delivery_status) return null
  const createdMs = Date.parse(meeting.created_at)
  if (!Number.isFinite(createdMs) || nowMs - createdMs > RESURFACE_WINDOW_MS) return null
  if (meeting.pipeline_status !== 'ready') return null
  if (meeting.delivery_status === 'not_started') {
    if (meeting.invitee_decision === 'pending') return 'pending'
    return dismissed.has(meeting.id) ? null : 'deliver'
  }
  if (meeting.invitee_decision === 'pending') return null
  if (meeting.delivery_status !== 'emailed') return null
  if (meeting.invitee_delivery_status === 'sent' || meeting.invitee_delivery_status === 'sending') {
    return null
  }
  return dismissed.has(meeting.id) ? null : 'send_later'
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Tue 15 Sep, 14:32" in local time. Hand-rolled because Intl's en-AU output
 *  ("Sept", comma placement) shifts between ICU versions. */
export function formatEmailedAt(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}, ${hh}:${mm}`
}

const INVITEES_MAY_HAVE_BEEN_SENT =
  'The invitee email may already have been delivered; check with an invitee before resending.'

/** By restart time the delivery detail is history; the date is what helps the
 *  owner recognise the meeting (mock-up 5, approved 15 Sep). An `unconfirmed`
 *  invitee send may have gone through (IN-478's rule), so the card must not
 *  promise the invitees have nothing. */
export function resurfacedSendLaterMessage(
  emailedAtIso: string | null | undefined,
  inviteeDeliveryStatus?: InviteeDeliveryStatus
): string {
  const at = emailedAtIso ? new Date(emailedAtIso) : null
  const tail =
    inviteeDeliveryStatus === 'unconfirmed' ? INVITEES_MAY_HAVE_BEEN_SENT : INVITEES_NOT_SENT
  return at && Number.isFinite(at.getTime())
    ? `Emailed to you on ${formatEmailedAt(at)}. ${tail}`
    : `Emailed to you. ${tail}`
}

// ---- dismissed send-later cards (a UI preference, so localStorage) -----------

export const DISMISSED_INVITEE_CARDS_KEY = 'mn.inviteeCards.dismissed'
const DISMISSED_CAP = 200

export function parseDismissed(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]')
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export function withDismissed(list: readonly string[], meetingId: string): string[] {
  return [...list.filter((id) => id !== meetingId), meetingId].slice(-DISMISSED_CAP)
}
