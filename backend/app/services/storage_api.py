"""IN-471 Storage API client seam (IN-379 first consumer).

RestStorageApiClient talks to the authenticated Azure Functions Storage API
when MN_STORAGE_API_URL is configured; endpoint paths are provisional until
the IN-471 REST contract is published. StubStorageApiClient activates when
the URL is empty — file-backed so dev exercises the full flow. Central-store
audit events are written server-side by the Function (brief §5, IN-381): the
stub deliberately writes none. Stub data never migrates to the real store.

Never log tokens or voiceprint values.
"""

import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Literal, Protocol

from pydantic import BaseModel, Field

from app.config import get_settings
from app.paths import central_voiceprint_path


class StorageApiError(RuntimeError):
    """Central registration/lookup failed; caller maps to a retryable 502."""


class CentralEnrolment(BaseModel):
    person_id: str  # email today; Entra object id once IN-471 validates tokens
    display_name: str
    voiceprints: list[str]
    sample_sources: list[Literal["recorded", "uploaded"]]
    status: Literal["active", "disabled", "deleted"] = "active"
    model_version: str | None = None
    consent_recorded_at: datetime
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class StorageApiClient(Protocol):
    def register_voiceprint(self, enrolment: CentralEnrolment, access_token: str | None) -> CentralEnrolment: ...
    def get_enrolment(self, person_id: str, access_token: str | None) -> CentralEnrolment | None: ...


def central_enrolment_required() -> bool:
    return bool(get_settings().storage_api_url)


class StubStorageApiClient:
    def __init__(self) -> None:
        self.fail_next = False

    def _load(self) -> dict:
        path = central_voiceprint_path()
        if not path.exists():
            return {}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _save(self, data: dict) -> None:
        path = central_voiceprint_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data), encoding="utf-8")
        tmp.replace(path)

    def register_voiceprint(self, enrolment: CentralEnrolment, access_token: str | None) -> CentralEnrolment:
        if self.fail_next:
            self.fail_next = False
            raise StorageApiError("injected stub failure")
        data = self._load()
        existing = data.get(enrolment.person_id)
        record = enrolment.model_copy(update={"updated_at": datetime.now(timezone.utc)})
        if existing is not None:
            record = record.model_copy(update={"created_at": CentralEnrolment.model_validate(existing).created_at})
        data[enrolment.person_id] = record.model_dump(mode="json")
        self._save(data)
        return record

    def get_enrolment(self, person_id: str, access_token: str | None) -> CentralEnrolment | None:
        raw = self._load().get(person_id)
        return CentralEnrolment.model_validate(raw) if raw is not None else None


class RestStorageApiClient:
    """Provisional REST binding for IN-471 (contract not yet published)."""

    def __init__(self, base_url: str, opener=urllib.request.urlopen) -> None:
        self._base = base_url.rstrip("/")
        self._opener = opener

    def _request(self, method: str, path: str, access_token: str | None, payload: dict | None = None):
        if not access_token:
            raise StorageApiError("central enrolment requires a signed-in user token")
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(
            f"{self._base}{path}",
            data=body,
            method=method,
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with self._opener(req, timeout=30) as res:
                text = res.read().decode("utf-8")
                return json.loads(text) if text else None
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            raise StorageApiError(f"storage API returned {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            raise StorageApiError(f"storage API unreachable: {exc}") from exc

    def register_voiceprint(self, enrolment: CentralEnrolment, access_token: str | None) -> CentralEnrolment:
        raw = self._request("PUT", f"/api/v1/voiceprints/{urllib.parse.quote(enrolment.person_id)}", access_token, enrolment.model_dump(mode="json"))
        return CentralEnrolment.model_validate(raw) if raw else enrolment

    def get_enrolment(self, person_id: str, access_token: str | None) -> CentralEnrolment | None:
        raw = self._request("GET", f"/api/v1/voiceprints/{urllib.parse.quote(person_id)}", access_token)
        return CentralEnrolment.model_validate(raw) if raw is not None else None


_STUB = StubStorageApiClient()


def reset_stub_for_tests() -> None:
    _STUB.fail_next = False
    central_voiceprint_path().unlink(missing_ok=True)


def get_storage_api_client() -> StorageApiClient:
    settings = get_settings()
    if settings.storage_api_url:
        return RestStorageApiClient(settings.storage_api_url)
    return _STUB
