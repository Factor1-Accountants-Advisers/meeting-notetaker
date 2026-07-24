"""IN-471 Storage API client seam (IN-379 first consumer).

RestStorageApiClient talks to the authenticated Azure Functions Storage API
when MN_STORAGE_API_URL is configured and the cutover is enabled.
StubStorageApiClient activates when the URL is empty or the operational
rollback switch is off — file-backed so dev exercises the full flow.
Central-store audit events are written server-side by the Function (brief §5,
IN-381): the stub deliberately writes none. Stub data never migrates to the
real store.

Never log tokens or voiceprint values.
"""

import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Literal, Protocol
from uuid import UUID

import pydantic
from pydantic import BaseModel, Field

from app.config import get_settings
from app.paths import central_voiceprint_path


class StorageApiError(RuntimeError):
    """Central registration/lookup failed; caller maps to a retryable 502."""


class StorageApiUnavailable(StorageApiError):
    """Transient token, network, auth-service, or Storage API availability failure."""


class StorageApiRejected(StorageApiError):
    """The Storage API rejected a valid request; local fallback is forbidden."""


class StorageApiContractError(StorageApiError):
    """The Storage API response violated the published contract."""


class CentralEnrolment(BaseModel):
    person_id: str  # Entra object id (oid); email remains the local registry key
    email: str | None = None
    display_name: str
    voiceprints: list[str]
    sample_sources: list[Literal["recorded", "uploaded"]]
    status: Literal["active", "disabled", "deleted"] = "active"
    model_version: str | None = None
    consent_recorded_at: datetime
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


CandidateSource = Literal[
    "invitee",
    "organizer",
    "recorder",
    "controlled_expansion",
]


class MeetingVoiceprintCandidate(BaseModel):
    email: str
    source: CandidateSource

    @pydantic.field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        normalized = value.strip().casefold()
        if not normalized:
            raise ValueError("email must not be empty")
        return normalized


class MeetingVoiceprintRequest(BaseModel):
    meeting_id: UUID
    candidates: list[MeetingVoiceprintCandidate] = Field(
        min_length=1,
        max_length=50,
    )


class MeetingVoiceprintResponse(BaseModel):
    meeting_id: UUID
    records: list[CentralEnrolment]
    missing: list[MeetingVoiceprintCandidate]


class StorageApiClient(Protocol):
    def register_voiceprint(self, enrolment: CentralEnrolment, access_token: str | None) -> CentralEnrolment: ...
    def get_enrolment(self, person_id: str, access_token: str | None) -> CentralEnrolment | None: ...
    def get_meeting_voiceprints(
        self,
        meeting_id: UUID,
        candidates: list[MeetingVoiceprintCandidate],
        access_token: str | None,
    ) -> MeetingVoiceprintResponse: ...


def central_enrolment_required() -> bool:
    settings = get_settings()
    return settings.storage_api_enabled and bool(settings.storage_api_url)


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

    def get_meeting_voiceprints(
        self,
        meeting_id: UUID,
        candidates: list[MeetingVoiceprintCandidate],
        access_token: str | None,
    ) -> MeetingVoiceprintResponse:
        if self.fail_next:
            self.fail_next = False
            raise StorageApiError("injected stub failure")
        request = MeetingVoiceprintRequest(
            meeting_id=meeting_id,
            candidates=candidates,
        )
        indexed: dict[str, CentralEnrolment] = {}
        for raw in self._load().values():
            try:
                record = CentralEnrolment.model_validate(raw)
            except pydantic.ValidationError:
                continue
            if record.status == "active" and record.email:
                indexed[record.email.strip().casefold()] = record

        records: list[CentralEnrolment] = []
        missing: list[MeetingVoiceprintCandidate] = []
        seen: set[str] = set()
        for candidate in request.candidates:
            if candidate.email in seen:
                continue
            seen.add(candidate.email)
            record = indexed.get(candidate.email)
            if record is None:
                missing.append(candidate)
            else:
                records.append(record)
        return MeetingVoiceprintResponse(
            meeting_id=request.meeting_id,
            records=records,
            missing=missing,
        )


class RestStorageApiClient:
    """Provisional REST binding for IN-471 (contract not yet published)."""

    def __init__(self, base_url: str, opener=urllib.request.urlopen) -> None:
        self._base = base_url.rstrip("/")
        self._opener = opener

    def _request(
        self,
        method: str,
        path: str,
        access_token: str | None,
        payload: dict | None = None,
        *,
        allow_not_found: bool = False,
    ):
        if not access_token:
            raise StorageApiUnavailable(
                "sign in required for central enrolment — no user token was available"
            )
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
        except urllib.error.HTTPError as exc:
            if exc.code == 404 and allow_not_found:
                return None
            if exc.code >= 500:
                raise StorageApiUnavailable(
                    f"storage API returned {exc.code}"
                ) from exc
            raise StorageApiRejected(f"storage API returned {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise StorageApiUnavailable(f"storage API unreachable: {exc}") from exc
        if not text:
            return None
        try:
            return json.loads(text)
        except ValueError as exc:
            raise StorageApiContractError(
                "storage API returned malformed JSON"
            ) from exc

    def register_voiceprint(self, enrolment: CentralEnrolment, access_token: str | None) -> CentralEnrolment:
        raw = self._request("PUT", f"/api/v1/voiceprints/{urllib.parse.quote(enrolment.person_id)}", access_token, enrolment.model_dump(mode="json"))
        if not raw:
            return enrolment
        try:
            return CentralEnrolment.model_validate(raw)
        except pydantic.ValidationError as exc:
            raise StorageApiContractError("storage API returned a malformed record: registration response failed validation") from exc

    def get_enrolment(self, person_id: str, access_token: str | None) -> CentralEnrolment | None:
        raw = self._request(
            "GET",
            f"/api/v1/voiceprints/{urllib.parse.quote(person_id)}",
            access_token,
            allow_not_found=True,
        )
        if raw is None:
            return None
        try:
            return CentralEnrolment.model_validate(raw)
        except pydantic.ValidationError as exc:
            raise StorageApiContractError("storage API returned a malformed record: enrolment lookup response failed validation") from exc

    def get_meeting_voiceprints(
        self,
        meeting_id: UUID,
        candidates: list[MeetingVoiceprintCandidate],
        access_token: str | None,
    ) -> MeetingVoiceprintResponse:
        request = MeetingVoiceprintRequest(
            meeting_id=meeting_id,
            candidates=candidates,
        )
        raw = self._request(
            "POST",
            "/api/v1/voiceprints/meeting-candidates",
            access_token,
            request.model_dump(mode="json"),
        )
        try:
            response = MeetingVoiceprintResponse.model_validate(raw)
        except pydantic.ValidationError as exc:
            raise StorageApiContractError(
                "storage API returned a malformed record: meeting lookup response failed validation"
            ) from exc
        if response.meeting_id != request.meeting_id:
            raise StorageApiContractError(
                "storage API returned a malformed record: meeting id did not match request"
            )
        return response


_STUB = StubStorageApiClient()


def reset_stub_for_tests() -> None:
    _STUB.fail_next = False
    central_voiceprint_path().unlink(missing_ok=True)


def get_storage_api_client() -> StorageApiClient:
    settings = get_settings()
    if settings.storage_api_enabled and settings.storage_api_url:
        return RestStorageApiClient(settings.storage_api_url)
    return _STUB
