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

import http.client
import json
import shutil
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Protocol
from uuid import UUID

import pydantic
from pydantic import BaseModel, Field

from app.config import get_settings
from app.paths import central_meetings_dir, central_voiceprint_path


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


class BlobExportReceipt(BaseModel):
    meeting_id: UUID
    blob_path: str
    revision: Literal["created", "updated"]
    updated_at: datetime


class AudioUploadGrant(BaseModel):
    upload_url: str
    blob_path: str
    expires_at: datetime


class StorageApiClient(Protocol):
    def register_voiceprint(self, enrolment: CentralEnrolment, access_token: str | None) -> CentralEnrolment: ...
    def get_enrolment(self, person_id: str, access_token: str | None) -> CentralEnrolment | None: ...
    def get_meeting_voiceprints(
        self,
        meeting_id: UUID,
        candidates: list[MeetingVoiceprintCandidate],
        access_token: str | None,
    ) -> MeetingVoiceprintResponse: ...
    def upload_meeting_export(
        self,
        meeting_id: UUID,
        time_basis_utc: datetime,
        export_payload: dict,
        access_token: str | None,
    ) -> BlobExportReceipt: ...
    def request_audio_upload_sas(
        self,
        meeting_id: UUID,
        time_basis_utc: datetime,
        access_token: str | None,
    ) -> AudioUploadGrant: ...
    def upload_audio_to_grant(self, grant: AudioUploadGrant, audio_path: Path) -> None: ...


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

    @staticmethod
    def _fail_if_injected(client: "StubStorageApiClient") -> None:
        if client.fail_next:
            client.fail_next = False
            raise StorageApiError("injected stub failure")

    @staticmethod
    def _write_json(path: Path, value: dict) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(value), encoding="utf-8")
        tmp.replace(path)

    def register_voiceprint(self, enrolment: CentralEnrolment, access_token: str | None) -> CentralEnrolment:
        self._fail_if_injected(self)
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
        self._fail_if_injected(self)
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

    def upload_meeting_export(
        self,
        meeting_id: UUID,
        time_basis_utc: datetime,
        export_payload: dict,
        access_token: str | None,
    ) -> BlobExportReceipt:
        self._fail_if_injected(self)
        meeting_dir = central_meetings_dir() / str(meeting_id)
        current = meeting_dir / "meeting.json"
        now = datetime.now(timezone.utc)
        revision: Literal["created", "updated"] = "created"
        if current.exists():
            revision = "updated"
            history_name = now.strftime("%Y%m%dT%H%M%S%fZ") + ".json"
            history = meeting_dir / "history" / history_name
            history.parent.mkdir(parents=True, exist_ok=True)
            tmp_history = history.with_suffix(".tmp")
            shutil.copyfile(current, tmp_history)
            tmp_history.replace(history)
        self._write_json(current, export_payload)
        return BlobExportReceipt(
            meeting_id=meeting_id,
            blob_path=f"central-meetings/{meeting_id}/meeting.json",
            revision=revision,
            updated_at=now,
        )

    def request_audio_upload_sas(
        self,
        meeting_id: UUID,
        time_basis_utc: datetime,
        access_token: str | None,
    ) -> AudioUploadGrant:
        self._fail_if_injected(self)
        return AudioUploadGrant(
            upload_url=f"stub://meeting-upload/{meeting_id}",
            blob_path=f"central-meetings/{meeting_id}/audio.webm",
            expires_at=datetime.now(timezone.utc),
        )

    def upload_audio_to_grant(self, grant: AudioUploadGrant, audio_path: Path) -> None:
        self._fail_if_injected(self)
        parsed = urllib.parse.urlsplit(grant.upload_url)
        if parsed.scheme != "stub" or parsed.netloc != "meeting-upload":
            raise StorageApiContractError("stub audio upload grant was invalid")
        try:
            meeting_id = UUID(parsed.path.lstrip("/"))
        except ValueError as exc:
            raise StorageApiContractError("stub audio upload grant was invalid") from exc
        destination = central_meetings_dir() / str(meeting_id) / "audio.webm"
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(".tmp")
        try:
            with audio_path.open("rb") as source, temporary.open("wb") as target:
                shutil.copyfileobj(source, target, length=1024 * 1024)
            temporary.replace(destination)
        except OSError as exc:
            temporary.unlink(missing_ok=True)
            raise StorageApiUnavailable("stub audio upload could not read the recording") from exc


