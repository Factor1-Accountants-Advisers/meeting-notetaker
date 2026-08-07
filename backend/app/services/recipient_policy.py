"""Who a transcript is allowed to reach (7 Aug 2026 field incident).

Gen had organised Benjamin's interviews for the day but was sitting in a
different meeting when the first one began. Her notetaker auto-recorded on the
interview's calendar times, captured the *other* conversation, and delivered
the summary plus the full transcript to the interview's invitee list — which
included an external candidate on a gmail.com address. SharePoint's grant was
refused by tenant sharing policy; Graph sendMail had no such backstop and the
email went out.

Root cause: ``_email_recipients``/``_sharepoint_recipients`` accepted any Graph
attendee whose address merely contained an "@".

The gate is a **domain allowlist**, chosen by David A over the voiceprint
registry (7 Aug, 11:37 AEST): "even if you dont have a voiceprint registered or
the pull from azure fails, the email can still go out to all invitees (internal
only)". A registry check fails closed in the two situations where delivery must
keep working — an invitee who has not enrolled yet, and a central-store outage.
An allowlist is a pure offline string comparison with neither failure mode.

Deliberately NOT ``meeting_export.INTERNAL_EMAIL_DOMAIN``. That constant answers
a different question ("internal or client meeting?" for the summary prompt) and
treats sister-company staff as external on purpose; widening it here would
silently reclassify every group meeting's prompt.
"""

from __future__ import annotations

import logging
from typing import Iterable

from app.config import get_settings

logger = logging.getLogger(__name__)

# The group's own mail domains (list supplied by Joseph, 7 Aug 2026, after
# David asked for "an allow list of domains" covering all companies). Override
# per-environment with MN_DELIVERY_DOMAIN_ALLOWLIST rather than editing this.
DEFAULT_DELIVERY_DOMAINS: tuple[str, ...] = (
    "factor1.com.au",
    "eager.com.au",
    "taxopia.com.au",
    "jmrpartners.com.au",
    "astutebusiness.com.au",
    "kppartners.com.au",
)


def allowed_delivery_domains() -> frozenset[str]:
    """Domains permitted to receive meeting artifacts.

    An empty/blank setting means "use the built-in group list" — it can never
    mean "allow nothing", so a misconfigured env var degrades to the safe
    default instead of silently breaking all delivery.
    """
    configured = {
        entry.strip().lower()
        for entry in get_settings().delivery_domain_allowlist.split(",")
        if entry.strip()
    }
    return frozenset(configured or DEFAULT_DELIVERY_DOMAINS)


def _domain_of(email: str | None) -> str | None:
    """The domain part of a well-formed address, else None.

    Stricter than ``"@" in value``: both sides must be non-empty and the domain
    must not itself contain an "@", so "a@b@factor1.com.au" is rejected rather
    than read as the allowed domain.
    """
    if not email:
        return None
    local, separator, domain = email.strip().lower().partition("@")
    if not separator or not local or not domain or "@" in domain:
        return None
    return domain


def is_deliverable(email: str | None) -> bool:
    """True when this address may receive a transcript or summary.

    Exact domain match only. A suffix test would pass
    "mail@factor1.com.au.attacker.example", and allowing subdomains would open
    the allowlist to any host an outsider can name — no group mailbox needs
    either.
    """
    domain = _domain_of(email)
    return domain is not None and domain in allowed_delivery_domains()


def filter_deliverable(
    candidates: Iterable[str],
    *,
    channel: str,
    meeting_id: object | None = None,
) -> list[str]:
    """Drop every address outside the allowlist, preserving order.

    Each drop gets one greppable WARNING naming the address — this is the audit
    trail for "who did we nearly send a transcript to", and it rides into the
    IN-473 Report Problem bundle. Silent filtering would have made the 7 Aug
    incident invisible until someone read their inbox.
    """
    kept: list[str] = []
    blocked: list[str] = []
    for candidate in candidates:
        (kept if is_deliverable(candidate) else blocked).append(candidate)
    for address in blocked:
        logger.warning(
            "recipient_blocked channel=%s meeting=%s address=%s reason=domain_not_allowed",
            channel,
            meeting_id if meeting_id is not None else "-",
            address,
        )
    return kept
