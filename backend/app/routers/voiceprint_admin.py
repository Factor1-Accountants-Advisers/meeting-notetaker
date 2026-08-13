"""Desktop proxy for central voiceprint administration (IN-380/IN-382).

The renderer never receives an access token. The Electron main process adds
the delegated Storage API token to these local routes, and the central API's
``require_admin`` dependency remains the authoritative enforcement point.
"""

from datetime import UTC, datetime, timedelta
from typing import Annotated, Callable

from fastapi import APIRouter, Header

from app import store
from app.routers._storage_errors import raise_storage_error as _raise_storage_error
from app.services.storage_api import (
    StorageApiError,
    VoiceprintAdminActionResponse,
    VoiceprintAdminListResponse,
    VoiceprintAuditEventPage,
    get_storage_api_client,
)

router = APIRouter(prefix="/voiceprint-admin", tags=["voiceprint admin"])

Actor = Header("Unknown user", alias="X-MN-User")
StorageToken = Annotated[str | None, Header(alias="X-MN-Storage-Token")]


# Trivial one-liner (no branching, nothing to drift) — kept duplicated per
# router rather than shared, unlike the error-mapping logic below, which has
# multi-branch status-code decisions that are easy to accidentally diverge.
def _token(value: str | None) -> str | None:
    return (value or "").strip() or None


@router.get("", response_model=VoiceprintAdminListResponse)
def list_voiceprints(
    storage_token: StorageToken = None,
) -> VoiceprintAdminListResponse:
    try:
        return get_storage_api_client().list_voiceprints(_token(storage_token))
    except StorageApiError as exc:
        _raise_storage_error(exc)
        raise AssertionError("unreachable")


@router.get("/audit-events", response_model=VoiceprintAuditEventPage)
def list_audit_events(
    storage_token: StorageToken = None,
) -> VoiceprintAuditEventPage:
    today = datetime.now(UTC).date()
    try:
        return get_storage_api_client().get_voiceprint_audit_events(
            from_date=today - timedelta(days=30),
            to_date=today,
            access_token=_token(storage_token),
            limit=100,
        )
    except StorageApiError as exc:
        _raise_storage_error(exc)
        raise AssertionError("unreachable")


def _apply_action(
    *,
    person_oid: str,
    actor: str,
    storage_token: str | None,
    action: str,
    operation: Callable[[str, str | None], VoiceprintAdminActionResponse],
) -> VoiceprintAdminActionResponse:
    try:
        response = operation(person_oid, _token(storage_token))
    except StorageApiError as exc:
        _raise_storage_error(exc)
        raise AssertionError("unreachable")
    store.add_audit(
        actor,
        f"voiceprint.admin.{action}",
        person_oid,
        before=None,
        after=f"{response.record.status}; central audit {response.audit_event_id}",
    )
    return response


@router.post("/{person_oid}/disable", response_model=VoiceprintAdminActionResponse)
def disable_voiceprint(
    person_oid: str,
    actor: str = Actor,
    storage_token: StorageToken = None,
) -> VoiceprintAdminActionResponse:
    return _apply_action(
        person_oid=person_oid,
        actor=actor,
        storage_token=storage_token,
        action="disable",
        operation=get_storage_api_client().disable_voiceprint,
    )


@router.post("/{person_oid}/enable", response_model=VoiceprintAdminActionResponse)
def enable_voiceprint(
    person_oid: str,
    actor: str = Actor,
    storage_token: StorageToken = None,
) -> VoiceprintAdminActionResponse:
    return _apply_action(
        person_oid=person_oid,
        actor=actor,
        storage_token=storage_token,
        action="enable",
        operation=get_storage_api_client().enable_voiceprint,
    )


@router.delete("/{person_oid}", response_model=VoiceprintAdminActionResponse)
def delete_voiceprint(
    person_oid: str,
    actor: str = Actor,
    storage_token: StorageToken = None,
) -> VoiceprintAdminActionResponse:
    return _apply_action(
        person_oid=person_oid,
        actor=actor,
        storage_token=storage_token,
        action="delete",
        operation=get_storage_api_client().delete_voiceprint,
    )
