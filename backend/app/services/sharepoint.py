"""SharePoint meeting-artifact storage provider.

Meeting transcripts and summaries are saved as separate files in a locked-down
SharePoint location. Until tenant-specific drive/folder provisioning is
complete, the local provider writes the same two artifacts under
backend/var/sharepoint.
When a Graph token and drive configuration are available, the Graph provider can
upload to the configured drive/folder without exposing secrets to the desktop.
"""

from __future__ import annotations

import json
import logging
import re
import urllib.error
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
    ) -> list[str]:
        """Grant read access; returns the recipients that could NOT be granted."""
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
    return f"{_filename_basis(title, created_at)} - Transcript.md"


def safe_summary_filename(title: str, created_at: datetime) -> str:
    """Build the summary filename paired with ``safe_transcript_filename``.

    Both names share one basis so the pair can never drift apart across
    delivery retries.
    """
    return f"{_filename_basis(title, created_at)} - Summary.md"


def _filename_basis(title: str, created_at: datetime) -> str:
    """Shared ``YYYY-MM-DD Title`` stem for the IN-385 artifact pair.

    Convention per the IN-385 ticket (date-first, ``.md``, explicit
    ``- Transcript``/``- Summary`` suffixes) — supersedes the Slice 1
    ``Title-YYYY-MM-DD.txt`` name on 31 Jul 2026.
    """
    cleaned = re.sub(r"[^A-Za-z0-9_. -]+", "-", title).strip(" .-")
    if not cleaned:
        cleaned = "meeting"
    basis = created_at if created_at.tzinfo else created_at.replace(tzinfo=timezone.utc)
    date_part = basis.astimezone(timezone.utc).strftime("%Y-%m-%d")
    return f"{date_part} {cleaned[:60]}"


class LocalSharePointProvider:
    """Local stand-in for the provisioned SharePoint meeting-artifact folder."""

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
        logger.info("local SharePoint artifact saved for %s: %s", meeting.id, path)
        return SharePointUploadResult(web_url=path.as_uri(), item_id=str(path))

    async def grant_view(
        self,
        *,
        item_id: str,
        recipients: list[str],
        access_token: str | None = None,
    ) -> list[str]:
        """Local stub mode has no real permission system; nothing to grant."""
        return []


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
                "Content-Type": "text/markdown; charset=utf-8",
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
        logger.info("SharePoint artifact saved for %s: %s", meeting.id, filename)
        return SharePointUploadResult(web_url=web_url, item_id=item_id)

    async def grant_view(
        self,
        *,
        item_id: str,
        recipients: list[str],
        access_token: str | None = None,
    ) -> list[str]:
        """Grant read access one recipient at a time (Option A, IN-398 Test 1
        failure 3 Aug 2026: a batch invite 400s wholesale when it contains one
        ungrantable attendee — external guest, distribution list — and the
        Graph error body naming the culprit was being discarded). Recipients
        that cannot be granted are returned for the caller to surface as a
        warning; they must never fail the file delivery itself."""
        if not recipients:
            return []
        if not access_token:
            raise ValueError("SharePoint permission grant requires a delegated Graph token")
        url = f"{GRAPH_DRIVE_BASE}/{self._drive_id}/items/{item_id}/invite"
        failed: list[str] = []
        for email in recipients:
            payload = {
                "recipients": [{"email": email}],
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
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    body = json.loads(resp.read().decode("utf-8"))
                granted = body.get("value")
                if not isinstance(granted, list) or not granted:
                    raise RuntimeError("Graph invite succeeded but granted no permission")
            except Exception as exc:  # noqa: BLE001 — per-recipient isolation is the point
                failed.append(email)
                logger.warning(
                    "SharePoint view grant failed for %s on item %s: %s",
                    email,
                    item_id,
                    _grant_error_detail(exc),
                )
        granted_count = len(recipients) - len(failed)
        if failed:
            logger.warning(
                "SharePoint view access granted for item %s to %d of %d recipient(s); ungranted: %s",
                item_id,
                granted_count,
                len(recipients),
                ", ".join(failed),
            )
        else:
            logger.info(
                "SharePoint view access granted for item %s to %d recipient(s)",
                item_id,
                granted_count,
            )
        return failed


def _grant_error_detail(exc: Exception) -> str:
    """Extract a diagnosable message from a grant failure.

    The 3 Aug field incident logged a bare "HTTP Error 400: Bad Request" —
    the Graph error body, which names the invalid recipient and the reason,
    was read-once-and-lost inside urllib. Pull it out (bounded) so the log
    line actually says why the grant failed.
    """
    if isinstance(exc, urllib.error.HTTPError):
        try:
            body = exc.read().decode("utf-8", errors="replace")[:500]
        except Exception:  # noqa: BLE001 — diagnostics only
            body = ""
        return f"HTTP {exc.code} {exc.reason}: {body}" if body else f"HTTP {exc.code} {exc.reason}"
    return f"{exc.__class__.__name__}: {exc}"


def get_sharepoint_provider(access_token: str | None = None) -> SharePointProvider:
    settings = get_settings()
    drive_id = getattr(settings, "sharepoint_drive_id", "")
    folder_path = getattr(settings, "sharepoint_folder_path", "")
    if access_token and drive_id:
        return GraphSharePointProvider(drive_id, folder_path)
    return LocalSharePointProvider()
