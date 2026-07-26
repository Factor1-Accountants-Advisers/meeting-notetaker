"""IN-386 meeting export and audio delivery through the Storage API seam."""

import json
import tempfile
import unittest
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

import tests.conftest_env  # noqa: F401

from app.paths import central_meetings_dir
from app.services.storage_api import (
    AudioUploadGrant,
    BlobExportReceipt,
    RestStorageApiClient,
    StorageApiContractError,
    StorageApiError,
    StorageApiRejected,
    StorageApiUnavailable,
    StubStorageApiClient,
)


MEETING_ID = UUID("9ab402de-a57f-45a6-8cde-4f89902f5d0b")
TIME_BASIS = datetime(2026, 7, 27, 8, 30, tzinfo=timezone.utc)
RECEIPT = {
    "meeting_id": str(MEETING_ID),
    "blob_path": "notetaker/meetings/2026/07/9ab402de-a57f-45a6-8cde-4f89902f5d0b/meeting.json",
    "revision": "created",
    "updated_at": "2026-07-27T08:31:00Z",
}
GRANT = {
    "upload_url": "https://stf1nt.blob.core.windows.net/notetaker/a.webm?sig=secret-sas",
    "blob_path": "notetaker/meetings/2026/07/9ab402de-a57f-45a6-8cde-4f89902f5d0b/audio.webm",
    "expires_at": "2026-07-27T08:40:00Z",
}


class _FakeHttpResponse:
    def __init__(self, payload: dict):
        self.payload = payload

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


class _BlobResponse:
    def __init__(self, status: int):
        self.status = status
        self.read_called = False

    def read(self):
        self.read_called = True
        return b""


class _BlobConnection:
    def __init__(self, host, port=None, timeout=None, status=201):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.status = status
        self.method = None
        self.target = None
        self.headers = {}
        self.sent = []
        self.closed = False
        self.response = _BlobResponse(status)

    def putrequest(self, method, target):
        self.method = method
        self.target = target

    def putheader(self, key, value):
        self.headers[key] = value

    def endheaders(self):
        pass

    def send(self, data):
        self.sent.append(data)

    def getresponse(self):
        return self.response

    def close(self):
        self.closed = True


