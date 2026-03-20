"""Security module for Azure AD JWT validation.

Implements OWASP authentication best practices:
- Fail-closed: All validation errors deny access
- No information disclosure in error messages
- Proper JWT validation (signature, expiration, issuer, audience)
- JWKS caching with TTL
"""
import logging
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
from functools import lru_cache

from jose import jwt, JWTError
from jose.exceptions import ExpiredSignatureError, JWTClaimsError
import requests

from app.core.config import settings

logger = logging.getLogger(__name__)

# JWKS cache TTL (24 hours)
JWKS_CACHE_TTL = timedelta(hours=24)
_jwks_cache: Optional[Dict[str, Any]] = None
_jwks_cache_time: Optional[datetime] = None


class AuthenticationError(Exception):
    """Generic authentication error - no details exposed to client."""
    pass


def get_jwks_uri() -> str:
    """Get JWKS URI for Azure AD tenant.

    Returns:
        JWKS URI string
    """
    tenant_id = settings.azure_ad_tenant_id
    return f"https://login.microsoftonline.com/{tenant_id}/discovery/v2.0/keys"


def fetch_jwks() -> Dict[str, Any]:
    """Fetch JWKS from Azure AD with caching.

    Implements fail-closed pattern: Any error returns empty JWKS,
    which will cause token validation to fail.

    Returns:
        JWKS dictionary or empty dict on error
    """
    global _jwks_cache, _jwks_cache_time

    # Check cache
    if _jwks_cache and _jwks_cache_time:
        if datetime.utcnow() - _jwks_cache_time < JWKS_CACHE_TTL:
            return _jwks_cache

    try:
        jwks_uri = get_jwks_uri()
        response = requests.get(jwks_uri, timeout=10)
        response.raise_for_status()

        jwks = response.json()

        # Update cache
        _jwks_cache = jwks
        _jwks_cache_time = datetime.utcnow()

        logger.info("JWKS fetched and cached successfully")
        return jwks

    except Exception as e:
        # Fail-closed: Log error but return empty JWKS
        # This ensures validation will fail if JWKS cannot be fetched
        logger.error(f"Failed to fetch JWKS: {type(e).__name__}")
        return {"keys": []}


def validate_azure_ad_token(token: str) -> Dict[str, Any]:
    """Validate Azure AD JWT token and extract claims.

    Validates:
    1. Token signature using JWKS
    2. Token expiration (exp claim)
    3. Token issuer (iss claim)
    4. Token audience (aud claim)
    5. Required claims present

    OWASP Best Practices:
    - Fail-closed: Any validation error raises AuthenticationError
    - No information disclosure: Generic error message to client
    - Detailed logging: Specific errors logged server-side only

    Args:
        token: JWT token string from Authorization header

    Returns:
        Dictionary of validated claims

    Raises:
        AuthenticationError: On any validation failure (generic message)
    """
    try:
        # Fetch JWKS (cached)
        jwks = fetch_jwks()

        # Get token header to find correct key
        unverified_header = jwt.get_unverified_header(token)

        # Find matching key in JWKS
        rsa_key = None
        for key in jwks.get("keys", []):
            if key.get("kid") == unverified_header.get("kid"):
                rsa_key = {
                    "kty": key["kty"],
                    "kid": key["kid"],
                    "use": key["use"],
                    "n": key["n"],
                    "e": key["e"]
                }
                break

        if not rsa_key:
            # Fail-closed: No matching key = deny access
            logger.warning("No matching key found in JWKS for token kid")
            raise AuthenticationError("Invalid token")

        # Validate token
        # This checks: signature, expiration, issuer, audience
        expected_issuer = f"https://login.microsoftonline.com/{settings.azure_ad_tenant_id}/v2.0"
        expected_audience = settings.azure_ad_client_id

        payload = jwt.decode(
            token,
            rsa_key,
            algorithms=["RS256"],  # Only allow RS256 (prevents algorithm confusion)
            audience=expected_audience,
            issuer=expected_issuer,
            options={
                "verify_signature": True,
                "verify_exp": True,
                "verify_iss": True,
                "verify_aud": True,
                "require_exp": True,
                "require_iat": True,
            }
        )

        # Verify required claims are present
        required_claims = ["oid", "preferred_username", "name"]
        for claim in required_claims:
            if claim not in payload:
                logger.warning(f"Missing required claim: {claim}")
                raise AuthenticationError("Invalid token")

        logger.info(f"Token validated successfully for user: {payload.get('oid')}")
        return payload

    except ExpiredSignatureError:
        # Specific error type, but generic message to client
        logger.warning("Token validation failed: expired")
        raise AuthenticationError("Invalid token")

    except JWTClaimsError as e:
        # Claims validation failed (issuer, audience, etc.)
        logger.warning(f"Token validation failed: {type(e).__name__}")
        raise AuthenticationError("Invalid token")

    except JWTError as e:
        # Generic JWT error (signature invalid, malformed, etc.)
        logger.warning(f"Token validation failed: {type(e).__name__}")
        raise AuthenticationError("Invalid token")

    except Exception as e:
        # Fail-closed: Any unexpected error denies access
        logger.error(f"Unexpected error during token validation: {type(e).__name__}")
        raise AuthenticationError("Invalid token")


def extract_user_info(claims: Dict[str, Any]) -> Dict[str, str]:
    """Extract user information from validated JWT claims.

    Maps Azure AD claims to our user model:
    - oid -> azure_ad_id (unique user identifier)
    - preferred_username -> email
    - name -> name

    Args:
        claims: Validated JWT claims

    Returns:
        Dictionary with user info
    """
    return {
        "azure_ad_id": claims.get("oid", ""),
        "email": claims.get("preferred_username", ""),
        "name": claims.get("name", ""),
    }


@lru_cache()
def get_security_headers() -> Dict[str, str]:
    """Get security headers for responses.

    Returns security headers to prevent common vulnerabilities.
    """
    return {
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "X-XSS-Protection": "1; mode=block",
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    }
