"""Support endpoints: report-problem, feedback (IN-473)."""

import base64

from fastapi import APIRouter, Header
from pydantic import BaseModel

from app.services.email import GraphEmailProvider


router = APIRouter(tags=["support"])


class ReportProblemRequest(BaseModel):
    issue: str


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
    )

    return {"ok": True}
