#!/usr/bin/env python3
"""Small pyannoteAI client for the voiceprint identification experiment.

Standard-library only. Never logs API keys, signed upload URLs, or voiceprint values.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

API_BASE_URL = "https://api.pyannote.ai"
TERMINAL_STATUSES = {"succeeded", "failed", "canceled"}


class PyannoteError(RuntimeError):
    """Raised for pyannoteAI API failures."""


@dataclass(frozen=True)
class PollConfig:
    interval_seconds: int = 10
    timeout_seconds: int = 1800


class PyannoteClient:
    def __init__(self, api_key: str | None = None, base_url: str = API_BASE_URL):
        self.api_key = api_key or os.environ.get("PYANNOTE_API_KEY")
        if not self.api_key:
            raise PyannoteError("PYANNOTE_API_KEY is not set")
        self.base_url = base_url.rstrip("/")

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
            raise PyannoteError(f"pyannoteAI HTTP {exc.code}: {message}") from exc
        except urllib.error.URLError as exc:
            raise PyannoteError(f"pyannoteAI request failed: {exc.reason}") from exc
        if not response_data:
            return {}
        try:
            return json.loads(response_data.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise PyannoteError("pyannoteAI returned non-JSON response") from exc

    def create_media_upload_url(self, media_url: str) -> str:
        response = self._request("POST", "/v1/media/input", {"url": media_url})
        upload_url = response.get("url")
        if not isinstance(upload_url, str):
            raise PyannoteError("Media API did not return an upload URL")
        return upload_url

    def upload_media_file(self, local_path: Path, media_url: str) -> str:
        if not local_path.exists():
            raise FileNotFoundError(local_path)
        upload_url = self.create_media_upload_url(media_url)
        self._request(
            "PUT",
            upload_url,
            raw_body=local_path.read_bytes(),
            headers={"Content-Type": "application/octet-stream"},
            signed_url=True,
        )
        return media_url

    def create_voiceprint_job(self, media_url: str, model: str = "precision-2") -> dict[str, Any]:
        return self._request("POST", "/v1/voiceprint", {"url": media_url, "model": model})

    def identify_job(
        self,
        media_url: str,
        voiceprints: list[dict[str, str]],
        model: str = "precision-2",
        matching_threshold: int = 60,
        exclusive_matching: bool = True,
        num_speakers: int | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "url": media_url,
            "model": model,
            "voiceprints": voiceprints,
            "matching": {
                "threshold": matching_threshold,
                "exclusive": exclusive_matching,
            },
        }
        if num_speakers is not None:
            payload["numSpeakers"] = num_speakers
        return self._request("POST", "/v1/identify", payload)

    def get_job(self, job_id: str) -> dict[str, Any]:
        return self._request("GET", f"/v1/jobs/{job_id}")

    def wait_for_job(self, job_id: str, poll: PollConfig) -> dict[str, Any]:
        deadline = time.time() + poll.timeout_seconds
        while True:
            result = self.get_job(job_id)
            status = str(result.get("status") or "").lower()
            print(f"job {job_id}: {status}")
            if status in TERMINAL_STATUSES:
                return result
            if time.time() >= deadline:
                raise PyannoteError(f"Timed out waiting for job {job_id}")
            time.sleep(poll.interval_seconds)


def load_json(path: Path) -> Any:
    return json.loads(path.read_text())


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2))


def safe_media_key(prefix: str, label: str, suffix: str) -> str:
    safe_label = "".join(ch.lower() if ch.isalnum() else "-" for ch in label).strip("-")
    safe_label = "-".join(part for part in safe_label.split("-") if part)
    return f"media://{prefix.strip('/')}/{safe_label}.{suffix.lstrip('.')}"


def require_manifest(path: Path) -> dict[str, Any]:
    manifest = load_json(path)
    if not isinstance(manifest, dict):
        raise ValueError("Manifest must be a JSON object")
    return manifest
