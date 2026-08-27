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
import os
import shutil
import tempfile
import threading
import uuid
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Literal, Protocol
from uuid import UUID, uuid4

import pydantic
from pydantic import BaseModel, Field

from app.config import get_settings
from app.paths import central_meetings_dir, central_voiceprint_path
from app.schemas import CallSignalsResponse, CallWatchReceipt, CallWatchRegistration


class StorageApiError(RuntimeError):
    """Central registration/lookup failed; caller maps to a retryable 502."""


class StorageApiUnavailable(StorageApiError):
    """Transient token, network, auth-service, or Storage API availability failure."""


class StorageApiRejected(StorageApiError):
    """The Storage API rejected a valid request; local fallback is forbidden."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


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
    disabled_at: datetime | None = None
    deleted_at: datetime | None = None


class VoiceprintAdminRecord(BaseModel):
    person_id: str
    email: str | None = None
    display_name: str
    status: Literal["active", "disabled", "deleted"]
    sample_sources: list[Literal["recorded", "uploaded"]]
    consent_recorded_at: datetime
    created_at: datetime | None = None
    updated_at: datetime | None = None
    disabled_at: datetime | None = None
    deleted_at: datetime | None = None
    last_used_at: datetime | None = None
    voiceprint_count: int


class VoiceprintAdminListResponse(BaseModel):
    items: list[VoiceprintAdminRecord]


class DirectoryEntry(BaseModel):
    """Minimal-disclosure directory row (contract §5 staff directory,
    5 Aug 2026): active enrolments as email + display name only, for the
    attendee-suggestions dropdown."""

    email: str
    display_name: str


class VoiceprintDirectoryResponse(BaseModel):
    items: list[DirectoryEntry]


class VoiceprintAdminActionResponse(BaseModel):
    record: VoiceprintAdminRecord
    audit_event_id: str


class VoiceprintAuditEvent(BaseModel):
    schema_version: Literal[1]
    event_id: str
    occurred_at: datetime
    actor_oid: str
    actor_name: str
    action: str
    target: str
    correlation_id: str
    details: dict


class VoiceprintAuditEventPage(BaseModel):
    items: list[VoiceprintAuditEvent]
    next_cursor: str | None = None


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


# Per-request security bound in the ratified Storage API v1 contract. Larger
# meetings are covered by paginating lookups in batches of this size (IN-486).
MEETING_CANDIDATE_BATCH_LIMIT = 50


class MeetingVoiceprintRequest(BaseModel):
    meeting_id: UUID
    candidates: list[MeetingVoiceprintCandidate] = Field(
        min_length=1,
        max_length=MEETING_CANDIDATE_BATCH_LIMIT,
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
    upload_url: str = Field(repr=False)
    blob_path: str
    expires_at: datetime


_MEETING_LOCKS_GUARD = threading.Lock()
_MEETING_LOCKS: dict[UUID, threading.Lock] = {}


def _meeting_lock(meeting_id: UUID) -> threading.Lock:
    with _MEETING_LOCKS_GUARD:
        return _MEETING_LOCKS.setdefault(meeting_id, threading.Lock())


class StorageApiClient(Protocol):
    def register_voiceprint(self, enrolment: CentralEnrolment, access_token: str | None) -> CentralEnrolment: ...
    def get_enrolment(self, person_id: str, access_token: str | None) -> CentralEnrolment | None: ...
    def list_directory(self, access_token: str | None) -> list[DirectoryEntry]: ...
    def list_voiceprints(self, access_token: str | None) -> VoiceprintAdminListResponse: ...
    def disable_voiceprint(self, person_id: str, access_token: str | None) -> VoiceprintAdminActionResponse: ...
    def enable_voiceprint(self, person_id: str, access_token: str | None) -> VoiceprintAdminActionResponse: ...
    def delete_voiceprint(self, person_id: str, access_token: str | None) -> VoiceprintAdminActionResponse: ...
    def get_voiceprint_audit_events(
        self,
        from_date: date,
        to_date: date,
        access_token: str | None,
        limit: int = 100,
    ) -> VoiceprintAuditEventPage: ...
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
    def register_call_watch(
        self, registration: CallWatchRegistration, access_token: str | None
    ) -> CallWatchReceipt: ...
    def get_call_signals(self, join_url_hash: str, access_token: str | None) -> CallSignalsResponse: ...
    def delete_call_watch(self, join_url_hash: str, access_token: str | None) -> None: ...


def central_enrolment_required() -> bool:
    settings = get_settings()
    return settings.storage_api_enabled and bool(settings.storage_api_url)


class StubStorageApiClient:
    def __init__(self) -> None:
        self.fail_next = False
        self._admin_audit_events: list[VoiceprintAuditEvent] = []

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
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
        )
        os.close(descriptor)
        temporary = Path(temporary_name)
        try:
            temporary.write_text(json.dumps(value), encoding="utf-8")
            temporary.replace(path)
        except (OSError, TypeError, ValueError):
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            raise

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

    def list_directory(self, access_token: str | None) -> list[DirectoryEntry]:
        entries = []
        for raw in self._load().values():
            try:
                record = CentralEnrolment.model_validate(raw)
            except pydantic.ValidationError:
                continue
            if record.status != "active" or not record.email:
                continue
            entries.append(
                DirectoryEntry(email=record.email.lower(), display_name=record.display_name)
            )
        entries.sort(key=lambda entry: (entry.display_name.casefold(), entry.email))
        return entries

    @staticmethod
    def _admin_record(record: CentralEnrolment) -> VoiceprintAdminRecord:
        return VoiceprintAdminRecord(
            person_id=record.person_id,
            email=record.email,
            display_name=record.display_name,
            status=record.status,
            sample_sources=record.sample_sources,
            consent_recorded_at=record.consent_recorded_at,
            created_at=record.created_at,
            updated_at=record.updated_at,
            disabled_at=record.disabled_at,
            deleted_at=record.deleted_at,
            voiceprint_count=len(record.voiceprints),
        )

    def list_voiceprints(self, access_token: str | None) -> VoiceprintAdminListResponse:
        records = [
            self._admin_record(CentralEnrolment.model_validate(raw))
            for raw in self._load().values()
        ]
        records.sort(key=lambda record: (record.display_name.casefold(), record.person_id))
        return VoiceprintAdminListResponse(items=records)

    def _set_voiceprint_status(
        self,
        person_id: str,
        status: Literal["active", "disabled", "deleted"],
    ) -> VoiceprintAdminActionResponse:
        self._fail_if_injected(self)
        data = self._load()
        raw = data.get(person_id)
        if raw is None:
            raise StorageApiRejected("storage API returned 404", 404)
        record = CentralEnrolment.model_validate(raw)
        if record.status == "deleted":
            raise StorageApiRejected("storage API returned 409", 409)
        if status == "active" and record.status != "disabled":
            raise StorageApiRejected("storage API returned 409", 409)
        now = datetime.now(timezone.utc)
        record = record.model_copy(
            update={
                "status": status,
                "updated_at": now,
                "disabled_at": (
                    record.disabled_at or now
                    if status == "disabled"
                    else None
                    if status == "active"
                    else record.disabled_at
                ),
                "deleted_at": now if status == "deleted" else record.deleted_at,
                "voiceprints": [] if status == "deleted" else record.voiceprints,
            }
        )
        data[person_id] = record.model_dump(mode="json")
        self._save(data)
        action = {
            "active": "voiceprint_enabled",
            "disabled": "voiceprint_disabled",
            "deleted": "voiceprint_deleted",
        }[status]
        event = VoiceprintAuditEvent(
            schema_version=1,
            event_id=str(uuid4()),
            occurred_at=now,
            actor_oid="stub-admin",
            actor_name="Stub administrator",
            action=action,
            target=person_id,
            correlation_id=str(uuid4()),
            details={"status": status},
        )
        self._admin_audit_events.append(event)
        return VoiceprintAdminActionResponse(
            record=self._admin_record(record),
            audit_event_id=event.event_id,
        )

    def disable_voiceprint(
        self, person_id: str, access_token: str | None
    ) -> VoiceprintAdminActionResponse:
        return self._set_voiceprint_status(person_id, "disabled")

    def enable_voiceprint(
        self, person_id: str, access_token: str | None
    ) -> VoiceprintAdminActionResponse:
        return self._set_voiceprint_status(person_id, "active")

    def delete_voiceprint(
        self, person_id: str, access_token: str | None
    ) -> VoiceprintAdminActionResponse:
        return self._set_voiceprint_status(person_id, "deleted")

    def get_voiceprint_audit_events(
        self,
        from_date: date,
        to_date: date,
        access_token: str | None,
        limit: int = 100,
    ) -> VoiceprintAuditEventPage:
        events = [
            event
            for event in reversed(self._admin_audit_events)
            if from_date <= event.occurred_at.date() <= to_date
        ][:limit]
        return VoiceprintAuditEventPage(items=events)

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
        with _meeting_lock(meeting_id):
            meeting_dir = central_meetings_dir() / str(meeting_id)
            current = meeting_dir / "meeting.json"
            now = datetime.now(timezone.utc)
            revision: Literal["created", "updated"] = "created"
            try:
                if current.exists():
                    revision = "updated"
                    # Timestamp alone collides when two exports land in the
                    # same coarse Windows clock tick (the long-flaky
                    # test_stub_serializes_concurrent_exports_for_one_meeting
                    # was this: same-name history files overwriting each
                    # other). A random suffix makes every revision distinct.
                    history_name = (
                        now.strftime("%Y%m%dT%H%M%S%f") + f"-{uuid.uuid4().hex[:8]}Z.json"
                    )
                    history = meeting_dir / "history" / history_name
                    history.parent.mkdir(parents=True, exist_ok=True)
                    descriptor, temporary_name = tempfile.mkstemp(
                        prefix=f".{history.name}.", suffix=".tmp", dir=history.parent
                    )
                    os.close(descriptor)
                    temporary = Path(temporary_name)
                    try:
                        shutil.copyfile(current, temporary)
                        temporary.replace(history)
                    except OSError:
                        try:
                            temporary.unlink(missing_ok=True)
                        except OSError:
                            pass
                        raise
                self._write_json(current, export_payload)
            except (OSError, TypeError, ValueError) as exc:
                raise StorageApiUnavailable("stub meeting export could not be written") from exc
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
        try:
            parsed = urllib.parse.urlsplit(grant.upload_url)
        except ValueError:
            raise StorageApiContractError("stub audio upload grant was invalid") from None
        if parsed.scheme != "stub" or parsed.netloc != "meeting-upload":
            raise StorageApiContractError("stub audio upload grant was invalid")
        try:
            meeting_id = UUID(parsed.path.lstrip("/"))
        except ValueError:
            raise StorageApiContractError("stub audio upload grant was invalid") from None
        destination = central_meetings_dir() / str(meeting_id) / "audio.webm"
        with _meeting_lock(meeting_id):
            try:
                destination.parent.mkdir(parents=True, exist_ok=True)
                descriptor, temporary_name = tempfile.mkstemp(
                    prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent
                )
                os.close(descriptor)
                temporary = Path(temporary_name)
                try:
                    with audio_path.open("rb") as source, temporary.open("wb") as target:
                        shutil.copyfileobj(source, target, length=1024 * 1024)
                    temporary.replace(destination)
                except OSError:
                    try:
                        temporary.unlink(missing_ok=True)
                    except OSError:
                        pass
                    raise
            except OSError as exc:
                raise StorageApiUnavailable("stub audio upload could not read the recording") from exc

    def register_call_watch(
        self, registration: CallWatchRegistration, access_token: str | None
    ) -> CallWatchReceipt:
        # Ships dark (spec D7/D8): with no central storage configured this
        # feature is silently inert, so no dev/stub artifact is written.
        self._fail_if_injected(self)
        return CallWatchReceipt(
            watch_id="stub-watch",
            subscription_expires_utc="2099-12-31T23:59:59.0000000Z",
        )

    def get_call_signals(self, join_url_hash: str, access_token: str | None) -> CallSignalsResponse:
        return CallSignalsResponse(signals=[])

    def delete_call_watch(self, join_url_hash: str, access_token: str | None) -> None:
        self._fail_if_injected(self)
        return None


class RestStorageApiClient:
    """REST binding for the ratified Storage API v1 contract."""

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
        timeout_s: int = 30,
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
            with self._opener(req, timeout=timeout_s) as res:
                text = res.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            if exc.code == 404 and allow_not_found:
                return None
            if exc.code >= 500:
                raise StorageApiUnavailable(
                    f"storage API returned {exc.code}"
                ) from exc
            raise StorageApiRejected(
                f"storage API returned {exc.code}", exc.code
            ) from exc
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

    def list_directory(self, access_token: str | None) -> list[DirectoryEntry]:
        # allow_not_found: an old deployed server without the endpoint must
        # read as "temporarily can't consult" (callers degrade to the local
        # list), not a rejection. timeout_s=5: the main-process proxy aborts
        # GETs at 15s, so a hung central API must never take the whole
        # /people response — and the LOCAL list with it — down.
        raw = self._request(
            "GET",
            "/api/v1/voiceprints/directory",
            access_token,
            allow_not_found=True,
            timeout_s=5,
        )
        if raw is None:
            raise StorageApiUnavailable("directory endpoint not deployed")
        try:
            return VoiceprintDirectoryResponse.model_validate(raw).items
        except pydantic.ValidationError as exc:
            raise StorageApiContractError(
                "storage API returned a malformed voiceprint directory"
            ) from exc

    def list_voiceprints(
        self, access_token: str | None
    ) -> VoiceprintAdminListResponse:
        raw = self._request("GET", "/api/v1/voiceprints", access_token)
        try:
            return VoiceprintAdminListResponse.model_validate(raw)
        except pydantic.ValidationError as exc:
            raise StorageApiContractError(
                "storage API returned a malformed voiceprint admin list"
            ) from exc

    def _voiceprint_admin_action(
        self,
        method: Literal["POST", "DELETE"],
        person_id: str,
        suffix: str,
        access_token: str | None,
    ) -> VoiceprintAdminActionResponse:
        path = f"/api/v1/voiceprints/{urllib.parse.quote(person_id, safe='')}{suffix}"
        raw = self._request(method, path, access_token)
        try:
            return VoiceprintAdminActionResponse.model_validate(raw)
        except pydantic.ValidationError as exc:
            raise StorageApiContractError(
                "storage API returned a malformed voiceprint admin action"
            ) from exc

    def disable_voiceprint(
        self, person_id: str, access_token: str | None
    ) -> VoiceprintAdminActionResponse:
        return self._voiceprint_admin_action(
            "POST", person_id, "/disable", access_token
        )

    def enable_voiceprint(
        self, person_id: str, access_token: str | None
    ) -> VoiceprintAdminActionResponse:
        return self._voiceprint_admin_action(
            "POST", person_id, "/enable", access_token
        )

    def delete_voiceprint(
        self, person_id: str, access_token: str | None
    ) -> VoiceprintAdminActionResponse:
        return self._voiceprint_admin_action(
            "DELETE", person_id, "", access_token
        )

    def get_voiceprint_audit_events(
        self,
        from_date: date,
        to_date: date,
        access_token: str | None,
        limit: int = 100,
    ) -> VoiceprintAuditEventPage:
        query = urllib.parse.urlencode(
            {
                "from_date": from_date.isoformat(),
                "to_date": to_date.isoformat(),
                "limit": limit,
            }
        )
        raw = self._request(
            "GET", f"/api/v1/voiceprints/audit-events?{query}", access_token
        )
        try:
            return VoiceprintAuditEventPage.model_validate(raw)
        except pydantic.ValidationError as exc:
            raise StorageApiContractError(
                "storage API returned malformed voiceprint audit events"
            ) from exc

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
            # A 50-candidate batch makes the server do per-candidate blob
            # reads plus per-record usage stamping before it can answer; the
            # default 30s proved too tight on firmwide meetings (26 Aug).
            timeout_s=120,
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
        except (pydantic.ValidationError, ValueError):
            raise StorageApiContractError(
                "storage API returned a malformed audio upload grant"
            ) from None
        return grant

    @staticmethod
    def _blob_upload_target(upload_url: str) -> tuple[str, int | None, str]:
        """Return a safe Azure Blob endpoint without exposing a SAS in errors."""
        try:
            parsed = urllib.parse.urlsplit(upload_url)
            hostname = parsed.hostname
            port = parsed.port
        except ValueError:
            raise StorageApiContractError("audio upload grant target was invalid") from None
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
            response.read(64 * 1024)
            if not 200 <= response.status < 300:
                if response.status >= 500:
                    raise StorageApiUnavailable("blob storage was unavailable for audio upload")
                raise StorageApiRejected("blob storage rejected the audio upload")
        except (StorageApiRejected, StorageApiUnavailable):
            raise
        except (http.client.InvalidURL, ValueError):
            raise StorageApiContractError("audio upload grant target was invalid") from None
        except http.client.HTTPException:
            raise StorageApiUnavailable("audio upload was unavailable") from None
        except OSError as exc:
            raise StorageApiUnavailable("audio upload was unavailable") from exc
        finally:
            if connection is not None:
                try:
                    connection.close()
                except (OSError, http.client.HTTPException):
                    pass

    def register_call_watch(
        self, registration: CallWatchRegistration, access_token: str | None
    ) -> CallWatchReceipt:
        raw = self._request(
            "POST",
            "/api/v1/call-watches",
            access_token,
            registration.model_dump(mode="json"),
        )
        try:
            return CallWatchReceipt.model_validate(raw)
        except pydantic.ValidationError as exc:
            raise StorageApiContractError(
                "storage API returned a malformed call watch receipt"
            ) from exc

    def get_call_signals(self, join_url_hash: str, access_token: str | None) -> CallSignalsResponse:
        raw = self._request(
            "GET", f"/api/v1/call-watches/{join_url_hash}/signals", access_token
        )
        try:
            return CallSignalsResponse.model_validate(raw)
        except pydantic.ValidationError as exc:
            raise StorageApiContractError(
                "storage API returned malformed call signals"
            ) from exc

    def delete_call_watch(self, join_url_hash: str, access_token: str | None) -> None:
        # 404 is tolerated as success — delete is idempotent (contract §9.4:
        # "always 204, whether or not a watch existed").
        self._request(
            "DELETE",
            f"/api/v1/call-watches/{join_url_hash}",
            access_token,
            allow_not_found=True,
        )
        return None


_STUB = StubStorageApiClient()


def reset_stub_for_tests() -> None:
    _STUB.fail_next = False
    _STUB._admin_audit_events.clear()
    central_voiceprint_path().unlink(missing_ok=True)
    meetings = central_meetings_dir()
    if meetings.exists():
        shutil.rmtree(meetings)


def get_storage_api_client() -> StorageApiClient:
    settings = get_settings()
    if settings.storage_api_enabled and settings.storage_api_url:
        return RestStorageApiClient(settings.storage_api_url)
    return _STUB
