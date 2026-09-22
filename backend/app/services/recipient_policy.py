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
from app.schemas import InviteeCandidate, InviteeDecision, Meeting

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

# Delivery mode (IN-488, spec D10). `ask` is the code default. `organizer` is
# exactly the v2.0.29+ behaviour and therefore the kill switch. `attendees` is
# the unchanged escape hatch: everyone gets it, nobody is asked.
DELIVERY_MODE_ASK = "ask"
DELIVERY_MODE_ORGANIZER = "organizer"
DELIVERY_MODE_ATTENDEES = "attendees"
_DELIVERY_MODES = frozenset(
    {DELIVERY_MODE_ASK, DELIVERY_MODE_ORGANIZER, DELIVERY_MODE_ATTENDEES}
)


def delivery_mode() -> str:
    """The configured delivery mode, failing closed to ``organizer``.

    Anything unrecognised, including a blank value, reads as ``organizer``:
    a typo in a repo variable or a %PROGRAMDATA% override must degrade to
    today's organiser-only delivery, never to prompting or fan-out.
    """
    value = get_settings().delivery_recipients.strip().lower()
    return value if value in _DELIVERY_MODES else DELIVERY_MODE_ORGANIZER


def prompt_enabled() -> bool:
    """Whether the owner is asked about invitees at all (``ask`` mode only)."""
    return delivery_mode() == DELIVERY_MODE_ASK


def invitees_approved(meeting: Meeting) -> bool:
    """Whether this meeting's invitees may receive email and SharePoint grants.

    ``attendees``: always. ``ask``: only with a stored approval. ``organizer``:
    never, even with a stored approval (Joseph, 21 Sep 2026). The example that
    settled it: Monday "Just me" leaves a "Send to 5 invitees" button on Home;
    Tuesday the switch is flipped after an incident; Wednesday a click on that
    leftover button must send nothing. The stored decision is kept, so
    flipping back to ``ask`` restores it.
    """
    mode = delivery_mode()
    if mode == DELIVERY_MODE_ATTENDEES:
        return True
    if mode == DELIVERY_MODE_ASK:
        return meeting.invitee_decision is InviteeDecision.approved
    return False


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


def _clean_email(value: str | None) -> str | None:
    cleaned = (value or "").strip().lower()
    return cleaned if "@" in cleaned else None


def invitee_candidates(
    meeting: Meeting,
    recorder_email: str | None = None,
    *,
    channel: str = "invitees",
) -> list[InviteeCandidate]:
    """The other people this meeting's transcript could be emailed to (IN-488).

    Graph attendees for a calendar meeting, the attendee-picker selections for
    an ad-hoc one (the calendar branch wins when both exist, matching
    ``_sharepoint_recipients``). Never the organiser and never the recorder,
    so "5 invitees" always means five OTHER people. Everything passes the
    domain allowlist BEFORE it is counted, so an external address never
    appears in the toast or the card. First-seen order, deduped
    case-insensitively; the first name seen for an address wins.
    """
    if meeting.graph_metadata:
        source = [(a.name, a.email) for a in meeting.graph_metadata.attendees]
        organizer = _clean_email(meeting.graph_metadata.organizer_email)
    else:
        source = [(a.name, a.email) for a in meeting.manual_attendees]
        organizer = None
    excluded = {email for email in (organizer, _clean_email(recorder_email)) if email}

    names: dict[str, str | None] = {}
    for name, raw in source:
        email = _clean_email(raw)
        if email is None or email in excluded or email in names:
            continue
        names[email] = (name or "").strip() or None

    kept = filter_deliverable(list(names), channel=channel, meeting_id=meeting.id)
    return [InviteeCandidate(name=names[email], email=email) for email in kept]
