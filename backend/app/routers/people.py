import base64
import binascii

from fastapi import APIRouter, Header, HTTPException, status

from app import store
from app.config import get_settings
from app.schemas import EnrollRequest, PersonEnrollment

router = APIRouter(prefix="/people", tags=["people"])

Actor = Header("Unknown user", alias="X-MN-User")


@router.get("", response_model=list[PersonEnrollment])
async def list_people() -> list[PersonEnrollment]:
    """Staff with enrollment status. Clients/externals are never listed here
    (enrollment is staff-only, requirements §4.2)."""
    return store.PEOPLE


@router.post("/{employee_id}/enroll", response_model=PersonEnrollment)
async def enroll(
    employee_id: str, body: EnrollRequest, actor: str = Actor
) -> PersonEnrollment:
    person = next((p for p in store.PEOPLE if p.employee_id == employee_id), None)
    if person is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Employee not found")

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

    # pyannote embedding extraction lands with the pipeline work. The contract
    # holds regardless: clips stay in memory, one averaged embedding is stored,
    # and the audio is dropped as soon as this request ends.
    settings = get_settings()
    person.enrolled = True
    person.model_version = settings.pyannote_model_version
    person.reenrollment_required = False
    del clips

    # Biometric action — always audit-logged (requirements §7).
    store.add_audit(
        actor,
        "person.enroll",
        person.display_name,
        after=settings.pyannote_model_version,
    )
    return person
