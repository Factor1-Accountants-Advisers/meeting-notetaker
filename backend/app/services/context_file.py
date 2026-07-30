"""Company context provider (IN-383).

A company context file (hosted on SharePoint) enriches meeting summaries with
organisational background (names, products, terminology). Context is an
enrichment, never a gate: any failure to obtain it — missing file, missing
token, HTTP error, timeout — logs one structured warning line and returns
``None`` so the pipeline proceeds exactly as it would without a context file.

Provider seam mirrors ``app.services.sharepoint``:

- Stand-in mode (``MN_CONTEXT_DRIVE_ID`` or ``MN_CONTEXT_FILE_PATH`` empty):
  read ``context_dir()/company-context.md`` when present. The directory is
  the convention; the file is never created automatically.
- Graph mode (both set): fetch the drive item content with the delegated
  Graph token. No Graph token reaches the pipeline today (upload/retry only
  carry ``X-MN-Storage-Token``), so Graph mode degrades gracefully to
  no-context until a delegated token is threaded through to processing.
"""

from __future__ import annotations

import logging
import urllib.parse
import urllib.request

from app.config import get_settings
from app.paths import context_dir

logger = logging.getLogger(__name__)

# Hard cap so a runaway context file cannot starve the transcript out of the
# model window. Longer content is truncated with a logged warning.
CONTEXT_CHAR_CAP = 8000

# Stand-in filename under context_dir().
CONTEXT_FILENAME = "company-context.md"

GRAPH_DRIVE_BASE = "https://graph.microsoft.com/v1.0/drives"
_GRAPH_TIMEOUT_S = 30


def _capped(text: str, *, source: str) -> str | None:
    """Strip, enforce ``CONTEXT_CHAR_CAP``, and treat empty content as absent."""
    content = text.strip()
    if not content:
        return None
    if len(content) > CONTEXT_CHAR_CAP:
        logger.warning(
            "company context truncated: source=%s length=%d cap=%d",
            source,
            len(content),
            CONTEXT_CHAR_CAP,
        )
        content = content[:CONTEXT_CHAR_CAP]
    return content


def _read_standin_context() -> str | None:
    directory = context_dir()
    # Establish the drop-location convention; the file is never created.
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / CONTEXT_FILENAME
    if not path.exists():
        return None
    return _capped(path.read_text(encoding="utf-8"), source="standin")


def _fetch_graph_context(
    drive_id: str, file_path: str, access_token: str | None
) -> str | None:
    if not access_token:
        logger.warning(
            "company context unavailable: source=graph reason=no_graph_token"
        )
        return None
    quoted_path = urllib.parse.quote(file_path.strip("/"))
    url = f"{GRAPH_DRIVE_BASE}/{drive_id}/root:/{quoted_path}:/content"
    req = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {access_token}"}
    )
    with urllib.request.urlopen(req, timeout=_GRAPH_TIMEOUT_S) as resp:
        body = resp.read().decode("utf-8", errors="replace")
    return _capped(body, source="graph")


def get_company_context(access_token: str | None = None) -> str | None:
    """Return the company context text, or ``None`` when unavailable.

    Never raises — context is enrichment, never a gate, and its absence must
    not create a new pipeline failure category.
    """
    source = "standin"
    try:
        settings = get_settings()
        if settings.context_drive_id and settings.context_file_path:
            source = "graph"
            return _fetch_graph_context(
                settings.context_drive_id,
                settings.context_file_path,
                access_token,
            )
        return _read_standin_context()
    except Exception as exc:
        # One structured line. Log only the exception class: a provider error
        # body could embed the delegated token (blob_delivery precedent).
        logger.warning(
            "company context unavailable: source=%s reason=%s",
            source,
            exc.__class__.__name__,
        )
        return None
