import type { DeliveryStatus } from '@renderer/data/mock'
import { INVITEES_NOT_SENT, type InviteeDeliveryStatus } from './inviteePrompt'

const UNCONFIRMED_WARNING =
  'The transcript email attempt was interrupted — it may already have been delivered. ' +
  'Check your inbox before retrying email.'

/**
 * Post-capture notice text when the transcript email did not complete (IN-478).
 *
 * A send that ends `unconfirmed` (transport error or backend restart mid-send)
 * may still have been delivered by Graph. Telling the user "email was not
 * sent" invited a blind resend and a duplicate email — surface the backend's
 * check-your-inbox explanation instead. Definitive failures keep the caller's
 * actionable fallback (usually "sign in to Outlook, then retry").
 */
export function emailFailureMessage(
  deliveryStatus: DeliveryStatus | undefined,
  deliveryErrorMessage: string | null | undefined,
  fallback: string
): string {
  if (deliveryStatus !== 'unconfirmed') return fallback
  return deliveryErrorMessage?.trim() ? deliveryErrorMessage : UNCONFIRMED_WARNING
}

export interface DeliveryOutcomeInput {
  /** 'first' = the post-capture watcher's wording; 'retry' = Retry email's. */
  attempt: 'first' | 'retry'
  /** Everyone who has the email, or null when the email call failed. */
  emailRecipients: string[] | null
  sharePointSaved: boolean
  grantWarning?: string | null
  /** Re-fetched after an email failure (IN-478); undefined otherwise. */
  deliveryStatus?: DeliveryStatus
  deliveryErrorMessage?: string | null
  deliveryErrorCode?: string | null
  /** Who THIS pass emailed (EmailResultDto.sent_now). A non-empty strict
   *  subset of emailRecipients means this was a later, invitee-only send. */
  sentNow?: string[]
  /** "Send to N invitees" is being offered on this card (IN-488). */
  sendLaterOffered?: boolean
  // Re-fetched after an email failure, like the delivery_* trio.
  inviteeDeliveryStatus?: InviteeDeliveryStatus
  inviteeErrorMessage?: string | null
  inviteeErrorCode?: string | null
}

export interface DeliveryOutcomeNotice {
  state: 'ready' | 'email_failed'
  message: string
  // Three-way, as on PostCaptureNotice: a FailureCategory string; null = a
  // genuine failure with no classified code; undefined = not a failure at all
  // (the email-unconfirmed case, IN-478), so no "Failed:" label is rendered.
  errorCode?: string | null
}

const OUTCOME_WORDING = {
  first: {
    sharePointFailed:
      'Transcript email was sent, but SharePoint save failed. Sign in again, then retry delivery.',
    emailFailed:
      'Transcript saved to SharePoint, but email was not sent. Sign in to Outlook, then retry email.',
    bothFailed:
      'Notes are ready, but SharePoint save and transcript email failed. Sign in to Microsoft, then retry delivery.'
  },
  retry: {
    sharePointFailed: 'Transcript email was sent, but SharePoint save still failed.',
    emailFailed: 'Transcript saved to SharePoint, but email still failed.',
    bothFailed: 'SharePoint save and email still failed. The notes are ready and the recording is safe.'
  }
} as const

const INVITEE_UNCONFIRMED_WARNING =
  'The invitee email attempt was interrupted — it may already have been delivered. ' +
  'Check with an invitee before retrying.'
const ORGANISER_COPY_SAFE = 'Nothing was sent to invitees; your own copy was already delivered.'

/**
 * The card for one delivery pass (POST /sharepoint, then POST /email). The
 * single home for IN-478's rule: an `unconfirmed` email is not a failure, so
 * it shows the backend's check-your-inbox text and no "Failed:" label.
 */
export function deliveryOutcomeNotice(input: DeliveryOutcomeInput): DeliveryOutcomeNotice {
  const wording = OUTCOME_WORDING[input.attempt]
  if (input.emailRecipients && input.sharePointSaved) {
    const sentNow = input.sentNow ?? []
    const laterSend = sentNow.length > 0 && sentNow.length < input.emailRecipients.length
    return {
      state: 'ready',
      message:
        (laterSend
          ? `Sent to ${sentNow.join(', ')}.`
          : `Transcript saved to SharePoint and emailed to ${input.emailRecipients.join(', ')}.`) +
        // Without this line the card reads as if delivery is finished and the
        // Send button looks like a resend (mock-ups, approved 15 Sep).
        (input.sendLaterOffered ? ` ${INVITEES_NOT_SENT}` : '') +
        // Option A (IN-398): a saved delivery can still carry a view-grant
        // warning for ungrantable attendees — say so instead of hiding it.
        (input.grantWarning ? ` ${input.grantWarning}` : '')
    }
  }
  if (input.emailRecipients) {
    // The save endpoint raises rather than returning a DTO, so no fresh
    // sharepoint_error_code is in scope: fall back to the chips' default label.
    return { state: 'email_failed', message: wording.sharePointFailed, errorCode: null }
  }
  if (input.deliveryStatus === 'emailed') {
    // The email call failed although the organiser already has theirs: this
    // was the later, invitee-only send (IN-488). Same unconfirmed rule.
    const unconfirmed = input.inviteeDeliveryStatus === 'unconfirmed'
    const cause = input.inviteeErrorMessage?.trim().replace(/\.$/, '')
    return {
      state: 'email_failed',
      message: unconfirmed
        ? input.inviteeErrorMessage?.trim() || INVITEE_UNCONFIRMED_WARNING
        : `${cause || 'The transcript could not be sent to invitees'}. ${ORGANISER_COPY_SAFE}`,
      errorCode: unconfirmed ? undefined : (input.inviteeErrorCode ?? null)
    }
  }
  return {
    state: 'email_failed',
    message: emailFailureMessage(
      input.deliveryStatus,
      input.deliveryErrorMessage,
      input.sharePointSaved ? wording.emailFailed : wording.bothFailed
    ),
    errorCode:
      input.deliveryStatus === 'unconfirmed' ? undefined : (input.deliveryErrorCode ?? null)
  }
}
