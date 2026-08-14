"""Desktop relay for the Storage API call-watch routes (D7, meeting-call-events).

Thin forwarding layer: the Electron main process (Task 12) mints the
delegated Storage API token and polls these routes roughly every 10s during
a recording. This router does no business logic of its own — it extracts
the ``X-MN-Storage-Token`` header (the same alias pattern as
``app.routers.people``/``app.routers.voiceprint_admin``) and calls straight
through to the Storage API client (real or stub, per
``get_storage_api_client()``).

Error mapping uses the shared ``app.routers._storage_errors`` helper (also
used by ``voiceprint_admin``, its origin) rather than re-deriving it: a
``StorageApiRejected`` with a genuine 4xx status forwards that status as-is
(a real 422 from the Storage API must still look like a 422 to the desktop,
not get flattened to 502); ``StorageApiUnavailable`` becomes 503; everything
else — an odd/5xx ``StorageApiRejected`` status, or a
``StorageApiContractError`` — falls back to 502. Downstream (spec D7) treats
every failure here as "feature dormant this recording", so faithful status
forwarding is what actually matters.
"""

from typing import Annotated

from fastapi import APIRouter, Header, Path, status

from app.routers._storage_errors import raise_storage_error as _raise_storage_error
from app.schemas import CallSignalsResponse, CallWatchReceipt, CallWatchRegistration
from app.services.storage_api import StorageApiError, get_storage_api_client

router = APIRouter(prefix="/call-watch", tags=["call watch"])

StorageToken = Annotated[str | None, Header(alias="X-MN-Storage-Token")]

# sha256 hex of the meeting's joinWebUrl (E2/E6, per-meeting call-watch
# routes) — the pattern constraint means a malformed hash never reaches the
# client/Storage API at all; FastAPI rejects it with a 422 before the route
# body runs.
JoinUrlHash = Annotated[str, Path(pattern=r"^[0-9a-f]{64}$")]


# Trivial one-liner (no branching, nothing to drift) — kept duplicated per
# router rather than shared, unlike the error-mapping logic above, which has
# multi-branch status-code decisions that are easy to accidentally diverge.
def _token(value: str | None) -> str | None:
    return (value or "").strip() or None


@router.post("", response_model=CallWatchReceipt)
def register_call_watch(
    body: CallWatchRegistration,
    storage_token: StorageToken = None,
) -> CallWatchReceipt:
    try:
        return get_storage_api_client().register_call_watch(body, _token(storage_token))
    except StorageApiError as exc:
        _raise_storage_error(exc)
        raise AssertionError("unreachable")


@router.get("/{join_url_hash}/signals", response_model=CallSignalsResponse)
def get_call_signals(
    join_url_hash: JoinUrlHash,
    storage_token: StorageToken = None,
) -> CallSignalsResponse:
    try:
        return get_storage_api_client().get_call_signals(join_url_hash, _token(storage_token))
    except StorageApiError as exc:
        _raise_storage_error(exc)
        raise AssertionError("unreachable")


@router.delete("/{join_url_hash}", status_code=status.HTTP_204_NO_CONTENT)
def delete_call_watch(
    join_url_hash: JoinUrlHash,
    storage_token: StorageToken = None,
) -> None:
    try:
        get_storage_api_client().delete_call_watch(join_url_hash, _token(storage_token))
    except StorageApiError as exc:
        _raise_storage_error(exc)
        raise AssertionError("unreachable")
    return None
