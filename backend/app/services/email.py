"""Outbound email (decision #9: Microsoft Graph after finalisation).

Uses delegated Mail.Send via the user's own Outlook — the Electron main process
passes the MSAL access token as X-MN-Graph-Token. No app-only credentials
or client secrets are held by the backend.
"""

import base64
import json
import logging
from typing import Protocol

from app.config import get_settings

logger = logging.getLogger(__name__)

GRAPH_SEND_MAIL_URL = "https://graph.microsoft.com/v1.0/me/sendMail"


class EmailProvider(Protocol):
    async def send_meeting_notes(
        self,
        recipients: list[str],
        subject: str,
        body: str,
        attachments: list[dict] | None = None,
        access_token: str | None = None,
    ) -> None: ...


class StubEmailProvider:
    """Logs instead of sending. Lets the finalise -> distribute flow complete."""

    async def send_meeting_notes(
        self,
        recipients: list[str],
        subject: str,
        body: str,
        attachments: list[dict] | None = None,
        access_token: str | None = None,
    ) -> None:
        attach_info = f", {len(attachments)} attachments" if attachments else ""
        logger.info(
            "stub email '%s' -> %s (%d chars%s)",
            subject, recipients, len(body), attach_info,
        )


class GraphEmailProvider:
    """Microsoft Graph delegated sendMail (IN-93).

    Sends email through the signed-in user's Outlook using the delegated
    Mail.Send permission. The access token is provided by the Electron
    main process's MSAL token cache.
    """

    async def send_meeting_notes(
        self,
        recipients: list[str],
        subject: str,
        body: str,
        attachments: list[dict] | None = None,
        access_token: str | None = None,
    ) -> None:
        if not access_token:
            raise ValueError("Graph email requires a delegated access token")

        message = {
            "subject": subject,
            "body": {
                "contentType": "Text",
                "content": body,
            },
            "toRecipients": [
                {"emailAddress": {"address": addr}} for addr in recipients
            ],
        }

        if attachments:
            message["attachments"] = attachments

        payload = {
            "message": message,
            "saveToSentItems": "true",
        }

        import urllib.request

        req = urllib.request.Request(
            GRAPH_SEND_MAIL_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                if resp.status not in (200, 201, 202):
                    body_text = resp.read().decode()
                    logger.error("Graph sendMail failed: %s %s", resp.status, body_text[:200])
                    raise RuntimeError(f"Graph sendMail returned {resp.status}")
        except urllib.error.HTTPError as e:
            body_text = e.read().decode()
            logger.error("Graph sendMail HTTP error %s: %s", e.code, body_text[:200])
            raise RuntimeError(f"Graph sendMail failed: {e.code}") from e

        logger.info(
            "graph email sent: '%s' -> %s (%d chars, %d attachments)",
            subject, recipients, len(body), len(attachments or []),
        )


def build_transcript_attachment(
    filename: str, content: str, content_type: str = "text/plain"
) -> dict:
    """Build a Graph fileAttachment object from transcript text."""
    content_bytes = base64.b64encode(content.encode("utf-8")).decode("ascii")
    return {
        "@odata.type": "#microsoft.graph.fileAttachment",
        "name": filename,
        "contentType": content_type,
        "contentBytes": content_bytes,
    }


def get_email_provider(access_token: str | None = None) -> EmailProvider:
    settings = get_settings()
    if access_token:
        return GraphEmailProvider()
    return StubEmailProvider()
