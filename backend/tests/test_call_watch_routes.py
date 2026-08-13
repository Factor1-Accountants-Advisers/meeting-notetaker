"""Desktop relay routes for call-watch (D7, meeting-call-events, Task 10).

Mirrors ``tests/test_voiceprint_admin.py``'s idiom: router functions are
plain sync functions, called directly with ``get_storage_api_client``
patched at the router module — this repo's test suite has no HTTP client
available (no ``httpx`` dependency, so ``fastapi.testclient.TestClient``
cannot run here), so route wiring is exercised at the function level rather
than through a live request cycle.
"""

import unittest
from unittest.mock import patch

import pydantic
from fastapi import HTTPException

from app.routers.call_watch import delete_call_watch, get_call_signals, register_call_watch
from app.schemas import CallSignal, CallSignalsResponse, CallWatchReceipt, CallWatchRegistration
from app.services import storage_api
from app.services.storage_api import (
    StorageApiContractError,
    StorageApiRejected,
    StorageApiUnavailable,
)

REGISTRATION = CallWatchRegistration(
    join_web_url="https://teams.microsoft.com/l/meetup-join/abc",
    scheduled_end_utc="2026-08-12T11:00:00Z",
)


def _receipt() -> CallWatchReceipt:
    return CallWatchReceipt(
        watch_id="watch-123",
        subscription_expires_utc="2026-08-12T23:00:00.0000000Z",
    )


def _signals() -> CallSignalsResponse:
    return CallSignalsResponse(
        signals=[
            CallSignal(
                seq="20260812T023004123456-a1b2c3d4",
                type="recorder_left",
                event_utc="2026-08-12T02:30:04Z",
                received_utc="2026-08-12T02:30:05.987654+00:00",
            )
        ]
    )


class _CapturingCallWatchClient:
    def __init__(self, error=None):
        self.calls = []
        self.error = error

    def register_call_watch(self, registration, access_token):
        self.calls.append(("register", registration, access_token))
        if self.error:
            raise self.error
        return _receipt()

    def get_call_signals(self, access_token):
        self.calls.append(("signals", access_token))
        if self.error:
            raise self.error
        return _signals()

    def delete_call_watch(self, access_token):
        self.calls.append(("delete", access_token))
        if self.error:
            raise self.error
        return None


class CallWatchRouterThreadingTests(unittest.TestCase):
    """Each route must call the right client method and thread the
    ``X-MN-Storage-Token`` value through — stripped when present, None when
    the header is absent (matches the ``StorageToken``/``_token`` pattern in
    people.py and voiceprint_admin.py)."""

    def test_register_threads_the_storage_token_and_returns_the_receipt(self):
        client = _CapturingCallWatchClient()
        with patch("app.routers.call_watch.get_storage_api_client", return_value=client):
            result = register_call_watch(REGISTRATION, storage_token=" token-123 ")
        self.assertEqual(result, _receipt())
        self.assertEqual(client.calls, [("register", REGISTRATION, "token-123")])

    def test_register_with_absent_header_passes_none(self):
        client = _CapturingCallWatchClient()
        with patch("app.routers.call_watch.get_storage_api_client", return_value=client):
            register_call_watch(REGISTRATION, storage_token=None)
        self.assertEqual(client.calls, [("register", REGISTRATION, None)])

    def test_get_signals_threads_the_storage_token_and_returns_signals(self):
        client = _CapturingCallWatchClient()
        with patch("app.routers.call_watch.get_storage_api_client", return_value=client):
            result = get_call_signals(storage_token="token-abc")
        self.assertEqual(result, _signals())
        self.assertEqual(client.calls, [("signals", "token-abc")])

    def test_get_signals_with_absent_header_passes_none(self):
        client = _CapturingCallWatchClient()
        with patch("app.routers.call_watch.get_storage_api_client", return_value=client):
            get_call_signals(storage_token=None)
        self.assertEqual(client.calls, [("signals", None)])

    def test_delete_threads_the_storage_token_and_returns_no_content(self):
        client = _CapturingCallWatchClient()
        with patch("app.routers.call_watch.get_storage_api_client", return_value=client):
            result = delete_call_watch(storage_token="token-xyz")
        self.assertIsNone(result)
        self.assertEqual(client.calls, [("delete", "token-xyz")])

    def test_delete_with_absent_header_passes_none(self):
        client = _CapturingCallWatchClient()
        with patch("app.routers.call_watch.get_storage_api_client", return_value=client):
            delete_call_watch(storage_token=None)
        self.assertEqual(client.calls, [("delete", None)])


