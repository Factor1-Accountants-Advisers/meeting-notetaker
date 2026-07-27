import type { DeliveryStatus } from '@renderer/data/mock'

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
