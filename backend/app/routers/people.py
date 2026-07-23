import asyncio
import base64
import binascii
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, status

from app import store
from app.config import get_settings
from app.schemas import CurrentUserRequest, EnrollRequest, EnrolmentStatus, PersonEnrollment
from app.services.pyannote_client import PyannoteAIClient, PyannoteAIError, PyannotePollConfig
from app.services.storage_api import (
    CentralEnrolment,
    StorageApiError,
    central_enrolment_required,
    get_storage_api_client,
)
from app.services.voiceprints import Voiceprint, get_voiceprint_repository

router = APIRouter(prefix="/people", tags=["people"])

Actor = Header("Unknown user", alias="X-MN-User")
UserEmail = Annotated[str | None, Header(alias="X-MN-User-Email")]
UserOid = Annotated[str | None, Header(alias="X-MN-User-Oid")]
StorageToken = Annotated[str | None, Header(alias="X-MN-Storage-Token")]


def _sync_people_with_voiceprint_registry() -> None:
    """Reflect the voiceprint registry in the people store.

    Packaged installs seed ``voiceprints.json`` on first launch, but the
    people store starts empty — without this sync, seeded colleagues are
    invisible in the People screen and the enrollment gate blocks users who
    already have voiceprints (observed on Jose T's install, 2026-07-07).
    """
    changed = False
    for vp in get_voiceprint_repository().get_all():
        if not vp.voiceprints:
            continue
        person = next((p for p in store.PEOPLE if p.employee_id == vp.employee_id), None)
        if person is None:
            store.PEOPLE.append(
                PersonEnrollment(
                    employee_id=vp.employee_id,
                    display_name=vp.display_name,
                    role="Factor1 staff",
                    enrolled=True,
                    model_version=vp.model_version,
                    reenrollment_required=False,
                )
            )
            store.add_audit(
                "system", "person.enrollment_synced_from_registry", vp.display_name,
                before=None, after=vp.employee_id,
            )
            changed = True
        elif not person.enrolled:
            person.enrolled = True
            person.model_version = vp.model_version
            store.add_audit(
                "system", "person.enrollment_synced_from_registry", vp.display_name,
                before="not enrolled", after="enrolled",
            )
            changed = True
    if changed:
        store.save_snapshot()


@router.get("", response_model=list[PersonEnrollment])
async def list_people() -> list[PersonEnrollment]:
    """Staff with enrollment status. Clients/externals are never listed here
    (enrollment is staff-only, requirements §4.2)."""
    _sync_people_with_voiceprint_registry()
    return store.PEOPLE


@router.post("/me", response_model=PersonEnrollment)
async def ensure_current_staff(body: CurrentUserRequest, actor: str = Actor) -> PersonEnrollment:
    """Ensure the signed-in Factor1 staff user exists before enrollment gating.

    Slice 1 requires staff voiceprint enrollment before normal app use. MSAL gives
    us the signed-in user; until the staff directory sync lands, that user record
    is created on first sign-in and then enrolled via the normal endpoint.
    """
    email = body.email.strip().lower()
    name = body.name.strip()
    if not email or "@" not in email:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Valid email is required")
    # Seeded voiceprints must satisfy the enrollment gate on first sign-in.
    _sync_people_with_voiceprint_registry()
    existing = next((p for p in store.PEOPLE if p.employee_id == email), None)
    if existing is not None:
        if existing.display_name != name:
            before = existing.display_name
            existing.display_name = name
            store.add_audit(
                actor,
                "person.profile_update",
                email,
                before=before,
                after=name,
            )
        return existing

    person = PersonEnrollment(
        employee_id=email,
        display_name=name,
        role="Factor1 staff",
        enrolled=False,
        model_version=None,
        reenrollment_required=False,
    )
    store.PEOPLE.append(person)
    store.add_audit(actor, "person.create", name, before=None, after=email)
    return person


@router.get("/me/enrolment-status", response_model=EnrolmentStatus)
async def enrolment_status(
    user_email: UserEmail = None,
    user_oid: UserOid = None,
    storage_token: StorageToken = None,
) -> EnrolmentStatus:
    """Gate source of truth (IN-379). Identity comes from the authenticated
    main process, never the renderer; a missing header fails closed."""
    required = central_enrolment_required()
    email = (user_email or "").strip().lower()
    if not email:
        return EnrolmentStatus(enrolled_locally=False, centrally_enrolled=False, central_required=required)
    _sync_people_with_voiceprint_registry()
    person = next((p for p in store.PEOPLE if p.employee_id == email), None)
    # A person flagged for re-enrolment must not pass the gate on stale local
    # enrolment. Whether a flag should also invalidate an existing central
    # record is a separate question, deliberately deferred to IN-382
    # offboarding scope.
    enrolled_locally = bool(person and person.enrolled and not person.reenrollment_required)
    centrally = False
    oid = (user_oid or "").strip()
    token = (storage_token or "").strip()
    if required and oid and token:
        try:
            record = get_storage_api_client().get_enrolment(oid, access_token=token)
            centrally = record is not None and record.status == "active"
        except StorageApiError:
            centrally = False  # unreachable store fails closed; wizard offers retry
    return EnrolmentStatus(enrolled_locally=enrolled_locally, centrally_enrolled=centrally, central_required=required)


