"""Desktop relay routes for call-watch (D7, meeting-call-events, Task 10;
per-meeting routes, Task 6).

Mirrors ``tests/test_voiceprint_admin.py``'s idiom: router functions are
plain sync functions, called directly with ``get_storage_api_client``
patched at the router module — this repo's test suite has no HTTP client
available (no ``httpx`` dependency, so ``fastapi.testclient.TestClient``
cannot run here), so route wiring is exercised at the function level rather
than through a live request cycle.

The one exception is the malformed-``join_url_hash`` 422 tests: that
rejection happens in FastAPI's own path-parameter validation, which runs
*before* the route function is ever called, so it cannot be observed by
calling the function directly. Those two tests instead drive the router
through the raw ASGI protocol (hand-rolled scope/receive/send, no httpx)
against a bare ``FastAPI()`` app containing only this router.
"""

import asyncio
import hashlib
import unittest
from unittest.mock import patch

import pydantic
from fastapi import FastAPI, HTTPException

from app.routers import call_watch
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

JOIN_URL_HASH = hashlib.sha256(REGISTRATION.join_web_url.encode("utf-8")).hexdigest()


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

    def get_call_signals(self, join_url_hash, access_token):
        self.calls.append(("signals", join_url_hash, access_token))
        if self.error:
            raise self.error
        return _signals()

    def delete_call_watch(self, join_url_hash, access_token):
        self.calls.append(("delete", join_url_hash, access_token))
        if self.error:
            raise self.error
        return None


class CallWatchRouterThreadingTests(unittest.TestCase):
    """Each route must call the right client method and thread the
    ``X-MN-Storage-Token`` value (stripped when present, None when the
    header is absent — matches the ``StorageToken``/``_token`` pattern in
    people.py and voiceprint_admin.py) alongside the path's
    ``join_url_hash``."""

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

    def test_get_signals_threads_the_hash_and_storage_token_and_returns_signals(self):
        client = _CapturingCallWatchClient()
        with patch("app.routers.call_watch.get_storage_api_client", return_value=client):
            result = get_call_signals(JOIN_URL_HASH, storage_token="token-abc")
        self.assertEqual(result, _signals())
        self.assertEqual(client.calls, [("signals", JOIN_URL_HASH, "token-abc")])

    def test_get_signals_with_absent_header_passes_none(self):
        client = _CapturingCallWatchClient()
        with patch("app.routers.call_watch.get_storage_api_client", return_value=client):
            get_call_signals(JOIN_URL_HASH, storage_token=None)
        self.assertEqual(client.calls, [("signals", JOIN_URL_HASH, None)])

    def test_delete_threads_the_hash_and_storage_token_and_returns_no_content(self):
        client = _CapturingCallWatchClient()
        with patch("app.routers.call_watch.get_storage_api_client", return_value=client):
            result = delete_call_watch(JOIN_URL_HASH, storage_token="token-xyz")
        self.assertIsNone(result)
        self.assertEqual(client.calls, [("delete", JOIN_URL_HASH, "token-xyz")])

    def test_delete_with_absent_header_passes_none(self):
        client = _CapturingCallWatchClient()
        with patch("app.routers.call_watch.get_storage_api_client", return_value=client):
            delete_call_watch(JOIN_URL_HASH, storage_token=None)
        self.assertEqual(client.calls, [("delete", JOIN_URL_HASH, None)])


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
                get_call_signals(JOIN_URL_HASH, storage_token="token")
            self.assertEqual(raised.exception.status_code, expected_status)

            with self.assertRaises(HTTPException) as raised:
                delete_call_watch(JOIN_URL_HASH, storage_token="token")
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
        result = get_call_signals(JOIN_URL_HASH, storage_token=None)
        self.assertEqual(result, CallSignalsResponse(signals=[]))

    def test_delete_returns_no_content(self):
        self.assertIsNone(delete_call_watch(JOIN_URL_HASH, storage_token=None))


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


def _asgi_status(method: str, path: str) -> int:
    """Drive ``call_watch.router`` through the raw ASGI protocol (no
    httpx/TestClient available in this venv) and return the response status
    code. Used only for the malformed-hash 422 tests below, where the
    rejection happens in FastAPI's path-parameter validation — a layer that
    calling the route function directly bypasses entirely."""
    app = FastAPI()
    app.include_router(call_watch.router, prefix="/api/v1")

    async def run() -> int:
        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": path,
            "raw_path": path.encode("utf-8"),
            "query_string": b"",
            "root_path": "",
            "headers": [],
            "client": ("testclient", 123),
            "server": ("testserver", 80),
        }

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        status_holder: dict[str, int] = {}

        async def send(message):
            if message["type"] == "http.response.start":
                status_holder["status"] = message["status"]

        await app(scope, receive, send)
        return status_holder["status"]

    return asyncio.run(run())


class CallWatchMalformedHashTests(unittest.TestCase):
    """A malformed ``join_url_hash`` segment must never reach the client —
    it must fail FastAPI's own path validation with 422 before the handler
    (and therefore ``get_storage_api_client``) is ever invoked."""

    def test_get_signals_with_malformed_hash_is_rejected_with_422(self):
        status_code = _asgi_status("GET", "/api/v1/call-watch/not-a-hash/signals")
        self.assertEqual(status_code, 422)

    def test_get_signals_with_uppercase_hash_is_rejected_with_422(self):
        # Pattern is lowercase-hex only — an uppercase hash (still 64 chars,
        # still hex digits) must not sneak through.
        status_code = _asgi_status("GET", f"/api/v1/call-watch/{JOIN_URL_HASH.upper()}/signals")
        self.assertEqual(status_code, 422)

    def test_delete_with_malformed_hash_is_rejected_with_422(self):
        status_code = _asgi_status("DELETE", "/api/v1/call-watch/not-a-hash")
        self.assertEqual(status_code, 422)

    def test_delete_with_short_hash_is_rejected_with_422(self):
        status_code = _asgi_status("DELETE", "/api/v1/call-watch/abc123")
        self.assertEqual(status_code, 422)

    def test_get_signals_with_valid_hash_reaches_the_handler(self):
        # Control case: a well-formed hash must not 422 (proves the above
        # failures are about the pattern, not the harness).
        status_code = _asgi_status("GET", f"/api/v1/call-watch/{JOIN_URL_HASH}/signals")
        self.assertNotEqual(status_code, 422)


if __name__ == "__main__":
    unittest.main()
