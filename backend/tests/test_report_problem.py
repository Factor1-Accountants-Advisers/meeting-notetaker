"""Report-problem email: the full main.log rides along as a gzip attachment.

Both 25 Aug field diagnoses (Gabby "Projects", Regina HD-1513) stalled on the
30-line inline excerpt — the failing upload was thousands of lines above it.
The attachment must be best-effort: a report never fails over its log.
"""

import base64
import gzip
import unittest
from unittest.mock import AsyncMock, patch

from app.routers.support import ReportProblemRequest, report_problem


def _gz_b64(text: str) -> str:
    return base64.b64encode(gzip.compress(text.encode("utf-8"))).decode()


class ReportProblemAttachmentTests(unittest.IsolatedAsyncioTestCase):
    async def _send(self, log_gz_b64: str | None = None):
        request = (
            ReportProblemRequest(issue="it broke", log_gz_b64=log_gz_b64)
            if log_gz_b64 is not None
            else ReportProblemRequest(issue="it broke")
        )
        with patch("app.routers.support.GraphEmailProvider") as provider_cls:
            provider = provider_cls.return_value
            provider.send_meeting_notes = AsyncMock()
            result = await report_problem(
                request,
                user="Regina Latidjan",
                user_email="regina@factor1.com.au",
                user_agent="node",
                graph_token="token",
                recent_logs_b64="",
            )
        return result, provider.send_meeting_notes

    async def test_log_attachment_rides_along(self):
        payload = _gz_b64("line 1\nline 2\n")
        result, send = await self._send(log_gz_b64=payload)
        self.assertTrue(result["ok"])
        attachments = send.await_args.kwargs["attachments"]
        self.assertEqual(len(attachments), 1)
        self.assertEqual(attachments[0]["name"], "main.log.gz")
        self.assertEqual(attachments[0]["@odata.type"], "#microsoft.graph.fileAttachment")
        self.assertEqual(attachments[0]["contentType"], "application/gzip")
        self.assertEqual(attachments[0]["contentBytes"], payload)

    async def test_no_log_sends_without_attachment(self):
        result, send = await self._send()
        self.assertTrue(result["ok"])
        self.assertIsNone(send.await_args.kwargs["attachments"])

    async def test_oversized_log_is_omitted_never_fatal(self):
        big = base64.b64encode(b"\x1f\x8b" + b"0" * (3 * 1024 * 1024 + 1)).decode()
        result, send = await self._send(log_gz_b64=big)
        self.assertTrue(result["ok"])
        self.assertIsNone(send.await_args.kwargs["attachments"])

    async def test_non_gzip_or_invalid_base64_is_omitted_never_fatal(self):
        for bad in ("not-base64!!", base64.b64encode(b"plain text, no gzip magic").decode()):
            with self.subTest(payload=bad):
                result, send = await self._send(log_gz_b64=bad)
                self.assertTrue(result["ok"])
                self.assertIsNone(send.await_args.kwargs["attachments"])


if __name__ == "__main__":
    unittest.main()
