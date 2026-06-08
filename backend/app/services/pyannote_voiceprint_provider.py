"""pyannoteAI voiceprint provider adapter.

Only provider voiceprint IDs/values should be persisted. Raw samples are passed
as local temp files by the onboarding service and deleted after this adapter
returns.
"""
from __future__ import annotations

import json
import os
import time
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

    def identify_speakers(
        self,
        audio_path: str | Path,
        *,
        voiceprints: list[dict[str, str]],
        num_speakers: int | None = None,
        matching_threshold: int = 60,
        exclusive_matching: bool = True,
    ) -> list[dict[str, Any]]:
        """Identify known speakers in meeting audio and return normalized segments."""
        path = Path(audio_path)
        if not path.exists():
            raise FileNotFoundError(path)
        if not voiceprints:
            return []

        media_url = f"media://meeting-identification/{uuid4().hex}{path.suffix or '.wav'}"
        self._upload_media_file(path, media_url)
        payload: dict[str, Any] = {
            "url": media_url,
            "model": "precision-2",
            "voiceprints": [
                {"label": item["label"], "voiceprint": item["voiceprint"]}
                for item in voiceprints
            ],
            "matching": {
                "threshold": matching_threshold,
                "exclusive": exclusive_matching,
            },
        }
        if num_speakers is not None:
            payload["numSpeakers"] = num_speakers

        job = self._request("POST", "/v1/identify", payload)
        job_id = job.get("jobId") or job.get("id")
        if not isinstance(job_id, str) or not job_id:
            raise PyannoteVoiceprintError("pyannoteAI identify did not return a job id")
        result = self._wait_for_job(job_id)
        if str(result.get("status") or "").lower() != "succeeded":
            raise PyannoteVoiceprintError("pyannoteAI identify job did not succeed")
        return _normalize_identity_segments(result, voiceprints)

    def _wait_for_job(self, job_id: str, *, interval_seconds: int = 10, timeout_seconds: int = 1800) -> dict[str, Any]:
        deadline = time.time() + timeout_seconds
        terminal_statuses = {"succeeded", "failed", "canceled"}
        while True:
            result = self._request("GET", f"/v1/jobs/{job_id}")
            status = str(result.get("status") or "").lower()
            if status in terminal_statuses:
                return result
            if time.time() >= deadline:
                raise PyannoteVoiceprintError(f"Timed out waiting for pyannoteAI job {job_id}")
            time.sleep(interval_seconds)

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


def _normalize_identity_segments(
    result: dict[str, Any],
    voiceprints: list[dict[str, str]],
) -> list[dict[str, Any]]:
    label_to_email = {item.get("label"): item.get("email") for item in voiceprints}
    raw_segments = result.get("diarization") or result.get("identification") or result.get("segments") or []
    normalized: list[dict[str, Any]] = []
    if not isinstance(raw_segments, list):
        return normalized

    for item in raw_segments:
        if not isinstance(item, dict):
            continue
        label = item.get("label") or item.get("speaker") or item.get("display_name")
        confidence = item.get("confidence")
        if isinstance(confidence, dict) and label in confidence:
            confidence = confidence[label]
        elif isinstance(confidence, dict) and confidence:
            # Use the selected speaker score when available; otherwise max score.
            confidence = max(confidence.values())
        normalized.append({
            "start": item.get("start", 0.0),
            "end": item.get("end", 0.0),
            "display_name": label,
            "email": label_to_email.get(label),
            "confidence": confidence if confidence is not None else 0.0,
        })
    return normalized


def _safe_label(label: str) -> str:
    safe = "".join(ch.lower() if ch.isalnum() else "-" for ch in label).strip("-")
    return "-".join(part for part in safe.split("-") if part) or "speaker"
