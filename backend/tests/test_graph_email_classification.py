"""GraphEmailProvider must distinguish "not delivered" from "unknown" (IN-478).

A duplicate transcript email happens when a send that Graph actually accepted
is reported as a definitive failure and the user retries. Only an HTTP 4xx
response proves Graph rejected the message; timeouts, connection errors, and
5xx responses leave the outcome unknown and must raise
``EmailDeliveryUnconfirmed`` so the endpoint records an informed-retry state.
"""

import io
import unittest
import urllib.error
from unittest.mock import patch

import tests.conftest_env  # noqa: F401 — isolate MN_DATA_DIR before app imports
from app.services.email import EmailDeliveryUnconfirmed, GraphEmailProvider


def _http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(
        url="https://graph.microsoft.com/v1.0/me/sendMail",
        code=code,
        msg="error",
        hdrs=None,
        fp=io.BytesIO(b'{"error": {"message": "boom"}}'),
    )


class GraphEmailClassificationTests(unittest.IsolatedAsyncioTestCase):
    async def _send(self):
        await GraphEmailProvider().send_meeting_notes(
            ["joseph@example.com"],
            "Meeting notes: test",
            "<p>body</p>",
            access_token="token",
            content_type="HTML",
        )

    async def test_timeout_raises_unconfirmed(self):
        with patch("urllib.request.urlopen", side_effect=TimeoutError("timed out")):
            with self.assertRaises(EmailDeliveryUnconfirmed):
                await self._send()

    async def test_connection_error_raises_unconfirmed(self):
        with patch(
            "urllib.request.urlopen",
            side_effect=urllib.error.URLError(OSError("connection reset")),
        ):
            with self.assertRaises(EmailDeliveryUnconfirmed):
                await self._send()

    async def test_http_5xx_raises_unconfirmed(self):
        with patch("urllib.request.urlopen", side_effect=_http_error(503)):
            with self.assertRaises(EmailDeliveryUnconfirmed):
                await self._send()

    async def test_http_4xx_raises_definitive_failure(self):
        with patch("urllib.request.urlopen", side_effect=_http_error(400)):
            with self.assertRaises(RuntimeError) as raised:
                await self._send()
            self.assertNotIsInstance(raised.exception, EmailDeliveryUnconfirmed)


if __name__ == "__main__":
    unittest.main()
