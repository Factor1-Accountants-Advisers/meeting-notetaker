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
from datetime import datetime, timezone
import urllib.request
from pathlib import Path
from typing import NamedTuple, Protocol

from app.config import get_settings
from app.paths import local_sharepoint_dir
from app.schemas import Meeting

logger = logging.getLogger(__name__)

LOCAL_SHAREPOINT_DIR = local_sharepoint_dir()
GRAPH_DRIVE_BASE = "https://graph.microsoft.com/v1.0/drives"


class SharePointUploadResult(NamedTuple):
    web_url: str
    item_id: str


class SharePointProvider(Protocol):
    async def save_transcript(
        self,
        *,
        meeting: Meeting,
        filename: str,
        content: str,
        access_token: str | None = None,
    ) -> SharePointUploadResult:
        ...

    async def grant_view(
        self,
        *,
        item_id: str,
        recipients: list[str],
        access_token: str | None = None,
    ) -> None:
        ...


def safe_transcript_filename(title: str, created_at: datetime) -> str:
    """Build a deterministic transcript filename.

    The date portion is derived from `created_at` (a stable, always-present
    field on the Meeting model) rather than wall-clock time. A retry of a
    failed SharePoint delivery (e.g. upload succeeds, grant_view fails)
    must recompute the exact same filename as the original attempt, or a
    retry that crosses a UTC calendar day boundary uploads a second,
    differently-named file and orphans the first — unpermissioned, and
    with no record of it once the failed attempt's item id is discarded
    (IN-387 final review).
    """
    cleaned = re.sub(r"[^A-Za-z0-9_. -]+", "-", title).strip(" .-")
    if not cleaned:
        cleaned = "meeting"
    basis = created_at if created_at.tzinfo else created_at.replace(tzinfo=timezone.utc)
    date_part = basis.astimezone(timezone.utc).strftime("%Y-%m-%d")
    return f"{cleaned[:60]}-{date_part}.txt"


class LocalSharePointProvider:
    """Local stand-in for the provisioned SharePoint transcript folder."""

    async def save_transcript(
        self,
        *,
        meeting: Meeting,
        filename: str,
        content: str,
        access_token: str | None = None,
    ) -> SharePointUploadResult:
        LOCAL_SHAREPOINT_DIR.mkdir(parents=True, exist_ok=True)
        path = LOCAL_SHAREPOINT_DIR / filename
        path.write_text(content, encoding="utf-8")
        logger.info("local SharePoint transcript saved for %s: %s", meeting.id, path)
        return SharePointUploadResult(web_url=path.as_uri(), item_id=str(path))

    async def grant_view(
        self,
        *,
        item_id: str,
        recipients: list[str],
        access_token: str | None = None,
    ) -> None:
        """Local stub mode has no real permission system; nothing to grant."""
        return


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
    ) -> SharePointUploadResult:
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
        item_id = body.get("id")
        if not isinstance(item_id, str) or not item_id:
            raise RuntimeError("Graph upload completed but returned no item id")
        logger.info("SharePoint transcript saved for %s", meeting.id)
        return SharePointUploadResult(web_url=web_url, item_id=item_id)

    async def grant_view(
        self,
        *,
        item_id: str,
        recipients: list[str],
        access_token: str | None = None,
    ) -> None:
        if not recipients:
            return
        if not access_token:
            raise ValueError("SharePoint permission grant requires a delegated Graph token")
        url = f"{GRAPH_DRIVE_BASE}/{self._drive_id}/items/{item_id}/invite"
        payload = {
            "recipients": [{"email": email} for email in recipients],
            "requireSignIn": True,
            "sendInvitation": False,
            "roles": ["read"],
        }
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        granted = body.get("value")
        if not isinstance(granted, list):
            granted = []
        if len(granted) < len(recipients):
            raise RuntimeError(
                f"SharePoint granted access to {len(granted)} of {len(recipients)} "
                "recipient(s); expected all"
            )
        logger.info(
            "SharePoint view access granted for item %s to %d recipient(s)",
            item_id,
            len(recipients),
        )


def get_sharepoint_provider(access_token: str | None = None) -> SharePointProvider:
    settings = get_settings()
    drive_id = getattr(settings, "sharepoint_drive_id", "")
    folder_path = getattr(settings, "sharepoint_folder_path", "")
    if access_token and drive_id:
        return GraphSharePointProvider(drive_id, folder_path)
    return LocalSharePointProvider()