class CallWatchErrorMappingTests(unittest.TestCase):
    """Reuses voiceprint_admin's precedent (imported, not re-derived): a
    genuine 4xx StorageApiRejected forwards verbatim; StorageApiUnavailable
    -> 503; everything else (odd/5xx StorageApiRejected status, or a
    StorageApiContractError) falls back to 502."""

    def _assert_maps(self, error, expected_status):
        client = _CapturingCallWatchClient(error)
        with patch("app.routers.call_watch.get_storage_api_client", return_value=client):
            with self.assertRaises(HTTPException) as raised:
                register_call_watch(REGISTRATION, storage_token="token")
            self.assertEqual(raised.exception.status_code, expected_status)

            with self.assertRaises(HTTPException) as raised:
                get_call_signals(storage_token="token")
            self.assertEqual(raised.exception.status_code, expected_status)

            with self.assertRaises(HTTPException) as raised:
                delete_call_watch(storage_token="token")
            self.assertEqual(raised.exception.status_code, expected_status)

    def test_storage_api_unavailable_maps_to_503(self):
        self._assert_maps(StorageApiUnavailable("down"), 503)

    def test_storage_api_rejected_422_forwards_as_422(self):
        # The case the Task 9 review specifically flagged: a real 422 from
        # the storage-api must reach the desktop as 422, not 502.
        self._assert_maps(StorageApiRejected("rejected", 422), 422)

    def test_storage_api_rejected_502_maps_to_502(self):
        self._assert_maps(StorageApiRejected("bad gateway", 502), 502)

    def test_storage_api_rejected_without_status_falls_back_to_502(self):
        self._assert_maps(StorageApiRejected("unknown"), 502)

    def test_storage_api_contract_error_maps_to_502(self):
        self._assert_maps(StorageApiContractError("malformed"), 502)


class CallWatchStubModeTests(unittest.TestCase):
    """End-to-end against the real (unpatched) stub client — no storage
    configured, matching a fresh dev/packaged install (spec D7/D8: ships
    dark)."""

    def setUp(self):
        storage_api.reset_stub_for_tests()

    def test_register_returns_a_fabricated_receipt(self):
        receipt = register_call_watch(REGISTRATION, storage_token=None)
        self.assertIsInstance(receipt, CallWatchReceipt)
        self.assertEqual(receipt.watch_id, "stub-watch")

    def test_get_signals_returns_empty(self):
        result = get_call_signals(storage_token=None)
        self.assertEqual(result, CallSignalsResponse(signals=[]))

    def test_delete_returns_no_content(self):
        self.assertIsNone(delete_call_watch(storage_token=None))


class CallWatchRegistrationValidationTests(unittest.TestCase):
    """The min_length=1 guard added to CallWatchRegistration (Task 9
    carry-over): FastAPI's own request-body validation turns this into a
    422 before the route body ever runs. Pinned here at the schema level —
    this repo's test suite has no HTTP client available to exercise the
    real request cycle (no httpx dependency, confirmed absent from
    requirements.txt and the venv)."""

    def test_empty_join_web_url_is_rejected_locally(self):
        with self.assertRaises(pydantic.ValidationError):
            CallWatchRegistration(join_web_url="", scheduled_end_utc="2026-08-12T11:00:00Z")

    def test_empty_scheduled_end_utc_is_rejected_locally(self):
        with self.assertRaises(pydantic.ValidationError):
            CallWatchRegistration(
                join_web_url="https://teams.microsoft.com/l/meetup-join/abc",
                scheduled_end_utc="",
            )


if __name__ == "__main__":
    unittest.main()
