from fastapi import APIRouter

from app import store
from app.schemas import PersonEnrollment

router = APIRouter(prefix="/people", tags=["people"])


@router.get("", response_model=list[PersonEnrollment])
async def list_people() -> list[PersonEnrollment]:
    """Staff with enrollment status. Clients/externals are never listed here
    (enrollment is staff-only, requirements §4.2)."""
    return store.PEOPLE