class RestMeetingDeliveryTests(unittest.TestCase):
    def _client(self, response_payload):
        self.seen = {}

        def opener(req, timeout=30):
            self.seen["method"] = req.get_method()
            self.seen["url"] = req.full_url
            self.seen["authorization"] = req.headers["Authorization"]
            self.seen["payload"] = json.loads(req.data.decode("utf-8")) if req.data else None
            return _FakeHttpResponse(response_payload)

        return RestStorageApiClient("https://storage.example", opener=opener)

    def test_upload_meeting_export_uses_approved_put_envelope_and_validates_receipt(self):
        client = self._client(RECEIPT)
        result = client.upload_meeting_export(MEETING_ID, TIME_BASIS, {"schema_version": "1.0"}, "token-value")

        self.assertEqual(self.seen["method"], "PUT")
        self.assertEqual(self.seen["url"], f"https://storage.example/api/v1/meetings/{MEETING_ID}/export")
        self.assertEqual(self.seen["authorization"], "Bearer token-value")
        self.assertEqual(
            self.seen["payload"],
            {"time_basis_utc": TIME_BASIS.isoformat(), "export": {"schema_version": "1.0"}},
        )
        self.assertIsInstance(result, BlobExportReceipt)
        self.assertEqual(result.meeting_id, MEETING_ID)

    def test_request_audio_grant_uses_approved_post_envelope_and_validates_grant(self):
        client = self._client(GRANT)
        result = client.request_audio_upload_sas(MEETING_ID, TIME_BASIS, "token-value")

        self.assertEqual(self.seen["method"], "POST")
        self.assertEqual(self.seen["url"], f"https://storage.example/api/v1/meetings/{MEETING_ID}/audio/upload-sas")
        self.assertEqual(self.seen["payload"], {"time_basis_utc": TIME_BASIS.isoformat()})
        self.assertIsInstance(result, AudioUploadGrant)
        self.assertEqual(result.blob_path, GRANT["blob_path"])

    def test_rest_rejects_mismatched_receipt_and_malformed_grant_without_sensitive_values(self):
        mismatched = dict(RECEIPT, meeting_id=str(UUID("b2b402de-a57f-45a6-8cde-4f89902f5d0b")))
        with self.assertRaises(StorageApiContractError) as mismatch:
            self._client(mismatched).upload_meeting_export(MEETING_ID, TIME_BASIS, {}, "token-value")
        self.assertNotIn("token-value", str(mismatch.exception))

        with self.assertRaises(StorageApiContractError) as malformed:
            self._client({"upload_url": "stub://opaque", "blob_path": "x", "expires_at": "not-a-date"}).request_audio_upload_sas(MEETING_ID, TIME_BASIS, "token-value")
        self.assertNotIn("stub://opaque", str(malformed.exception))

    def test_rest_fails_closed_and_maps_representative_errors_without_token_or_sas(self):
        client = self._client(RECEIPT)
        with self.assertRaises(StorageApiUnavailable) as missing:
            client.upload_meeting_export(MEETING_ID, TIME_BASIS, {}, None)
        self.assertNotIn("token-value", str(missing.exception))

        def rejected(req, timeout=30):
            raise urllib.error.HTTPError(req.full_url, 403, "forbidden", None, None)

        with self.assertRaises(StorageApiRejected):
            RestStorageApiClient("https://storage.example", opener=rejected).request_audio_upload_sas(MEETING_ID, TIME_BASIS, "token-value")

        def unavailable(req, timeout=30):
            raise urllib.error.URLError("network unavailable")

        with self.assertRaises(StorageApiUnavailable):
            RestStorageApiClient("https://storage.example", opener=unavailable).request_audio_upload_sas(MEETING_ID, TIME_BASIS, "token-value")

    def test_audio_upload_streams_mebibyte_chunks_with_required_azure_headers(self):
        connection = None

        def connection_factory(host, port=None, timeout=None):
            nonlocal connection
            connection = _BlobConnection(host, port=port, timeout=timeout)
            return connection

        with tempfile.TemporaryDirectory() as tmp:
            audio_path = Path(tmp) / "audio.webm"
            audio_path.write_bytes(b"a" * ((1024 * 1024 * 2) + 13))
            client = RestStorageApiClient(
                "https://storage.example",
                connection_factory=connection_factory,
            )
            client.upload_audio_to_grant(AudioUploadGrant(**GRANT), audio_path)

        self.assertIsNotNone(connection)
        self.assertEqual(connection.host, "stf1nt.blob.core.windows.net")
        self.assertEqual(connection.timeout, 900)
        self.assertEqual(connection.method, "PUT")
        self.assertEqual(connection.target, "/notetaker/a.webm?sig=secret-sas")
        self.assertEqual(connection.headers["Content-Type"], "audio/webm")
        self.assertEqual(connection.headers["x-ms-blob-type"], "BlockBlob")
        self.assertEqual(connection.headers["Content-Length"], str((1024 * 1024 * 2) + 13))
        self.assertEqual([len(chunk) for chunk in connection.sent], [1024 * 1024, 1024 * 1024, 13])
        self.assertTrue(connection.response.read_called)
        self.assertTrue(connection.closed)

    def test_audio_upload_rejects_invalid_or_stub_targets_and_maps_failures_without_url(self):
        client = RestStorageApiClient("https://storage.example")
        with tempfile.TemporaryDirectory() as tmp:
            audio_path = Path(tmp) / "audio.webm"
            audio_path.write_bytes(b"a")
            for url in ("stub://opaque", "http://stf1nt.blob.core.windows.net/a", "https://evilblob.core.windows.net/a", "https://user@stf1nt.blob.core.windows.net/a#fragment"):
                with self.assertRaises(StorageApiContractError) as invalid:
                    client.upload_audio_to_grant(AudioUploadGrant(**dict(GRANT, upload_url=url)), audio_path)
                self.assertNotIn(url, str(invalid.exception))

            failed_connection = _BlobConnection("stf1nt.blob.core.windows.net", status=500)
            failing = RestStorageApiClient("https://storage.example", connection_factory=lambda *args, **kwargs: failed_connection)
            with self.assertRaises(StorageApiUnavailable) as rejected:
                failing.upload_audio_to_grant(AudioUploadGrant(**GRANT), audio_path)
            self.assertNotIn(GRANT["upload_url"], str(rejected.exception))
            self.assertTrue(failed_connection.closed)

            with self.assertRaises(StorageApiUnavailable):
                client.upload_audio_to_grant(AudioUploadGrant(**GRANT), Path(tmp) / "missing.webm")

    def test_audio_upload_malformed_https_target_never_leaks_sas_in_error(self):
        malformed_url = "https://acct.blob.core.windows.net/bad path?sig=TOPSECRET"
        with tempfile.TemporaryDirectory() as tmp:
            audio_path = Path(tmp) / "audio.webm"
            audio_path.write_bytes(b"a")
            with self.assertRaises(StorageApiError) as error:
                RestStorageApiClient("https://storage.example").upload_audio_to_grant(
                    AudioUploadGrant(**dict(GRANT, upload_url=malformed_url)),
                    audio_path,
                )

        self.assertNotIn("TOPSECRET", str(error.exception))
        self.assertNotIn(malformed_url, str(error.exception))


class StubMeetingDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.client = StubStorageApiClient()
        self._clear_meetings()

    def tearDown(self):
        self._clear_meetings()

    def _clear_meetings(self):
        directory = central_meetings_dir()
        if directory.exists():
            for path in sorted(directory.rglob("*"), reverse=True):
                if path.is_file():
                    path.unlink()
                elif path.is_dir():
                    path.rmdir()
            directory.rmdir()

    def test_stub_writes_export_then_history_on_update_and_copies_granted_audio(self):
        first = self.client.upload_meeting_export(MEETING_ID, TIME_BASIS, {"revision": 1}, None)
        second = self.client.upload_meeting_export(MEETING_ID, TIME_BASIS, {"revision": 2}, None)
        meeting_dir = central_meetings_dir() / str(MEETING_ID)

        self.assertEqual(first.revision, "created")
        self.assertEqual(second.revision, "updated")
        self.assertEqual(json.loads((meeting_dir / "meeting.json").read_text(encoding="utf-8")), {"revision": 2})
        history = list((meeting_dir / "history").glob("*.json"))
        self.assertEqual(len(history), 1)
        self.assertEqual(json.loads(history[0].read_text(encoding="utf-8")), {"revision": 1})

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.webm"
            source.write_bytes(b"recording")
            grant = self.client.request_audio_upload_sas(MEETING_ID, TIME_BASIS, None)
            self.client.upload_audio_to_grant(grant, source)
        self.assertEqual((meeting_dir / "audio.webm").read_bytes(), b"recording")

    def test_stub_fail_next_applies_to_new_delivery_operations(self):
        self.client.fail_next = True
        with self.assertRaises(StorageApiError):
            self.client.upload_meeting_export(MEETING_ID, TIME_BASIS, {}, None)
        grant = self.client.request_audio_upload_sas(MEETING_ID, TIME_BASIS, None)
        self.client.fail_next = True
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.webm"
            source.write_bytes(b"recording")
            with self.assertRaises(StorageApiError):
                self.client.upload_audio_to_grant(grant, source)
