"""Voiceprint onboarding and registry endpoints."""
from __future__ import annotations

from datetime import datetime
import json
import logging
from pathlib import Path
import tempfile
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_current_active_user
from app.core.database import get_db
from app.models import User, Voiceprint, VoiceprintStatus
from app.schemas import VoiceprintDisableRequest, VoiceprintListResponse, VoiceprintResponse
from app.services.pyannote_voiceprint_provider import (
    PyannoteVoiceprintError,
    get_pyannote_voiceprint_provider,
)
from app.services.voiceprint_onboarding import (
    VoiceprintOnboardingError,
    VoiceprintProvider,
    onboard_voiceprint_sample,
)
from app.services.voiceprint_registry import disable_voiceprint, mark_voiceprint_deleted, normalize_email

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/voiceprints", tags=["voiceprints"])


async def _get_owned_voiceprint_or_404(
    db: AsyncSession,
    voiceprint_id: int,
    current_user: User,
) -> Voiceprint:
    result = await db.execute(
        select(Voiceprint).where(
            Voiceprint.id == voiceprint_id,
            Voiceprint.user_id == current_user.id,
        )
    )
    voiceprint = result.scalar_one_or_none()
    if voiceprint is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Voiceprint not found")
    return voiceprint


@router.get("", response_model=VoiceprintListResponse)
async def list_voiceprints(
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
) -> VoiceprintListResponse:
    """List voiceprints owned by the current user."""
    result = await db.execute(
        select(Voiceprint)
        .where(Voiceprint.user_id == current_user.id)
        .order_by(Voiceprint.created_at.desc(), Voiceprint.id.desc())
    )
    return VoiceprintListResponse(
        items=[VoiceprintResponse.model_validate(item) for item in result.scalars().all()]
    )


@router.post("/{voiceprint_id}/disable", response_model=VoiceprintResponse)
async def disable_current_user_voiceprint(
    voiceprint_id: int,
    request: VoiceprintDisableRequest | None = None,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
) -> VoiceprintResponse:
    """Disable a current user's voiceprint while keeping audit metadata."""
    voiceprint = await _get_owned_voiceprint_or_404(db, voiceprint_id, current_user)
    reason = request.reason if request else None
    return await db.run_sync(lambda sync_db: disable_voiceprint(sync_db, voiceprint, reason=reason))


@router.delete("/{voiceprint_id}", response_model=VoiceprintResponse)
async def delete_current_user_voiceprint(
    voiceprint_id: int,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
) -> VoiceprintResponse:
    """Soft-delete a current user's voiceprint.

    Provider deletion/revocation can be added later if pyannote exposes a delete
    endpoint. For now this removes the voiceprint from candidate selection.
    """
    voiceprint = await _get_owned_voiceprint_or_404(db, voiceprint_id, current_user)
    return await db.run_sync(lambda sync_db: mark_voiceprint_deleted(sync_db, voiceprint))


@router.post("", response_model=VoiceprintResponse)
async def create_voiceprint(
    sample_file: UploadFile = File(..., description="20-30 second single-speaker voice sample"),
    consent_confirmed: bool = Form(..., description="User has consented to voiceprint creation"),
    sample_duration_seconds: float | None = Form(None),
    sample_source: str | None = Form("self_service_upload"),
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
    provider: VoiceprintProvider = Depends(get_pyannote_voiceprint_provider),
) -> VoiceprintResponse:
    """Create a voiceprint for the current user.

    Raw sample bytes are temporary only. The service deletes the temp file after
    provider creation and stores only the provider voiceprint ID plus metadata.
    """
    if not consent_confirmed:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Voiceprint consent is required",
        )

    sample_bytes = await sample_file.read()
    consent_recorded_at = datetime.utcnow()

    # Determine safe temp suffix
    suffix = Path(sample_file.filename or "sample.wav").suffix.lower()
    if suffix not in {".wav", ".mp3", ".m4a", ".mp4", ".aac", ".flac", ".ogg"}:
        suffix = ".wav"

    temp_path = Path(tempfile.gettempdir()) / f"voiceprint-sample-{uuid4().hex}{suffix}"
    temp_path.write_bytes(sample_bytes)
    try:
        provider_voiceprint_id = provider.create_voiceprint(temp_path, label=current_user.name)
    except PyannoteVoiceprintError:
        temp_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Voiceprint provider failed",
        )
    finally:
        temp_path.unlink(missing_ok=True)

    if not provider_voiceprint_id:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Voiceprint provider returned empty ID",
        )

    # Insert via raw SQL to avoid aiosqlite session refresh issue
    from sqlalchemy import text
    now = datetime.utcnow()
    result = await db.execute(
        text(
            "INSERT INTO voiceprints (user_id, provider, provider_voiceprint_id, "
            "display_name, email, status, consent_recorded_at, "
            "sample_duration_seconds, sample_source, metadata_json, "
            "created_at, updated_at) "
            "VALUES (:uid, :prov, :vpid, :dname, :email, :status, :consent_at, "
            ":dur, :src, :meta, :now, :now) RETURNING id"
        ),
        {
            "uid": current_user.id,
            "prov": "pyannote",
            "vpid": provider_voiceprint_id,
            "dname": current_user.name.strip() if current_user.name else "Unknown",
            "email": normalize_email(current_user.email),
            "status": "active",
            "consent_at": consent_recorded_at,
            "dur": sample_duration_seconds,
            "src": sample_source,
            "meta": json.dumps({
                "original_filename": sample_file.filename or "voice-sample.wav",
                "content_type": sample_file.content_type,
            }),
            "now": now,
        },
    )
    await db.commit()
    row = result.fetchone()
    vp_id = row[0] if row else 0

    return VoiceprintResponse(
        id=vp_id,
        user_id=current_user.id,
        provider="pyannote",
        display_name=current_user.name.strip() if current_user.name else "Unknown",
        email=normalize_email(current_user.email),
        status="active",
        consent_recorded_at=consent_recorded_at,
        sample_duration_seconds=sample_duration_seconds,
        sample_source=sample_source,
        created_at=now,
        updated_at=now,
    )
