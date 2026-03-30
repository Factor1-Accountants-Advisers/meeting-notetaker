"""User endpoints."""
from fastapi import APIRouter, Depends

from app.api.dependencies import get_current_user
from app.models import User
from app.schemas import UserResponse

router = APIRouter(prefix="/api", tags=["users"])


@router.get("/me", response_model=UserResponse)
async def get_current_user_info(
    current_user: User = Depends(get_current_user)
) -> UserResponse:
    """Get authenticated user profile.

    Returns user information for the currently authenticated user.
    Requires valid Azure AD JWT token.

    Security:
    - Requires authentication (Bearer token)
    - Returns only current user's info (no access control bypass)

    Returns:
        UserResponse: User profile information
    """
    return UserResponse.model_validate(current_user)
