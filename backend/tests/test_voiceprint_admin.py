"""IN-380/IN-382 desktop proxy and Storage API admin client coverage."""

import json
import unittest
import urllib.error
from datetime import date, datetime, timezone
from unittest.mock import patch

from fastapi import HTTPException

from app import store
from app.routers.voiceprint_admin import (
    delete_voiceprint,
    disable_voiceprint,
    enable_voiceprint,
    list_audit_events,
    list_voiceprints,
)
from app.services.storage_api import (
    RestStorageApiClient,
    StorageApiRejected,
    VoiceprintAdminActionResponse,
    VoiceprintAdminListResponse,
    VoiceprintAdminRecord,
    VoiceprintAuditEventPage,
)


def _record(status="active", count=3):
    return VoiceprintAdminRecord(
        person_id="oid-123",
        email="person@example.com",
        display_name="Person Example",
        status=status,
        sample_sources=["recorded"],
        consent_recorded_at=datetime(2026, 7, 1, tzinfo=timezone.utc),
        created_at=datetime(2026, 7, 1, tzinfo=timezone.utc),
        updated_at=datetime(2026, 7, 29, tzinfo=timezone.utc),
        voiceprint_count=count,
    )


def _action(status="disabled"):
    return VoiceprintAdminActionResponse(
        record=_record(status, 0 if status == "deleted" else 3),
        audit_event_id=f"event-{status}",
    )


class _FakeResponse:
    def __init__(self, body):
        self.body = json.dumps(body).encode()

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class RestVoiceprintAdminClientTests(unittest.TestCase):
    def test_list_and_actions_use_admin_contract_paths_without_artifacts(self):
        calls = []

        def opener(request, timeout=30):
            calls.append((request.method, request.full_url, request.headers))
            if request.method == "GET":
                body = {"items": [_record().model_dump(mode="json")]}
            else:
                status = (
                    "disabled"
                    if request.full_url.endswith("/disable")
                    else "active"
                    if request.full_url.endswith("/enable")
                    else "deleted"
                )
                body = _action(status).model_dump(mode="json")
            return _FakeResponse(body)

        client = RestStorageApiClient("https://storage.example", opener=opener)
        listed = client.list_voiceprints("secret-token")
        disabled = client.disable_voiceprint("oid/123", "secret-token")
        enabled = client.enable_voiceprint("oid/123", "secret-token")
        deleted = client.delete_voiceprint("oid/123", "secret-token")

        self.assertEqual(len(listed.items), 1)
        self.assertFalse(hasattr(listed.items[0], "voiceprints"))
        self.assertEqual(disabled.record.status, "disabled")
        self.assertEqual(enabled.record.status, "active")
        self.assertEqual(deleted.record.status, "deleted")
        self.assertEqual(
            [(method, url.removeprefix("https://storage.example")) for method, url, _ in calls],
            [
                ("GET", "/api/v1/voiceprints"),
                ("POST", "/api/v1/voiceprints/oid%2F123/disable"),
                ("POST", "/api/v1/voiceprints/oid%2F123/enable"),
                ("DELETE", "/api/v1/voiceprints/oid%2F123"),
            ],
        )
        self.assertTrue(
            all(headers["Authorization"] == "Bearer secret-token" for _, _, headers in calls)
        )

    def test_audit_query_is_bounded_to_supplied_dates(self):
        captured = {}

        def opener(request, timeout=30):
            captured["url"] = request.full_url
            return _FakeResponse({"items": [], "next_cursor": None})

        client = RestStorageApiClient("https://storage.example", opener=opener)
        page = client.get_voiceprint_audit_events(
            date(2026, 7, 1), date(2026, 7, 29), "token", 100
        )
        self.assertEqual(page.items, [])
        self.assertIn("from_date=2026-07-01", captured["url"])
        self.assertIn("to_date=2026-07-29", captured["url"])
        self.assertIn("limit=100", captured["url"])

    def test_remote_forbidden_status_is_preserved(self):
        def opener(request, timeout=30):
            raise urllib.error.HTTPError(request.full_url, 403, "Forbidden", {}, None)

        client = RestStorageApiClient("https://storage.example", opener=opener)
        with self.assertRaises(StorageApiRejected) as raised:
            client.list_voiceprints("token")
        self.assertEqual(raised.exception.status_code, 403)