@router.post("/{employee_id}/enroll", response_model=PersonEnrollment)
async def enroll(
    employee_id: str,
    body: EnrollRequest,
    actor: str = Actor,
    user_email: UserEmail = None,
    user_oid: UserOid = None,
    storage_token: StorageToken = None,
) -> PersonEnrollment:
    # Only /people/me lowercases at creation today; normalize here too so the
    # central person_id and local registry key stay consistently lowercase
    # and a mixed-case path param does not 404 against the lowercase-keyed
    # local registry (IN-379 review).
    employee_id = employee_id.strip().lower()
    person = next((p for p in store.PEOPLE if p.employee_id == employee_id), None)
    if person is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Employee not found")

    if not body.consent_confirmed:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Consent must be confirmed before voiceprint enrolment",
        )

    # Validate exactly three clips.
    if len(body.clips_b64) != 3:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"Exactly 3 clips required (received {len(body.clips_b64)})",
        )

    central_required = central_enrolment_required()
    person_oid = ""
    central_token = ""
    if central_required:
        signed_in_email = (user_email or "").strip().lower()
        person_oid = (user_oid or "").strip()
        central_token = (storage_token or "").strip()
        if not signed_in_email or signed_in_email != employee_id:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Signed-in user does not match enrolment target",
            )
        if not person_oid or not central_token:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "Central voiceprint registration requires a signed-in Storage API identity",
            )

    clips: list[bytes] = []
    for i, b64 in enumerate(body.clips_b64):
        try:
            audio = base64.b64decode(b64, validate=True)
        except (binascii.Error, ValueError):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, f"Clip {i + 1} is not valid base64"
            )
        if len(audio) < 1_000:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, f"Clip {i + 1} is too short"
            )
        clips.append(audio)

    previous_enrolled = person.enrolled
    previous_model_version = person.model_version

    # Create one pyannoteAI voiceprint per clip. The app records three short
    # samples so identification can later submit multiple same-person provider
    # voiceprints with distinct internal labels. Raw clips are never stored.
    settings = get_settings()
    if not settings.pyannote_api_key:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "pyannoteAI API key is not configured",
        )
    voiceprint_repo = get_voiceprint_repository()

    def create_voiceprints() -> list[str]:
        client = PyannoteAIClient(
            settings.pyannote_api_key,
            settings.pyannote_api_endpoint or "https://api.pyannote.ai",
        )
        poll = PyannotePollConfig(
            interval_seconds=settings.pyannote_poll_interval_seconds,
            timeout_seconds=settings.pyannote_poll_timeout_seconds,
        )
        values: list[str] = []
        suffix = ".webm" if "webm" in body.mime_type else ".bin"
        for i, clip in enumerate(clips):
            values.append(
                client.extract_voiceprint_from_audio(
                    clip,
                    media_prefix=f"voiceprint-samples/{employee_id}/clip-{i + 1}",
                    model=settings.pyannote_model_version or "precision-2",
                    suffix=suffix,
                    content_type=body.mime_type,
                    poll=poll,
                )
            )
        return values

    try:
        provider_voiceprints = await asyncio.to_thread(create_voiceprints)
    except PyannoteAIError as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            f"pyannoteAI voiceprint extraction failed: {exc}",
        ) from exc

    # Delete source audio references immediately after pyannoteAI extraction.
    del clips

    # Store only provider voiceprint payloads, never raw clips.
    voiceprint = Voiceprint(
        employee_id=employee_id,
        display_name=person.display_name,
        voiceprints=provider_voiceprints,
        model_version=settings.pyannote_model_version,
        enrolled_at=datetime.now(timezone.utc).isoformat(),
    )
    voiceprint_repo.enroll(voiceprint)

    consent_recorded_at = datetime.now(timezone.utc)  # server-stamped
    centrally_registered = False
    if central_required:
        enrolment = CentralEnrolment(
            person_id=person_oid,
            display_name=person.display_name,
            voiceprints=provider_voiceprints,
            sample_sources=body.sample_sources or ["recorded"] * 3,
            model_version=settings.pyannote_model_version,
            consent_recorded_at=consent_recorded_at,
        )
        try:
            get_storage_api_client().register_voiceprint(
                enrolment,
                access_token=central_token,
            )
        except StorageApiError as exc:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                f"Central voiceprint registration failed — retry enrolment: {exc}",
            ) from exc
        centrally_registered = True
    person.centrally_enrolled = centrally_registered
    person.consent_recorded_at = consent_recorded_at

    # Update person enrollment state.
    person.enrolled = True
    person.model_version = settings.pyannote_model_version
    person.reenrollment_required = False

    # Biometric action — always audit-logged (requirements §7).
    before = (
        f"model={previous_model_version}"
        if previous_enrolled
        else "un-enrolled"
    )
    store.add_audit(
        actor,
        "person.enroll",
        person.display_name,
        before=before,
        after=(
            f"model={settings.pyannote_model_version}, "
            f"voiceprints={len(provider_voiceprints)}, enrollment_complete"
            f", centrally_enrolled={centrally_registered}"
        ),
    )

    return person


@router.post("/{employee_id}/flag-reenrollment", response_model=PersonEnrollment)
async def flag_reenrollment(
    employee_id: str, actor: str = Actor
) -> PersonEnrollment:
    """Flag a person for re-enrollment. Used when voiceprint quality degrades
    or the model version changes (IN-76 re-enrollment support)."""
    employee_id = employee_id.strip().lower()
    person = next((p for p in store.PEOPLE if p.employee_id == employee_id), None)
    if person is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Employee not found")

    person.reenrollment_required = True

    store.add_audit(
        actor,
        "person.flag_reenrollment",
        person.display_name,
        before=f"enrolled={person.enrolled}",
        after="reenrollment_required=True",
    )

    return person
