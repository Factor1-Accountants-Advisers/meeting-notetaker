"""Outbound email (decision #9: Microsoft Graph after finalisation).

Stubbed until Graph credentials exist; the router only talks to the protocol.
"""

import logging
from typing import Protocol

from app.config import get_settings

logger = logging.getLogger(__name__)


class EmailProvider(Protocol):
    async def send_meeting_notes(
        self, recipients: list[str], subject: str, body: str
    ) -> None: ...


class StubEmailProvider:
    """Logs instead of sending. Lets the finalise -> distribute flow complete."""

    async def send_meeting_notes(
        self, recipients: list[str], subject: str, body: str
    ) -> None:
        logger.info("stub email '%s' -> %s (%d chars)", subject, recipients, len(body))


class GraphEmailProvider:
    """Microsoft Graph sendMail; lands with Entra ID credentials."""

    async def send_meeting_notes(
        self, recipients: list[str], subject: str, body: str
    ) -> None:
        raise NotImplementedError("Graph email requires Entra ID app credentials")


def get_email_provider() -> EmailProvider:
    settings = get_settings()
    # Graph readiness is keyed off the Key Vault/tenant settings later; for now
    # any empty endpoint means stub.
    if settings.key_vault_url:
        return GraphEmailProvider()
    return StubEmailProvider()