class _CapturingAdminClient:
    def __init__(self, error=None):
        self.calls = []
        self.error = error

    def _result(self, method, person_oid, token):
        self.calls.append((method, person_oid, token))
        if self.error:
            raise self.error
        status = {"disable": "disabled", "enable": "active", "delete": "deleted"}[method]
        return _action(status)

    def list_voiceprints(self, token):
        self.calls.append(("list", token))
        if self.error:
            raise self.error
        return VoiceprintAdminListResponse(items=[_record()])

    def get_voiceprint_audit_events(self, from_date, to_date, access_token, limit=100):
        self.calls.append(("audit", from_date, to_date, access_token, limit))
        if self.error:
            raise self.error
        return VoiceprintAuditEventPage(items=[])

    def disable_voiceprint(self, person_oid, token):
        return self._result("disable", person_oid, token)

    def enable_voiceprint(self, person_oid, token):
        return self._result("enable", person_oid, token)

    def delete_voiceprint(self, person_oid, token):
        return self._result("delete", person_oid, token)


class VoiceprintAdminRouterTests(unittest.TestCase):
    def setUp(self):
        self.audit_backup = list(store.AUDIT_LOG)

    def tearDown(self):
        store.AUDIT_LOG[:] = self.audit_backup

    def test_list_and_audit_forward_only_the_injected_storage_token(self):
        client = _CapturingAdminClient()
        with patch(
            "app.routers.voiceprint_admin.get_storage_api_client", return_value=client
        ):
            listed = list_voiceprints(storage_token=" token-123 ")
            events = list_audit_events(storage_token=" token-123 ")
        self.assertEqual(listed.items[0].person_id, "oid-123")
        self.assertEqual(events.items, [])
        self.assertEqual(client.calls[0], ("list", "token-123"))
        self.assertEqual(client.calls[1][3:], ("token-123", 100))
        self.assertEqual((client.calls[1][2] - client.calls[1][1]).days, 30)

    def test_mutations_forward_and_create_local_audit_evidence(self):
        client = _CapturingAdminClient()
        with patch(
            "app.routers.voiceprint_admin.get_storage_api_client", return_value=client
        ):
            disabled = disable_voiceprint("oid-123", "Admin User", "token")
            enabled = enable_voiceprint("oid-123", "Admin User", "token")
            deleted = delete_voiceprint("oid-123", "Admin User", "token")
        self.assertEqual(
            client.calls,
            [
                ("disable", "oid-123", "token"),
                ("enable", "oid-123", "token"),
                ("delete", "oid-123", "token"),
            ],
        )
        self.assertEqual(
            [event.action for event in store.AUDIT_LOG[-3:]],
            [
                "voiceprint.admin.disable",
                "voiceprint.admin.enable",
                "voiceprint.admin.delete",
            ],
        )
        self.assertEqual(disabled.audit_event_id, "event-disabled")
        self.assertEqual(enabled.audit_event_id, "event-active")
        self.assertEqual(deleted.audit_event_id, "event-deleted")

    def test_remote_non_admin_remains_forbidden(self):
        client = _CapturingAdminClient(StorageApiRejected("forbidden", 403))
        with patch(
            "app.routers.voiceprint_admin.get_storage_api_client", return_value=client
        ):
            with self.assertRaises(HTTPException) as raised:
                list_voiceprints(storage_token="non-admin-token")
        self.assertEqual(raised.exception.status_code, 403)
        self.assertEqual(store.AUDIT_LOG, self.audit_backup)
