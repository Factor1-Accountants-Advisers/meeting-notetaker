import base64
import binascii
from datetime import datetime, timezone

from fastapi import APIRouter, Header, HTTPException, status

from app import store
from app.config import get_settings
from app.schemas import EnrollRequest, PersonEnrollment
from app.services.speaker_embeddings import get_embedding_provider
from app.services.voiceprints import Voiceprint, get_voiceprint_repository

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

    # Validate exactly three clips.
    if len(body.clips_b64) != 3:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"Exactly 3 clips required (received {len(body.clips_b64)})",
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

    # Extract embeddings from all three clips, then average them (IN-76).
    settings = get_settings()
    embed_provider = get_embedding_provider()
    voiceprint_repo = get_voiceprint_repository()

    embeddings: list[list[float]] = []
    for i, clip in enumerate(clips):
        try:
            emb = await embed_provider.extract_embedding(clip)
            if not emb or len(emb) != embed_provider.embedding_dim:
                raise HTTPException(
                    status.HTTP_500_INTERNAL_SERVER_ERROR,
                    f"Clip {i + 1} produced invalid embedding",
                )
            embeddings.append(emb)
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                f"Clip {i + 1} embedding extraction failed",
            )

    # Average the embeddings into one voiceprint.
    dim = embed_provider.embedding_dim
    averaged = [sum(emb[i] for emb in embeddings) / len(embeddings) for i in range(dim)]

    # Delete source audio immediately (requirements §4.2).
    del clips

    # Store the voiceprint.
    voiceprint = Voiceprint(
        employee_id=employee_id,
        display_name=person.display_name,
        embedding=averaged,
        model_version=settings.pyannote_model_version,
        enrolled_at=datetime.now(timezone.utc).isoformat(),
    )
    voiceprint_repo.enroll(voiceprint)

    # Update person enrollment state.
    person.enrolled = True
    person.model_version = settings.pyannote_model_version
    person.reenrollment_required = False

    # Biometric action — always audit-logged (requirements §7).
    store.add_audit(
        actor,
        "person.enroll",
        person.display_name,
        before="un-enrolled" if not person.enrolled else f"model={person.model_version}",
        after=f"model={settings.pyannote_model_version}, dim={dim}, enrollment_complete",
    )

    return person


@router.post("/{employee_id}/flag-reenrollment", response_model=PersonEnrollment)
async def flag_reenrollment(
    employee_id: str, actor: str = Actor
) -> PersonEnrollment:
    """Flag a person for re-enrollment. Used when voiceprint quality degrades
    or the model version changes (IN-76 re-enrollment support)."""
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
