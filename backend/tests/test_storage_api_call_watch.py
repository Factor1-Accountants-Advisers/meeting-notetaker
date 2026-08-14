"""Storage client binding for the section 9 call-watch routes (meeting-call-events)."""

import json
import unittest
import urllib.error

import tests.conftest_env  # noqa: F401

from app.schemas import CallSignalsResponse, CallWatchReceipt, CallWatchRegistration
from app.services.storage_api import (
    RestStorageApiClient,
    StorageApiContractError,
    StorageApiError,
    StorageApiRejected,
    StorageApiUnavailable,
    StubStorageApiClient,
)


REGISTRATION = CallWatchRegistration(
    join_web_url="https://teams.microsoft.com/l/meetup-join/abc",
    scheduled_end_utc="2026-08-12T11:00:00Z",
)
# sha256 hex digest is 64 hex chars; "a" * 64 is a syntactically valid stand-in
# used throughout — the client treats it as an opaque path segment.
JOIN_URL_HASH = "a" * 64
RECEIPT = {
    "watch_id": "8f5203eb-2398-40ce-8567-646ba28e7d27",
    "subscription_expires_utc": "2026-08-12T23:00:00.0000000Z",
}
SIGNALS = {
    "signals": [
        {
            "seq": "20260812T023004123456-a1b2c3d4",
            "type": "recorder_left",
            "event_utc": "2026-08-12T02:30:04Z",
            "received_utc": "2026-08-12T02:30:05.987654+00:00",
        }
    ]
}


