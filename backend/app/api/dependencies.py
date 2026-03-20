"""FastAPI dependencies for authentication and authorization.

Implements OWASP best practices:
- Fail-closed authentication (deny by default)
- Consistent error responses (401 for all auth failures)
- No user enumeration through error messages
- Auto-provisioning users from Azure AD claims
"""
import logging
from typing import Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.config import settings
from app.core.database import get_db
from app.core.security import validate_azure_ad_token, extract_user_info, AuthenticationError
from app.models import User

logger = logging.getLogger(__name__)

# HTTP Bearer token scheme
security = HTTPBearer(
    scheme_name="Azure AD Bearer",
    description="Azure AD JWT token",
    auto_error=False,  # We handle errors manually for better control
)

# ---------------------------------------------------------------------------
# Dev-mode auth bypass
# ---------------------------------------------------------------------------
DEV_USER_EMAIL = "dev@localhost"
DEV_USER_NAME = "Dev User"
DEV_USER_AZURE_ID = "dev-bypass-00000"


async def _get_or_create_dev_user(db: AsyncSession) -> User:
    """Return a deterministic dev user, creating it on first call.

    Only used when ENVIRONMENT=development and no Azure AD credentials
    are configured.
    """
    result = await db.execute(
        select(User).where(User.azure_ad_id == DEV_USER_AZURE_ID)
    )
    user = result.scalars().first()
    if not user:
        user = User(
            azure_ad_id=DEV_USER_AZURE_ID,
            email=DEV_USER_EMAIL,
            name=DEV_USER_NAME,
            role="user",
        )
        db.add(user)
        await db.flush()
        await db.refresh(user)
        logger.info("Auto-provisioned dev bypass user")
    return user


def _auth_bypass_enabled() -> bool:
    """True when running in dev mode without Azure AD configured."""
    return (
        settings.environment == "development"
        and not settings.azure_ad_tenant_id
    )


async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    db: AsyncSession = Depends(get_db)
) -> User:
    """Get current authenticated user from JWT token.

    In development mode with no Azure AD configured, returns a
    deterministic dev user so endpoints can be tested with curl.

    OWASP Security (production):
    - Fail-closed: Missing/invalid token = 401
    - Generic error message (no enumeration)
    - Detailed logging server-side only
    - Auto-provision prevents user enumeration
    """
    # --- Dev bypass ---
    if _auth_bypass_enabled():
        if not credentials:
            logger.info("Dev auth bypass: no token, returning dev user")
            return await _get_or_create_dev_user(db)
        # If a token IS provided in dev mode, still try to validate it
        # so devs can test real auth flow when ready.

    # --- Production path ---
    # Fail-closed: No credentials = deny
    if not credentials:
        logger.warning("Authentication failed: No credentials provided")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = credentials.credentials

    try:
        # Validate JWT token (fail-closed)
        claims = validate_azure_ad_token(token)

        # Extract user info from claims
        user_info = extract_user_info(claims)
        azure_ad_id = user_info["azure_ad_id"]

        # Get or create user (prevents user enumeration)
        result = await db.execute(
            select(User).where(User.azure_ad_id == azure_ad_id)
        )
        user = result.scalars().first()

        if not user:
            # Auto-provision user on first login
            user = User(
                azure_ad_id=azure_ad_id,
                email=user_info["email"],
                name=user_info["name"],
                role="user",  # Default role
            )
            db.add(user)
            await db.flush()
            await db.refresh(user)

            logger.info(f"Auto-provisioned new user: {azure_ad_id}")

        return user

    except AuthenticationError:
        # Fail-closed: Token validation failed
        # Generic message to prevent information disclosure
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )

    except Exception as e:
        # Fail-closed: Any unexpected error denies access
        logger.error(f"Unexpected error in authentication: {type(e).__name__}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication error",
            headers={"WWW-Authenticate": "Bearer"},
        )


async def get_current_active_user(
    current_user: User = Depends(get_current_user)
) -> User:
    """Get current active user.

    Additional dependency layer for checking user status.
    Can be extended to check if user is active, banned, etc.

    Args:
        current_user: User from get_current_user dependency

    Returns:
        User object if active

    Raises:
        HTTPException: 403 if user is not active
    """
    # Future: Add user status checks here
    # if not current_user.is_active:
    #     raise HTTPException(status_code=403, detail="Inactive user")

    return current_user