class RestStorageApiClient:
    """Provisional REST binding for IN-471 (contract not yet published)."""

    def __init__(
        self,
        base_url: str,
        opener=urllib.request.urlopen,
        connection_factory=http.client.HTTPSConnection,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._opener = opener
        self._connection_factory = connection_factory

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
            raise StorageApiUnavailable("storage API unreachable") from exc
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

    def upload_meeting_export(
        self,
        meeting_id: UUID,
        time_basis_utc: datetime,
        export_payload: dict,
        access_token: str | None,
    ) -> BlobExportReceipt:
        raw = self._request(
            "PUT",
            f"/api/v1/meetings/{meeting_id}/export",
            access_token,
            {
                "time_basis_utc": time_basis_utc.isoformat(),
                "export": export_payload,
            },
        )
        try:
            receipt = BlobExportReceipt.model_validate(raw)
        except pydantic.ValidationError as exc:
            raise StorageApiContractError(
                "storage API returned a malformed meeting export receipt"
            ) from exc
        if receipt.meeting_id != meeting_id:
            raise StorageApiContractError(
                "storage API returned a meeting export receipt for a different meeting"
            )
        return receipt

    def request_audio_upload_sas(
        self,
        meeting_id: UUID,
        time_basis_utc: datetime,
        access_token: str | None,
    ) -> AudioUploadGrant:
        raw = self._request(
            "POST",
            f"/api/v1/meetings/{meeting_id}/audio/upload-sas",
            access_token,
            {"time_basis_utc": time_basis_utc.isoformat()},
        )
        try:
            grant = AudioUploadGrant.model_validate(raw)
            self._blob_upload_target(grant.upload_url)
        except (pydantic.ValidationError, ValueError) as exc:
            raise StorageApiContractError(
                "storage API returned a malformed audio upload grant"
            ) from exc
        return grant

    @staticmethod
    def _blob_upload_target(upload_url: str) -> tuple[str, int | None, str]:
        """Return a safe Azure Blob endpoint without exposing a SAS in errors."""
        try:
            parsed = urllib.parse.urlsplit(upload_url)
            hostname = parsed.hostname
            port = parsed.port
        except ValueError as exc:
            raise StorageApiContractError("audio upload grant target was invalid") from exc
        if (
            parsed.scheme != "https"
            or not hostname
            or not hostname.lower().endswith(".blob.core.windows.net")
            or parsed.username is not None
            or parsed.password is not None
            or parsed.fragment
        ):
            raise StorageApiContractError("audio upload grant target was invalid")
        target = parsed.path or "/"
        if parsed.query:
            target = f"{target}?{parsed.query}"
        return hostname, port, target

    def upload_audio_to_grant(self, grant: AudioUploadGrant, audio_path: Path) -> None:
        try:
            hostname, port, target = self._blob_upload_target(grant.upload_url)
            size = audio_path.stat().st_size
        except StorageApiContractError:
            raise
        except OSError as exc:
            raise StorageApiUnavailable("audio upload recording was unavailable") from exc

        connection = None
        try:
            connection = self._connection_factory(hostname, port=port, timeout=900)
            connection.putrequest("PUT", target)
            connection.putheader("Content-Type", "audio/webm")
            connection.putheader("x-ms-blob-type", "BlockBlob")
            connection.putheader("Content-Length", str(size))
            connection.endheaders()
            with audio_path.open("rb") as audio:
                while chunk := audio.read(1024 * 1024):
                    connection.send(chunk)
            response = connection.getresponse()
            response.read()
            if not 200 <= response.status < 300:
                if response.status >= 500:
                    raise StorageApiUnavailable("blob storage was unavailable for audio upload")
                raise StorageApiRejected("blob storage rejected the audio upload")
        except (StorageApiRejected, StorageApiUnavailable):
            raise
        except (http.client.InvalidURL, ValueError) as exc:
            raise StorageApiContractError("audio upload grant target was invalid") from exc
        except OSError as exc:
            raise StorageApiUnavailable("audio upload was unavailable") from exc
        finally:
            if connection is not None:
                try:
                    connection.close()
                except OSError:
                    pass


_STUB = StubStorageApiClient()


def reset_stub_for_tests() -> None:
    _STUB.fail_next = False
    central_voiceprint_path().unlink(missing_ok=True)
    meetings = central_meetings_dir()
    if meetings.exists():
        shutil.rmtree(meetings)


def get_storage_api_client() -> StorageApiClient:
    settings = get_settings()
    if settings.storage_api_enabled and settings.storage_api_url:
        return RestStorageApiClient(settings.storage_api_url)
    return _STUB
