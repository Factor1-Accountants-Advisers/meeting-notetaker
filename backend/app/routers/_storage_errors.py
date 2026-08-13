"""Shared Storage API -> HTTPException mapping for desktop relay routers.

Lives in ``app/routers`` (not ``app/services/storage_api.py``) because it
raises ``fastapi.HTTPException`` — an HTTP-layer concern. The service layer
(``app.services.storage_api``) stays transport-agnostic: it raises
``StorageApiError`` subclasses and knows nothing about HTTP status codes
beyond the raw ``status_code`` a rejection carried. Mapping that to an
actual HTTP response belongs with the routers that produce responses.

Both ``app.routers.voiceprint_admin`` and ``app.routers.call_watch`` relay
calls to the central Storage API and must fail the same way, so this is the
one place that decides how:

- ``StorageApiRejected`` with a genuine 4xx ``status_code`` forwards that
  status verbatim (a real 422 from the Storage API must still reach the
  desktop as 422, not get flattened to 502).
- ``StorageApiUnavailable`` -> 503.
- Anything else — an odd/5xx ``StorageApiRejected`` status, or a
  ``StorageApiContractError`` — falls back to 502.

Message text is deliberately generic ("Storage API ...") rather than
feature-specific: these strings land in logs/App Insights for every relay
route that reuses this helper, and a feature-specific message (e.g.
"Voiceprint administration is temporarily unavailable") would misdescribe
an unrelated route's failure — a debugging tax the previous per-router copy
of this logic paid silently.
"""

from fastapi import HTTPException, status

from app.services.storage_api import StorageApiError, StorageApiRejected, StorageApiUnavailable


def raise_storage_error(exc: StorageApiError) -> None:
    if isinstance(exc, StorageApiRejected):
        code = exc.status_code
        if code is not None and 400 <= code < 500:
            raise HTTPException(code, "Storage API rejected the request") from exc
    if isinstance(exc, StorageApiUnavailable):
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Storage API is temporarily unavailable",
        ) from exc
    raise HTTPException(
        status.HTTP_502_BAD_GATEWAY,
        "Storage API returned an invalid response",
    ) from exc
