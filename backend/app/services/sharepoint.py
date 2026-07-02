"""SharePoint transcript storage provider.

Slice 1 requires transcripts/summaries to be saved to a locked-down SharePoint
location. Until tenant-specific drive/folder provisioning is complete, the local
provider writes the exact transcript artifact under backend/var/sharepoint.
When a Graph token and drive configuration are available, the Graph provider can
upload to the configured drive/folder without exposing secrets to the desktop.
"""

from __future__ import annotations

import json
import logging
import re
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Protocol

from app.config import get_settings
from app.schemas import Meeting

logger = logging.getLogger(__name__)

LOCAL_SHAREPOINT_DIR = Path(__file__).resolve().parents[2] / "var" / "sharepoint"
GRAPH_DRIVE_BASE = "https://graph.microsoft.com/v1.0/drives"


class SharePointProvider(Protocol):
    async def save_transcript(
        self,
        *,
        meeting: Meeting,
        filename: str,
        content: str,
        access_token: str | None = None,
    ) -> str:
        ...


def safe_transcript_filename(title: str, meeting_id: object) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_. -]+", "-", title).strip(" .-")
    if not cleaned:
        cleaned = "meeting"
    return f"{cleaned[:60]}-{str(meeting_id)[:8]}.txt"


class LocalSharePointProvider:
    """Local stand-in for the provisioned SharePoint transcript folder."""

    async def save_transcript(
        self,
        *,
        meeting: Meeting,
        filename: str,
        content: str,
        access_token: str | None = None,
    ) -> str:
        LOCAL_SHAREPOINT_DIR.mkdir(parents=True, exist_ok=True)
        path = LOCAL_SHAREPOINT_DIR / filename
        path.write_text(content, encoding="utf-8")
        logger.info("local SharePoint transcript saved for %s: %s", meeting.id, path)
        return path.as_uri()


class GraphSharePointProvider:
    """Microsoft Graph upload to a configured SharePoint/OneDrive drive folder."""

    def __init__(self, drive_id: str, folder_path: str) -> None:
        self._drive_id = drive_id
        self._folder_path = folder_path.strip("/")

    async def save_transcript(
        self,
        *,
        meeting: Meeting,
        filename: str,
        content: str,
        access_token: str | None = None,
    ) -> str:
        if not access_token:
            raise ValueError("SharePoint save requires a delegated Graph token")
        upload_path = f"{self._folder_path}/{filename}" if self._folder_path else filename
        quoted_path = urllib.parse.quote(upload_path)
        url = f"{GRAPH_DRIVE_BASE}/{self._drive_id}/root:/{quoted_path}:/content"
        req = urllib.request.Request(
            url,
            data=content.encode("utf-8"),
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "text/plain; charset=utf-8",
            },
            method="PUT",
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        web_url = body.get("webUrl")
        if not isinstance(web_url, str) or not web_url:
            raise RuntimeError("Graph upload completed but returned no webUrl")
        logger.info("SharePoint transcript saved for %s", meeting.id)
        return web_url


def get_sharepoint_provider(access_token: str | None = None) -> SharePointProvider:
    settings = get_settings()
    drive_id = getattr(settings, "sharepoint_drive_id", "")
    folder_path = getattr(settings, "sharepoint_folder_path", "")
    if access_token and drive_id:
        return GraphSharePointProvider(drive_id, folder_path)
    return LocalSharePointProvider()
