"""Small pyannoteAI API client for Jira IN-64/IN-69.

pyannoteAI is the Jira-mandated provider for Slice 1 transcription,
diarization, and voiceprint speaker identification. This client intentionally
uses the pyannoteAI API (`api.pyannote.ai`), not HuggingFace Inference.

Never log API keys, signed upload URLs, voiceprint payloads, or raw transcripts
from this module.
"""

from __future__ import annotations

import json
import logging
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4


logger = logging.getLogger(__name__)

DEFAULT_API_BASE_URL = "https://api.pyannote.ai"
TERMINAL_STATUSES = {"succeeded", "failed", "canceled", "cancelled"}


class PyannoteAIError(RuntimeError):
    """Raised for pyannoteAI API failures."""


@dataclass(frozen=True)
class PyannotePollConfig:
    interval_seconds: int = 10
    timeout_seconds: int = 1800


class PyannoteAIClient:
    def __init__(self, api_key: str, base_url: str = DEFAULT_API_BASE_URL) -> None:
        if not api_key:
            raise PyannoteAIError("pyannoteAI API key is not configured")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")

    def request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        raw_body: bytes | None = None,
        headers: dict[str, str] | None = None,
        signed_url: bool = False,
        timeout: int = 60,
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
            with urllib.request.urlopen(request, timeout=timeout) as response:
                response_data = response.read()
        except urllib.error.HTTPError as exc:
            message = exc.read().decode("utf-8", errors="replace")[:1000]
            raise PyannoteAIError(f"pyannoteAI HTTP {exc.code}: {message}") from exc
        except urllib.error.URLError as exc:
            raise PyannoteAIError(f"pyannoteAI request failed: {exc.reason}") from exc

        if not response_data:
            return {}
        try:
            return json.loads(response_data.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise PyannoteAIError("pyannoteAI returned non-JSON response") from exc

    def upload_media_file(self, local_path: Path, media_prefix: str) -> str:
        if not local_path.exists():
            raise FileNotFoundError(local_path)
        return self.upload_media_bytes(
            local_path.read_bytes(),
            media_prefix,
            suffix=local_path.suffix or ".webm",
        )

    def upload_media_bytes(
        self,
        data: bytes,
        media_prefix: str,
        *,
        suffix: str = ".webm",
        content_type: str = "application/octet-stream",
    ) -> str:
        if not data:
            raise PyannoteAIError("Cannot upload empty media")
        safe_prefix = re.sub(r"[^A-Za-z0-9_.-]+", "-", media_prefix.strip("/")).strip("-._")
        if not safe_prefix:
            safe_prefix = "notetaker-media"
        safe_suffix = suffix if suffix.startswith(".") else f".{suffix}"
        # pyannoteAI voiceprint validates media URLs strictly as
        # `media://object-key`; nested path keys may upload successfully via
        # /v1/media/input but are rejected by /v1/voiceprint. Keep the object
        # key flat and unique.
        media_url = f"media://{safe_prefix}-{uuid4().hex}{safe_suffix}"
        # Large uploads on constrained links (laptop Wi-Fi, WSL NAT under a
        # live Teams call) stall past the socket timeout — retry the whole
        # presign+PUT with backoff before failing the pipeline. Observed live
        # 2026-07-07: 7-min recording, ~83 KB/s uplink, two "write operation
        # timed out" failures that a retry would have absorbed.
        attempts = 3
        backoffs = [5, 15]
        last_error: Exception | None = None
        for attempt in range(attempts):
            try:
                upload = self.request("POST", "/v1/media/input", {"url": media_url})
                upload_url = upload.get("url")
                if not isinstance(upload_url, str):
                    raise PyannoteAIError("pyannoteAI media API did not return an upload URL")
                self.request(
                    "PUT",
                    upload_url,
                    raw_body=data,
                    headers={"Content-Type": content_type},
                    signed_url=True,
                    timeout=300,
                )
                return media_url
            except PyannoteAIError as exc:
                last_error = exc
                if attempt < attempts - 1:
                    delay = backoffs[min(attempt, len(backoffs) - 1)]
                    logger.warning(
                        "pyannoteAI media upload attempt %d/%d failed (%s); retrying in %ds",
                        attempt + 1, attempts, exc, delay,
                    )
                    time.sleep(delay)
        raise PyannoteAIError(
            f"pyannoteAI media upload failed after {attempts} attempts: {last_error}"
        ) from last_error

    def submit_diarize_with_transcription(
        self,
        media_url: str,
        *,
        model: str = "precision-2",
        transcription_model: str | None = None,
        language: str | None = None,
        num_speakers: int | None = None,
    ) -> str:
        payload: dict[str, Any] = {
            "url": media_url,
            "model": model,
            "transcription": True,
        }
        # Optional known-speaker-count hint (IN-86); improves separation on hard
        # audio. Only sent when explicitly configured.
        if isinstance(num_speakers, int) and num_speakers > 0:
            payload["numSpeakers"] = num_speakers
        transcription_config: dict[str, Any] = {}
        if transcription_model:
            transcription_config["model"] = transcription_model
        if language:
            transcription_config["language"] = language
        if transcription_config:
            payload["transcriptionConfig"] = transcription_config

        response = self.request("POST", "/v1/diarize", payload)
        job_id = response.get("jobId") or response.get("id")
        if not isinstance(job_id, str) or not job_id:
            raise PyannoteAIError("pyannoteAI diarize did not return a job id")
        return job_id

    def submit_voiceprint(self, media_url: str, *, model: str = "precision-2") -> str:
        response = self.request("POST", "/v1/voiceprint", {"url": media_url, "model": model})
        job_id = response.get("jobId") or response.get("id")
        if not isinstance(job_id, str) or not job_id:
            raise PyannoteAIError("pyannoteAI voiceprint did not return a job id")
        return job_id

    def submit_identify(
        self,
        media_url: str,
        voiceprints: list[dict[str, str]],
        *,
        model: str = "precision-2",
        matching_threshold: float = 62,
        exclusive_matching: bool = False,
        num_speakers: int | None = None,
    ) -> str:
        if not voiceprints:
            raise PyannoteAIError("Cannot identify speakers without voiceprints")
        payload: dict[str, Any] = {
            "url": media_url,
            "model": model,
            "voiceprints": voiceprints,
            "exclusive": True,
            "confidence": True,
            "matching": {
                "threshold": matching_threshold,
                "exclusive": exclusive_matching,
            },
        }
        if num_speakers is not None and num_speakers > 0:
            payload["numSpeakers"] = num_speakers
        response = self.request("POST", "/v1/identify", payload)
        job_id = response.get("jobId") or response.get("id")
        if not isinstance(job_id, str) or not job_id:
            raise PyannoteAIError("pyannoteAI identify did not return a job id")
        return job_id

    def identify_audio(
        self,
        audio_path: Path,
        voiceprints: list[dict[str, str]],
        *,
        media_prefix: str,
        model: str = "precision-2",
        matching_threshold: float = 62,
        exclusive_matching: bool = False,
        num_speakers: int | None = None,
        poll: PyannotePollConfig | None = None,
    ) -> dict[str, Any]:
        media_url = self.upload_media_file(audio_path, media_prefix)
        job_id = self.submit_identify(
            media_url,
            voiceprints,
            model=model,
            matching_threshold=matching_threshold,
            exclusive_matching=exclusive_matching,
            num_speakers=num_speakers,
        )
        result = self.wait_for_job(job_id, poll or PyannotePollConfig())
        status = str(result.get("status") or "").lower()
        if status != "succeeded":
            raise PyannoteAIError(f"pyannoteAI identify job ended with status {status}")
        return result

    def extract_voiceprint_from_audio(
        self,
        audio: bytes,
        *,
        media_prefix: str,
        model: str = "precision-2",
        suffix: str = ".webm",
        content_type: str = "application/octet-stream",
        poll: PyannotePollConfig | None = None,
    ) -> str:
        media_url = self.upload_media_bytes(
            audio,
            media_prefix,
            suffix=suffix,
            content_type=content_type,
        )
        job_id = self.submit_voiceprint(media_url, model=model)
        result = self.wait_for_job(job_id, poll or PyannotePollConfig())
        status = str(result.get("status") or "").lower()
        if status != "succeeded":
            raise PyannoteAIError(f"pyannoteAI voiceprint job ended with status {status}")
        output = result.get("output") if isinstance(result.get("output"), dict) else result
        voiceprint = output.get("voiceprint") if isinstance(output, dict) else None
        if not isinstance(voiceprint, str) or not voiceprint:
            raise PyannoteAIError("pyannoteAI voiceprint job returned no voiceprint")
        return voiceprint

    def get_job(self, job_id: str) -> dict[str, Any]:
        return self.request("GET", f"/v1/jobs/{job_id}")

    def wait_for_job(self, job_id: str, poll: PyannotePollConfig) -> dict[str, Any]:
        deadline = time.time() + poll.timeout_seconds
        while True:
            result = self.get_job(job_id)
            status = str(result.get("status") or "").lower()
            if status in TERMINAL_STATUSES:
                return result
            if time.time() >= deadline:
                raise PyannoteAIError(f"Timed out waiting for pyannoteAI job {job_id}")
            time.sleep(poll.interval_seconds)
