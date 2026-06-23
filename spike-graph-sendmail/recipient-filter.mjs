/** @typedef {{ name?: string; email: string }} Recipient */

export const ALLOWED_EMAIL_DOMAIN = 'factor1.com.au';

/**
 * @param {string} email
 */
export function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

/**
 * @param {string} email
 */
export function isAllowedInternalDomain(email) {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf('@');
  if (at === -1) return false;
  return normalized.slice(at + 1) === ALLOWED_EMAIL_DOMAIN;
}

/**
 * Calendar invitees may include external clients — only Factor1 staff receive notes.
 *
 * @param {Recipient[]} recipients
 * @returns {{ allowed: Recipient[]; rejected: Recipient[] }}
 */
export function filterInternalRecipients(recipients) {
  /** @type {Recipient[]} */
  const allowed = [];
  /** @type {Recipient[]} */
  const rejected = [];

  for (const recipient of recipients) {
    if (!recipient.email?.trim()) {
      rejected.push({ ...recipient, email: recipient.email ?? '' });
      continue;
    }
    if (isAllowedInternalDomain(recipient.email)) {
      allowed.push(recipient);
    } else {
      rejected.push(recipient);
    }
  }

  return { allowed, rejected };
}

/**
 * @param {string} raw
 * @returns {Recipient[]}
 */
export function parseRecipientList(raw) {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((email) => ({ email, name: email.split('@')[0] ?? email }));
}
