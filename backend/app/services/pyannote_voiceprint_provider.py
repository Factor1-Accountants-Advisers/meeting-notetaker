"""pyannoteAI voiceprint provider adapter.

Only provider voiceprint IDs/values should be persisted. Raw samples are passed
as local temp files by the onboarding service and deleted after this adapter
returns.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.core.config import settings

API_BASE_URL = "https://api.pyannote.ai"


class PyannoteVoiceprintError(RuntimeError):
    """Raised for pyannoteAI voiceprint creation failures."""


class PyannoteVoiceprintProvider:
    """Create pyannoteAI voiceprints from local sample files."""

    def __init__(self, api_key: str | None = None, base_url: str = API_BASE_URL):
        self.api_key = api_key or settings.pyannote_api_key or os.environ.get("PYANNOTE_API_KEY")
        if not self.api_key:
            raise PyannoteVoiceprintError("PYANNOTE_API_KEY is not configured")
        self.base_url = base_url.rstrip("/")

    def create_voiceprint(self, sample_path: Path, *, label: str) -> str:
        """Upload sample and return provider voiceprint payload/id.

        pyannote's voiceprint endpoint returns a provider-specific voiceprint
        value. Treat it as opaque and never log it.
        """
        if not sample_path.exists():
            raise FileNotFoundError(sample_path)
        media_url = f"media://voiceprint-samples/{_safe_label(label)}-{uuid4().hex}{sample_path.suffix}"
        self._upload_media_file(sample_path, media_url)
        response = self._request("POST", "/v1/voiceprint", {"url": media_url, "model": "precision-2"})
        voiceprint = response.get("voiceprint") or response.get("id")
        if not isinstance(voiceprint, str) or not voiceprint:
            raise PyannoteVoiceprintError("pyannoteAI did not return a voiceprint")
        return voiceprint

    def _upload_media_file(self, sample_path: Path, media_url: str) -> None:
        response = self._request("POST", "/v1/media/input", {"url": media_url})
        upload_url = response.get("url")
        if not isinstance(upload_url, str):
            raise PyannoteVoiceprintError("pyannoteAI media API did not return an upload URL")
        self._request(
            "PUT",
            upload_url,
            raw_body=sample_path.read_bytes(),
            headers={"Content-Type": "application/octet-stream"},
            signed_url=True,
        )

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        raw_body: bytes | None = None,
        headers: dict[str, str] | None = None,
        signed_url: bool = False,
    ) -> dict[str, Any]:
        url = path if signed_url else f"{self.base_url}{path}"
        request_headers = dict(headers or {})
        data = raw_body
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            request_headers.setdefault("Content-Type", "application/json")
        if not signed_url:
            request_headers["Authorization"] = f"Bearer {self.api_key}"
        request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                response_data = response.read()
        except urllib.error.HTTPError as exc:
            message = exc.read().decode("utf-8", errors="replace")[:1000]
            raise PyannoteVoiceprintError(f"pyannoteAI HTTP {exc.code}: {message}") from exc
        except urllib.error.URLError as exc:
            raise PyannoteVoiceprintError(f"pyannoteAI request failed: {exc.reason}") from exc
        if not response_data:
            return {}
        try:
            return json.loads(response_data.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise PyannoteVoiceprintError("pyannoteAI returned non-JSON response") from exc


def get_pyannote_voiceprint_provider() -> PyannoteVoiceprintProvider:
    return PyannoteVoiceprintProvider()


def _safe_label(label: str) -> str:
    safe = "".join(ch.lower() if ch.isalnum() else "-" for ch in label).strip("-")
    return "-".join(part for part in safe.split("-") if part) or "speaker"