class _FakeHttpResponse:
    def __init__(self, payload):
        self.payload = payload

    def read(self) -> bytes:
        if self.payload is None:
            return b""
        return json.dumps(self.payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


class RestCallWatchTests(unittest.TestCase):
    def _client(self, response_payload):
        self.seen = {}

        def opener(req, timeout=30):
            self.seen["method"] = req.get_method()
            self.seen["url"] = req.full_url
            self.seen["authorization"] = req.headers["Authorization"]
            self.seen["payload"] = json.loads(req.data.decode("utf-8")) if req.data else None
            return _FakeHttpResponse(response_payload)

        return RestStorageApiClient("https://storage.example", opener=opener)

    def test_register_call_watch_posts_approved_envelope_and_validates_receipt(self):
        client = self._client(RECEIPT)
        result = client.register_call_watch(REGISTRATION, "token-value")

        self.assertEqual(self.seen["method"], "POST")
        self.assertEqual(self.seen["url"], "https://storage.example/api/v1/call-watches")
        self.assertEqual(self.seen["authorization"], "Bearer token-value")
        self.assertEqual(
            self.seen["payload"],
            {
                "join_web_url": "https://teams.microsoft.com/l/meetup-join/abc",
                "scheduled_end_utc": "2026-08-12T11:00:00Z",
            },
        )
        self.assertIsInstance(result, CallWatchReceipt)
        self.assertEqual(result.watch_id, RECEIPT["watch_id"])
        self.assertEqual(result.subscription_expires_utc, RECEIPT["subscription_expires_utc"])

    def test_register_call_watch_rejects_malformed_receipt(self):
        with self.assertRaises(StorageApiContractError):
            self._client({"watch_id": "only-half"}).register_call_watch(REGISTRATION, "token-value")

        with self.assertRaises(StorageApiContractError):
            self._client(None).register_call_watch(REGISTRATION, "token-value")

    def test_get_call_signals_gets_signals_for_the_hashed_meeting_and_validates_shape(self):
        client = self._client(SIGNALS)
        result = client.get_call_signals(JOIN_URL_HASH, "token-value")

        self.assertEqual(self.seen["method"], "GET")
        self.assertEqual(
            self.seen["url"],
            f"https://storage.example/api/v1/call-watches/{JOIN_URL_HASH}/signals",
        )
        self.assertEqual(self.seen["authorization"], "Bearer token-value")
        self.assertIsInstance(result, CallSignalsResponse)
        self.assertEqual(len(result.signals), 1)
        self.assertEqual(result.signals[0].seq, SIGNALS["signals"][0]["seq"])
        self.assertEqual(result.signals[0].type, "recorder_left")
        self.assertEqual(result.signals[0].event_utc, SIGNALS["signals"][0]["event_utc"])
        self.assertEqual(result.signals[0].received_utc, SIGNALS["signals"][0]["received_utc"])

    def test_get_call_signals_returns_empty_list_cleanly(self):
        client = self._client({"signals": []})
        result = client.get_call_signals(JOIN_URL_HASH, "token-value")
        self.assertEqual(result.signals, [])

    def test_get_call_signals_round_trips_a_null_event_utc(self):
        # event_utc is the only nullable field in the DTO surface (Graph's own
        # eventDateTime is optional) — pin that None survives the round trip
        # rather than being coerced to a string or rejected.
        payload = {
            "signals": [
                {
                    "seq": "20260812T023004123456-a1b2c3d4",
                    "type": "recorder_left",
                    "event_utc": None,
                    "received_utc": "2026-08-12T02:30:05.987654+00:00",
                }
            ]
        }
        client = self._client(payload)
        result = client.get_call_signals(JOIN_URL_HASH, "token-value")
        self.assertIsNone(result.signals[0].event_utc)

    def test_get_call_signals_rejects_malformed_shapes(self):
        with self.assertRaises(StorageApiContractError):
            self._client(
                {"signals": [{"seq": "1", "type": "not_a_real_type", "received_utc": "x"}]}
            ).get_call_signals(JOIN_URL_HASH, "token-value")

        with self.assertRaises(StorageApiContractError):
            self._client({"nope": []}).get_call_signals(JOIN_URL_HASH, "token-value")

    def test_delete_call_watch_deletes_the_hashed_meetings_watch(self):
        client = self._client(None)
        result = client.delete_call_watch(JOIN_URL_HASH, "token-value")

        self.assertEqual(self.seen["method"], "DELETE")
        self.assertEqual(
            self.seen["url"],
            f"https://storage.example/api/v1/call-watches/{JOIN_URL_HASH}",
        )
        self.assertEqual(self.seen["authorization"], "Bearer token-value")
        self.assertIsNone(result)

    def test_delete_call_watch_tolerates_404_as_success(self):
        def not_found(req, timeout=30):
            raise urllib.error.HTTPError(req.full_url, 404, "not found", None, None)

        client = RestStorageApiClient("https://storage.example", opener=not_found)
        self.assertIsNone(client.delete_call_watch(JOIN_URL_HASH, "token-value"))

    def test_rest_fails_closed_without_a_token(self):
        client = self._client(RECEIPT)
        with self.assertRaises(StorageApiUnavailable):
            client.register_call_watch(REGISTRATION, None)
        with self.assertRaises(StorageApiUnavailable):
            client.get_call_signals(JOIN_URL_HASH, None)
        with self.assertRaises(StorageApiUnavailable):
            client.delete_call_watch(JOIN_URL_HASH, None)

    def test_rest_maps_5xx_to_unavailable_and_network_errors_to_unavailable(self):
        def server_error(req, timeout=30):
            raise urllib.error.HTTPError(req.full_url, 503, "unavailable", None, None)

        client = RestStorageApiClient("https://storage.example", opener=server_error)
        with self.assertRaises(StorageApiUnavailable):
            client.register_call_watch(REGISTRATION, "token-value")
        with self.assertRaises(StorageApiUnavailable):
            client.get_call_signals(JOIN_URL_HASH, "token-value")
        with self.assertRaises(StorageApiUnavailable):
            client.delete_call_watch(JOIN_URL_HASH, "token-value")

        def network_error(req, timeout=30):
            raise urllib.error.URLError("network unavailable")

        client = RestStorageApiClient("https://storage.example", opener=network_error)
        with self.assertRaises(StorageApiUnavailable):
            client.get_call_signals(JOIN_URL_HASH, "token-value")

    def test_rest_maps_non_404_rejection_to_rejected_for_all_three_routes(self):
        def rejected(req, timeout=30):
            raise urllib.error.HTTPError(req.full_url, 422, "validation_error", None, None)

        client = RestStorageApiClient("https://storage.example", opener=rejected)
        with self.assertRaises(StorageApiRejected):
            client.register_call_watch(REGISTRATION, "token-value")
        with self.assertRaises(StorageApiRejected):
            client.get_call_signals(JOIN_URL_HASH, "token-value")

        def forbidden(req, timeout=30):
            raise urllib.error.HTTPError(req.full_url, 403, "forbidden", None, None)

        client = RestStorageApiClient("https://storage.example", opener=forbidden)
        with self.assertRaises(StorageApiRejected):
            client.delete_call_watch(JOIN_URL_HASH, "token-value")


class StubCallWatchTests(unittest.TestCase):
    def setUp(self):
        self.client = StubStorageApiClient()

    def test_register_call_watch_returns_fabricated_receipt_with_no_io(self):
        receipt = self.client.register_call_watch(REGISTRATION, None)
        self.assertIsInstance(receipt, CallWatchReceipt)
        self.assertEqual(receipt.watch_id, "stub-watch")
        self.assertTrue(receipt.subscription_expires_utc)

        # Calling again is stable/idempotent and still touches no storage.
        again = self.client.register_call_watch(REGISTRATION, "token-value")
        self.assertEqual(again, receipt)

    def test_get_call_signals_returns_empty_list(self):
        result = self.client.get_call_signals(JOIN_URL_HASH, None)
        self.assertIsInstance(result, CallSignalsResponse)
        self.assertEqual(result.signals, [])

    def test_delete_call_watch_is_a_no_op(self):
        self.assertIsNone(self.client.delete_call_watch(JOIN_URL_HASH, None))
        self.assertIsNone(self.client.delete_call_watch(JOIN_URL_HASH, "token-value"))

    def test_stub_fail_next_applies_to_mutating_call_watch_operations(self):
        self.client.fail_next = True
        with self.assertRaises(StorageApiError):
            self.client.register_call_watch(REGISTRATION, None)

        # get_call_signals is a plain read, matching get_enrolment/list_directory,
        # which do not honor fail_next either.
        self.assertEqual(self.client.get_call_signals(JOIN_URL_HASH, None).signals, [])

        self.client.fail_next = True
        with self.assertRaises(StorageApiError):
            self.client.delete_call_watch(JOIN_URL_HASH, None)


if __name__ == "__main__":
    unittest.main()
