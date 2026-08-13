"""Desktop relay for the Storage API call-watch routes (D7, meeting-call-events).

Thin forwarding layer: the Electron main process (Task 12) mints the
delegated Storage API token and polls these routes roughly every 10s during
a recording. This router does no business logic of its own — it extracts
the ``X-MN-Storage-Token`` header (the same alias pattern as
``app.routers.people``/``app.routers.voiceprint_admin``) and calls straight
through to the Storage API client (real or stub, per
``get_storage_api_client()``).

Error mapping reuses ``voiceprint_admin._raise_storage_error`` verbatim
rather than re-deriving it (established precedent): a ``StorageApiRejected``
with a genuine 4xx status forwards that status as-is (a real 422 from the
Storage API must still look like a 422 to the desktop, not get flattened to
502); ``StorageApiUnavailable`` becomes 503; everything else — an odd/5xx
``StorageApiRejected`` status, or a ``StorageApiContractError`` — falls back
to 502. Downstream (spec D7) treats every failure here as "feature dormant
this recording", so faithful status forwarding is what actually matters.
"""

from typing import Annotated

from fastapi import APIRouter, Header, status

from app.routers.voiceprint_admin import _raise_storage_error
from app.schemas import CallSignalsResponse, CallWatchReceipt, CallWatchRegistration
from app.services.storage_api import StorageApiError, get_storage_api_client

router = APIRouter(prefix="/call-watch", tags=["call watch"])

StorageToken = Annotated[str | None, Header(alias="X-MN-Storage-Token")]


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


@router.get("/signals", response_model=CallSignalsResponse)
def get_call_signals(
    storage_token: StorageToken = None,
) -> CallSignalsResponse:
    try:
        return get_storage_api_client().get_call_signals(_token(storage_token))
    except StorageApiError as exc:
        _raise_storage_error(exc)
        raise AssertionError("unreachable")


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
def delete_call_watch(
    storage_token: StorageToken = None,
) -> None:
    try:
        get_storage_api_client().delete_call_watch(_token(storage_token))
    except StorageApiError as exc:
        _raise_storage_error(exc)
        raise AssertionError("unreachable")
    return None
