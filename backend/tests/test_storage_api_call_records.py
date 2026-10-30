import json
import unittest
import urllib.error
from datetime import datetime, timezone
from uuid import uuid4

import tests.conftest_env  # noqa: F401

from app.schemas import CallRecordResolveResponse
from app.services.storage_api import (
    RestStorageApiClient,
    StorageApiContractError,
    StorageApiUnavailable,
)


class _Response:
    def __init__(self, payload):
        self.payload = payload

    def read(self):
        return json.dumps(self.payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class CallRecordClientTests(unittest.TestCase):
    def test_resolve_posts_exact_identity_free_payload_and_validates_response(self):
        seen = {}

        def opener(request, timeout=30):
            seen["method"] = request.get_method()
            seen["url"] = request.full_url
            seen["authorization"] = request.headers["Authorization"]
            seen["payload"] = json.loads(request.data.decode())
            return _Response({
                "status": "resolved",
                "participants": [{"name": "David", "email": "da@factor1.com.au"}],
                "retry_after_seconds": 60,
            })

        meeting_id = uuid4()
        started = datetime(2026, 10, 6, 8, 0, tzinfo=timezone.utc)
        ended = datetime(2026, 10, 6, 8, 12, tzinfo=timezone.utc)
        result = RestStorageApiClient("https://storage.example", opener=opener).resolve_call_records(
            meeting_id, started, ended, "token"
        )
        self.assertEqual(seen["method"], "POST")
        self.assertEqual(seen["url"], "https://storage.example/api/v1/call-records/resolve")
        self.assertEqual(seen["authorization"], "Bearer token")
        self.assertEqual(seen["payload"], {
            "meeting_id": str(meeting_id),
            "started_at_utc": started.isoformat(),
            "ended_at_utc": ended.isoformat(),
        })
        self.assertIsInstance(result, CallRecordResolveResponse)
        self.assertEqual(result.participants[0].email, "da@factor1.com.au")

    def test_missing_endpoint_is_pending_and_never_fabricates_participants(self):
        def not_found(request, timeout=30):
            raise urllib.error.HTTPError(request.full_url, 404, "missing", None, None)

        result = RestStorageApiClient("https://storage.example", opener=not_found).resolve_call_records(
            uuid4(), datetime.now(timezone.utc), datetime.now(timezone.utc), "token"
        )
        self.assertEqual(result.status, "pending")
        self.assertEqual(result.participants, [])

    def test_unavailable_and_bad_contract_fail_closed(self):
        def unavailable(request, timeout=30):
            raise urllib.error.HTTPError(request.full_url, 503, "down", None, None)

        with self.assertRaises(StorageApiUnavailable):
            RestStorageApiClient("https://storage.example", opener=unavailable).resolve_call_records(
                uuid4(), datetime.now(timezone.utc), datetime.now(timezone.utc), "token"
            )

        with self.assertRaises(StorageApiContractError):
            RestStorageApiClient("https://storage.example", opener=lambda request, timeout=30: _Response({"status": "wrong"})).resolve_call_records(
                uuid4(), datetime.now(timezone.utc), datetime.now(timezone.utc), "token"
            )


if __name__ == "__main__":
    unittest.main()
