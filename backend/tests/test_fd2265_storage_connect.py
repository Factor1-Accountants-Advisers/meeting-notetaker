"""FD-2265 dev-build field repro (16 Nov 2026).

The Storage API host resolved IPv6 first; IPv6 connects stalled for the full
Windows TCP timeout (21 s) before urllib fell back to IPv4 (0.3 s). Every
voiceprint lookup took ~22 s, past the desktop proxy's 15 s GET budget, and
the blocking call also stalled every other request on the event loop.
"""

import asyncio
import time
import unittest
from unittest.mock import patch

from app.routers.people import enrolment_status
from app.services import storage_api
from app.services.storage_api import RestStorageApiClient, StorageApiUnavailable

IPV6 = ("2001:db8::1", 443, 0, 0)
IPV4 = ("192.0.2.1", 443)


class _FakeSocket:
    def __init__(self, behaviour, log):
        self.behaviour = behaviour
        self.log = log
        self.timeout = "unset"
        self.closed = False

    def settimeout(self, value):
        self.timeout = value

    def setsockopt(self, *args):
        pass

    def bind(self, address):
        pass

    def connect(self, address):
        self.log.append((address, self.timeout))
        if self.behaviour == "stall":
            raise TimeoutError("timed out")
        if self.behaviour == "refuse":
            raise ConnectionRefusedError("refused")

    def close(self):
        self.closed = True


def _resolver(*entries):
    def getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        return [(family_, 1, 6, "", addr) for family_, addr in entries]

    return getaddrinfo


class FastFallbackConnectTests(unittest.TestCase):
    def _connect(self, behaviours, entries, timeout):
        log, sockets = [], []
        queue = list(behaviours)

        def factory(family, type_, proto):
            sock = _FakeSocket(queue.pop(0), log)
            sockets.append(sock)
            return sock

        sock = storage_api.connect_with_fallback(
            ("storage.example", 443),
            timeout,
            None,
            getaddrinfo=_resolver(*entries),
            socket_factory=factory,
        )
        return sock, sockets, log

    def test_stalled_first_address_falls_back_within_seconds(self):
        sock, sockets, log = self._connect(
            ["stall", "ok"], [(23, IPV6), (2, IPV4)], timeout=10
        )

        self.assertIs(sock, sockets[1], "the reachable IPv4 address is used")
        self.assertLessEqual(log[0][1], 3, "a non-final address gets a short connect budget")
        self.assertTrue(sockets[0].closed, "the stalled socket is closed")
        self.assertEqual(sock.timeout, 10, "reads keep the caller's full timeout")

    def test_only_address_gets_the_full_timeout(self):
        sock, _, log = self._connect(["ok"], [(2, IPV4)], timeout=10)

        self.assertEqual(log, [(IPV4, 10)], "a slow single-stack host is not cut short")
        self.assertEqual(sock.timeout, 10)

    def test_all_addresses_failing_raises_and_closes(self):
        with self.assertRaises(OSError):
            self._connect(["stall", "refuse"], [(23, IPV6), (2, IPV4)], timeout=10)


class StorageClientConnectionTests(unittest.TestCase):
    def test_default_client_connects_through_the_fallback(self):
        calls = []

        def fake_connect(address, timeout=None, source_address=None, **_):
            calls.append((address, timeout))
            raise OSError("no network in tests")

        client = RestStorageApiClient("https://storage.invalid")
        with patch.object(storage_api, "connect_with_fallback", fake_connect):
            with self.assertRaises(StorageApiUnavailable):
                client.get_enrolment("oid-1", access_token="tok")

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], ("storage.invalid", 443))

    def test_enrolment_lookup_fits_inside_the_proxy_get_budget(self):
        seen = {}

        def opener(req, timeout=30):
            seen["timeout"] = timeout
            raise TimeoutError("slow")

        client = RestStorageApiClient("https://storage.invalid", opener=opener)
        with self.assertRaises(StorageApiUnavailable):
            client.get_enrolment("oid-1", access_token="tok")

        # The desktop proxy aborts GETs at 15 s; the backend must answer
        # "could not check" before that, including a 3 s connect fallback.
        self.assertLessEqual(seen["timeout"] + 3, 14)


class EnrolmentStatusEventLoopTests(unittest.IsolatedAsyncioTestCase):
    async def test_slow_central_lookup_does_not_block_other_requests(self):
        class _SlowClient:
            def get_enrolment(self, person_id, access_token=None):
                time.sleep(0.6)
                return None

        # Measured from before both tasks start: a blocking lookup delays the
        # ticker's first step until the lookup returns.
        started = time.monotonic()

        async def ticker():
            await asyncio.sleep(0.05)
            return time.monotonic() - started

        with patch("app.routers.people.central_enrolment_required", return_value=True), \
                patch("app.routers.people.get_storage_api_client", return_value=_SlowClient()):
            _, tick = await asyncio.gather(
                enrolment_status(
                    user_email="someone@example.com",
                    user_oid="oid-1",
                    storage_token="tok",
                ),
                ticker(),
            )

        self.assertLess(tick, 0.3, "the event loop stays free while central is consulted")


if __name__ == "__main__":
    unittest.main()
