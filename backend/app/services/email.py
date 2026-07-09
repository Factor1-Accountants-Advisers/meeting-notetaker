"""Outbound email (decision #9: Microsoft Graph after finalisation).

Uses delegated Mail.Send via the user's own Outlook — the Electron main process
passes the MSAL access token as X-MN-Graph-Token. No app-only credentials
or client secrets are held by the backend.
"""

import base64
import html
import json
import logging
from typing import Protocol

from app.config import get_settings

logger = logging.getLogger(__name__)

GRAPH_SEND_MAIL_URL = "https://graph.microsoft.com/v1.0/me/sendMail"

# Inline styling only — Outlook and other clients strip <style>/<head> blocks.
_FONT = "Segoe UI, Arial, sans-serif"
_TEXT = "#1f2937"
_MUTED = "#6b7280"
_BORDER = "#e5e7eb"
_HEADING = "#111827"


class EmailProvider(Protocol):
    async def send_meeting_notes(
        self,
        recipients: list[str],
        subject: str,
        body: str,
        attachments: list[dict] | None = None,
        access_token: str | None = None,
        *,
        content_type: str = "Text",
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
        *,
        content_type: str = "Text",
    ) -> None:
        attach_info = f", {len(attachments)} attachments" if attachments else ""
        logger.info(
            "stub email '%s' -> %s (%d chars%s, %s)",
            subject, recipients, len(body), attach_info, content_type,
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
        *,
        content_type: str = "Text",
    ) -> None:
        if not access_token:
            raise ValueError("Graph email requires a delegated access token")

        normalized_type = "HTML" if content_type.upper() == "HTML" else "Text"
        message = {
            "subject": subject,
            "body": {
                "contentType": normalized_type,
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
            "graph email sent: '%s' -> %s (%d chars, %d attachments, %s)",
            subject, recipients, len(body), len(attachments or []), normalized_type,
        )


def _plain_text_to_html(text: str) -> str:
    """Fallback: wrap a plain-text summary as HTML paragraphs (escaped).

    Used when no rich summary is available (stub provider, very short
    recordings, or legacy meetings recorded before HTML summaries existed).
    """
    paragraphs = [block.strip() for block in text.split("\n\n") if block.strip()]
    return "".join(
        f'<p style="margin:0 0 16px;font-family:{_FONT};font-size:14px;'
        f'line-height:1.6;color:{_TEXT};">{html.escape(block).replace(chr(10), "<br>")}</p>'
        for block in paragraphs
    )


def _action_items_html(action_items: list) -> str:
    header_cell = (
        f'padding:10px 12px;background:#f3f4f6;border-bottom:1px solid {_BORDER};'
        f'font-size:12px;font-weight:600;color:{_MUTED};'
    )
    headers = "".join(
        f'<th align="left" style="{header_cell}">{label}</th>'
        for label in ("#", "Action", "Owner", "Due")
    )

    rows: list[str] = []
    for index, item in enumerate(action_items, start=1):
        deadline = item.deadline.strftime("%d %b %Y") if getattr(item, "deadline", None) else "TBC"
        cell = f'padding:10px 12px;border-bottom:1px solid {_BORDER};font-size:14px;color:{_TEXT};'
        rows.append(
            "<tr>"
            f'<td style="{cell}">{index}</td>'
            f'<td style="{cell}">{html.escape(item.description)}</td>'
            f'<td style="{cell}">{html.escape(item.owner or "TBC")}</td>'
            f'<td style="{cell}">{html.escape(deadline)}</td>'
            "</tr>"
        )

    return (
        f'<h2 style="margin:28px 0 12px;font-family:{_FONT};font-size:16px;'
        f'font-weight:600;color:{_HEADING};">Action items</h2>'
        '<table role="presentation" cellpadding="0" cellspacing="0" '
        f'style="width:100%;border-collapse:collapse;border:1px solid {_BORDER};">'
        f"<thead><tr>{headers}</tr></thead>"
        f"<tbody>{''.join(rows)}</tbody>"
        "</table>"
    )


def build_meeting_notes_email_html(
    *,
    meeting_title: str,
    summary_html: str | None,
    summary_text: str,
    note: str | None = None,
    action_items: list | None = None,
) -> str:
    """Compose the rich-text (HTML) email body for meeting notes.

    Wraps the LLM-rendered summary fragment (or a plain-text fallback) with a
    title, an optional sender note, and an action-item table. All caller-derived
    text is HTML-escaped; the summary fragment is trusted because it is rendered
    deterministically by the LLM service.
    """
    parts: list[str] = [
        f'<div style="font-family:{_FONT};color:{_TEXT};max-width:680px;">',
        f'<p style="margin:0 0 8px;font-size:12px;letter-spacing:0.04em;'
        f'text-transform:uppercase;color:{_MUTED};">Meeting notes</p>',
        f'<h1 style="margin:0 0 20px;font-size:22px;font-weight:600;line-height:1.3;'
        f'color:{_HEADING};">{html.escape(meeting_title)}</h1>',
    ]

    if note and note.strip():
        parts.append(
            f'<p style="margin:0 0 20px;padding:12px 16px;background:#f9fafb;'
            f'border-left:3px solid #2563eb;font-size:14px;line-height:1.6;'
            f'color:{_TEXT};">{html.escape(note.strip()).replace(chr(10), "<br>")}</p>'
        )

    parts.append(summary_html or _plain_text_to_html(summary_text))

    if action_items:
        parts.append(_action_items_html(action_items))

    parts.append(
        f'<p style="margin:28px 0 0;font-family:{_FONT};font-size:12px;line-height:1.5;'
        f'color:{_MUTED};">The full transcript is attached. Prepared by Notetaker.</p>'
    )
    parts.append("</div>")
    return "".join(parts)


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
