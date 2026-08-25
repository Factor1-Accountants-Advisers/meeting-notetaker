"""Support endpoints: report-problem, feedback (IN-473)."""

import base64

from fastapi import APIRouter, Header
from pydantic import BaseModel

from app.services.email import GraphEmailProvider


router = APIRouter(tags=["support"])


class ReportProblemRequest(BaseModel):
    issue: str
    # Full main.log tail, gzipped then base64 (25 Aug 2026: both field
    # diagnoses stalled on the 30-line inline excerpt). Optional — old
    # clients simply never send it.
    log_gz_b64: str | None = None


# Defence in depth only: the desktop caps its tail far smaller, and Graph
# sendMail rejects large inline attachments anyway. A report must never fail
# over its log, so anything invalid or oversized is dropped, not rejected.
MAX_LOG_ATTACHMENT_BYTES = 3 * 1024 * 1024


def _log_attachment(log_gz_b64: str | None) -> list[dict] | None:
    if not log_gz_b64:
        return None
    try:
        raw = base64.b64decode(log_gz_b64, validate=True)
    except (ValueError, TypeError):
        return None
    if not raw.startswith(b"\x1f\x8b") or len(raw) > MAX_LOG_ATTACHMENT_BYTES:
        return None
    return [
        {
            "@odata.type": "#microsoft.graph.fileAttachment",
            "name": "main.log.gz",
            "contentType": "application/gzip",
            "contentBytes": log_gz_b64,
        }
    ]


@router.post("/report-problem")
async def report_problem(
    body: ReportProblemRequest,
    user: str = Header("Unknown user", alias="X-MN-User"),
    user_email: str | None = Header(None, alias="X-MN-User-Email"),
    user_agent: str | None = Header(None, alias="User-Agent"),
    graph_token: str = Header("", alias="X-MN-Graph-Token"),
    recent_logs_b64: str = Header("", alias="X-MN-Recent-Logs"),
):
    """Send a user-reported issue to innovations@factor1.com.au (IN-473)."""
    issue = body.issue.strip()
    if not issue:
        return {"ok": False, "error": "Issue description is required."}

    sender = user_email or "unknown"
    sections = [
        f"Notetaker user report",
        f"User: {user} ({sender})",
    ]

    if user_agent:
        sections.append(f"Client: {user_agent}")

    sections.append("---")
    sections.append(issue)

    if recent_logs_b64:
        try:
            logs = base64.b64decode(recent_logs_b64).decode("utf-8", errors="replace")
            if logs.strip():
                sections.append("")
                sections.append("---")
                sections.append("Recent logs (main.log, last ~30 lines):")
                sections.append(logs)
        except Exception:
            pass  # Best-effort; don't block the report over bad log data.

    attachments = _log_attachment(body.log_gz_b64)
    if attachments:
        sections.append("")
        sections.append("Full main.log attached (gzip).")
    elif body.log_gz_b64:
        sections.append("")
        sections.append("Log attachment omitted (invalid or too large).")

    body_text = "\n".join(sections)

    if not graph_token:
        return {"ok": False, "error": "Not signed in — cannot send report."}

    provider = GraphEmailProvider()
    await provider.send_meeting_notes(
        recipients=["innovations@factor1.com.au"],
        subject=f"Notetaker report from {user}",
        body=body_text,
        access_token=graph_token,
        content_type="Text",
        attachments=attachments,
    )

    return {"ok": True}
