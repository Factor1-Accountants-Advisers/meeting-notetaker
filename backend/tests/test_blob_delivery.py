import asyncio
import json
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import get_type_hints
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from fastapi import HTTPException

import tests.conftest_env  # noqa: F401

from app import store
from app.main import create_app
from app.paths import snapshot_path
from app.schemas import (
    AccessRole,
    ActionItem,
    ActionItemStatus,
    ActionItemUpdate,
    BlobStatus,
    EditSegmentRequest,
    Meeting,
    MeetingAccessEntry,
    MeetingParticipant,
    MeetingSource,
    MeetingStatus,
    NameSpeakerRequest,
    PipelineStage,
    PipelineStatus,
    TranscriptSegment,
)
from app.routers import meetings as meetings_router
from app.routers import action_items as action_items_router
from app.services import blob_delivery
from app.services import pipeline
from app.services.blob_delivery import (
    deliver_meeting_to_blob,
    kick_blob_delivery,
    meeting_time_basis_utc,
    reconcile_interrupted_blob_deliveries,
)
from app.services.failure_reasons import FailureCategory, USER_SENTENCES
from app.services.storage_api import AudioUploadGrant, StorageApiUnavailable


def _meeting(**updates) -> Meeting:
    values = {
        "id": uuid4(),
        "title": "Blob delivery test",
        "source": MeetingSource.online,
        "owner_id": "owner",
        "created_at": datetime(2026, 7, 27, 3, 4, tzinfo=timezone.utc),
    }
    values.update(updates)
    return Meeting(**values)


def _export_payload(meeting_id, scheduled_start="2026-07-27T13:30:00+10:00"):
    return {
        "meeting_id": str(meeting_id),
        "meeting_type": "internal",
        "meeting_name": "Blob delivery test",
        "organiser_name": None,
        "organiser_email": None,
        "scheduled_start": scheduled_start,
        "actual_duration_seconds": 60,
        "full_invitee_list": [],
        "meeting_description": None,
        "transcript": [],
        "summary": "Private summary",
        "key_points": [],
        "action_items": [],
        "follow_ups": [],
        "schema_version": "1.0",
        "graph_event_id": None,
        "graph_ical_uid": None,
        "graph_online_meeting_id": None,
    }


class _AsgiResponse:
    def __init__(self, status_code: int, body: bytes):
        self.status_code = status_code
        self.text = body.decode("utf-8")

    def json(self):
        return json.loads(self.text)


async def _asgi_post(app, path: str, headers: dict[str, str]) -> _AsgiResponse:
    request_sent = False
    messages = []

    async def receive():
        nonlocal request_sent
        if not request_sent:
            request_sent = True
            return {"type": "http.request", "body": b"", "more_body": False}
        return {"type": "http.disconnect"}

    async def send(message):
        messages.append(message)

    encoded_headers = [
        (name.lower().encode("latin-1"), value.encode("latin-1"))
        for name, value in headers.items()
    ]
    await app(
        {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": path,
            "raw_path": path.encode("ascii"),
            "query_string": b"",
            "headers": encoded_headers,
            "client": ("test", 50000),
            "server": ("testserver", 80),
            "root_path": "",
        },
        receive,
        send,
    )
    status_code = next(message["status"] for message in messages if message["type"] == "http.response.start")
    body = b"".join(
        message.get("body", b"")
        for message in messages
        if message["type"] == "http.response.body"
    )
    return _AsgiResponse(status_code, body)


class CaptureStorageClient:
    def __init__(self, fail_stage=None, unexpected=False):
        self.calls = []
        self.fail_stage = fail_stage
        self.unexpected = unexpected

    def _maybe_fail(self, stage):
        if self.fail_stage == stage:
            if self.unexpected:
                raise AssertionError("secret-token https://blob.example?sig=secret")
            raise OSError("private path or provider details")

    def request_audio_upload_sas(self, meeting_id, time_basis_utc, access_token):
        self.calls.append(("sas", meeting_id, time_basis_utc, access_token))
        self._maybe_fail("sas")
        return AudioUploadGrant(
            upload_url="stub://opaque-secret",
            blob_path="private/blob/path",
            expires_at=datetime(2026, 7, 27, 4, 0, tzinfo=timezone.utc),
        )

    def upload_audio_to_grant(self, grant, audio_path):
        self.calls.append(("audio", grant, audio_path))
        self._maybe_fail("audio")

    def upload_meeting_export(
        self,
        meeting_id,
        time_basis_utc,
        export_payload,
        access_token,
    ):
        self.calls.append(
            ("export", meeting_id, time_basis_utc, export_payload, access_token)
        )
        self._maybe_fail("export")


class BlockingExportClient(CaptureStorageClient):
    def __init__(self):
        super().__init__()
        self.guard = threading.Lock()
        self.first_entered = threading.Event()
        self.release = threading.Event()
        self.active = 0
        self.max_active = 0

    def upload_meeting_export(
        self,
        meeting_id,
        time_basis_utc,
        export_payload,
        access_token,
    ):
        with self.guard:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            self.first_entered.set()
        try:
            self.release.wait(timeout=5)
            super().upload_meeting_export(
                meeting_id,
                time_basis_utc,
                export_payload,
                access_token,
            )
        finally:
            with self.guard:
                self.active -= 1


class BlockingAudioClient(CaptureStorageClient):
    def __init__(self):
        super().__init__()
        self.audio_started = threading.Event()
        self.release = threading.Event()
        self.audio_path = None
        self.audio_bytes = None

    def upload_audio_to_grant(self, grant, audio_path):
        self.calls.append(("audio", grant, audio_path))
        self.audio_path = audio_path
        self.audio_bytes = audio_path.read_bytes()
        self.audio_started.set()
        self.release.wait(timeout=5)


class BlobStateSchemaTests(unittest.TestCase):
    def test_enum_and_meeting_defaults(self):
        meeting = _meeting()

        self.assertEqual(
            [status.value for status in BlobStatus],
            ["pending", "uploaded", "failed"],
        )
        self.assertEqual(meeting.blob_status, BlobStatus.pending)
        self.assertIsNone(meeting.blob_error_message)

    def test_legacy_snapshot_without_blob_fields_loads_with_defaults(self):
        old_meetings = dict(store.MEETINGS)
        old_markers = dict(store.BLOB_DELIVERY_STARTED_AT)
        old_snapshot = snapshot_path().read_bytes() if snapshot_path().exists() else None
        meeting = _meeting()
        try:
            store.MEETINGS.clear()
            store.BLOB_DELIVERY_STARTED_AT.clear()
            store.MEETINGS[meeting.id] = meeting
            store.save_snapshot()
            raw = json.loads(snapshot_path().read_text(encoding="utf-8"))
            raw["meetings"][str(meeting.id)].pop("blob_status")
            raw["meetings"][str(meeting.id)].pop("blob_error_message")
            raw.pop("blob_delivery_started_at")
            snapshot_path().write_text(json.dumps(raw), encoding="utf-8")

            store.MEETINGS.clear()
            store.BLOB_DELIVERY_STARTED_AT[uuid4()] = datetime.now(timezone.utc)
            self.assertTrue(store.load_snapshot())
            loaded = store.MEETINGS[meeting.id]
            self.assertEqual(loaded.blob_status, BlobStatus.pending)
            self.assertIsNone(loaded.blob_error_message)
            self.assertEqual(store.BLOB_DELIVERY_STARTED_AT, {})
        finally:
            store.MEETINGS.clear()
            store.MEETINGS.update(old_meetings)
            store.BLOB_DELIVERY_STARTED_AT.clear()
            store.BLOB_DELIVERY_STARTED_AT.update(old_markers)
            if old_snapshot is None:
                snapshot_path().unlink(missing_ok=True)
            else:
                snapshot_path().write_bytes(old_snapshot)

    def test_blob_delivery_started_markers_round_trip_in_snapshot(self):
        old_markers = dict(store.BLOB_DELIVERY_STARTED_AT)
        old_snapshot = snapshot_path().read_bytes() if snapshot_path().exists() else None
        meeting_id = uuid4()
        started_at = datetime(2026, 7, 27, 4, 5, tzinfo=timezone.utc)
        try:
            store.BLOB_DELIVERY_STARTED_AT.clear()
            store.BLOB_DELIVERY_STARTED_AT[meeting_id] = started_at
            store.save_snapshot()

            store.BLOB_DELIVERY_STARTED_AT.clear()
            self.assertTrue(store.load_snapshot())
            self.assertEqual(
                store.BLOB_DELIVERY_STARTED_AT,
                {meeting_id: started_at},
            )
        finally:
            store.BLOB_DELIVERY_STARTED_AT.clear()
            store.BLOB_DELIVERY_STARTED_AT.update(old_markers)
            if old_snapshot is None:
                snapshot_path().unlink(missing_ok=True)
            else:
                snapshot_path().write_bytes(old_snapshot)


class BlobTimeBasisTests(unittest.TestCase):
    def test_scheduled_start_with_offset_is_preferred_and_normalized_to_utc(self):
        meeting = _meeting(
            created_at=datetime(2026, 1, 2, 3, 4, tzinfo=timezone.utc),
        )

        result = meeting_time_basis_utc(
            meeting,
            {"scheduled_start": "2026-07-27T13:30:00+10:00"},
        )

        self.assertEqual(result, datetime(2026, 7, 27, 3, 30, tzinfo=timezone.utc))
        self.assertIs(result.tzinfo, timezone.utc)

    def test_invalid_or_naive_scheduled_start_falls_back_to_created_at(self):
        aware_created = datetime(
            2026,
            7,
            27,
            12,
            30,
            tzinfo=timezone(timedelta(hours=8)),
        )
        for scheduled in ("not-a-date", "2026-07-27T13:30:00", None):
            with self.subTest(scheduled=scheduled):
                result = meeting_time_basis_utc(
                    _meeting(created_at=aware_created),
                    {"scheduled_start": scheduled},
                )
                self.assertEqual(
                    result,
                    datetime(2026, 7, 27, 4, 30, tzinfo=timezone.utc),
                )

    def test_legacy_naive_created_at_is_treated_as_utc(self):
        result = meeting_time_basis_utc(
            _meeting(created_at=datetime(2026, 7, 27, 3, 4)),
            {"scheduled_start": None},
        )

        self.assertEqual(result, datetime(2026, 7, 27, 3, 4, tzinfo=timezone.utc))


class BlobDeliveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.old_state = {
            "meetings": dict(store.MEETINGS),
            "exports": dict(store.MEETING_EXPORTS),
            "audit": list(store.AUDIT_LOG),
            "blob_started": dict(store.BLOB_DELIVERY_STARTED_AT),
        }
        store.MEETINGS.clear()
        store.MEETING_EXPORTS.clear()
        store.AUDIT_LOG.clear()
        store.BLOB_DELIVERY_STARTED_AT.clear()
        self.temporary = tempfile.TemporaryDirectory()
        self.audio_root = Path(self.temporary.name)
        self.audio_patch = patch(
            "app.services.blob_delivery.audio_dir",
            return_value=self.audio_root,
        )
        self.audio_patch.start()
        self.settings = SimpleNamespace(
            storage_api_enabled=True,
            storage_api_url="https://storage.example",
        )
        self.settings_patch = patch(
            "app.services.blob_delivery.get_settings",
            return_value=self.settings,
        )
        self.settings_patch.start()
        self.meeting = _meeting(
            pipeline_status=PipelineStatus.ready,
            pipeline_stage=PipelineStage.ready,
            status=MeetingStatus.finalized,
            action_item_count=2,
            unknown_speaker_count=0,
            processing_attempt=3,
            delivery_error_message="email state",
            blob_status=BlobStatus.failed,
            blob_error_message="old error",
        )
        store.MEETINGS[self.meeting.id] = self.meeting
        store.MEETING_EXPORTS[self.meeting.id] = _export_payload(self.meeting.id)
        self.audio_path = self.audio_root / f"{self.meeting.id}.webm"
        self.audio_path.write_bytes(b"private audio")

    def tearDown(self):
        self.settings_patch.stop()
        self.audio_patch.stop()
        self.temporary.cleanup()
        store.MEETINGS.clear()
        store.MEETINGS.update(self.old_state["meetings"])
        store.MEETING_EXPORTS.clear()
        store.MEETING_EXPORTS.update(self.old_state["exports"])
        store.AUDIT_LOG[:] = self.old_state["audit"]
        store.BLOB_DELIVERY_STARTED_AT.clear()
        store.BLOB_DELIVERY_STARTED_AT.update(self.old_state["blob_started"])

    async def _deliver(self, client, include_audio=True, token="access-token"):
        return await deliver_meeting_to_blob(
            self.meeting.id,
            access_token=token,
            actor="Joseph",
            include_audio=include_audio,
            client=client,
        )

    async def test_unknown_meeting_returns_none_without_side_effects(self):
        client = CaptureStorageClient()
        unknown_id = uuid4()

        with patch("app.services.blob_delivery.store.save_snapshot") as save:
            result = await deliver_meeting_to_blob(
                unknown_id,
                access_token="access-token",
                actor="Joseph",
                include_audio=True,
                client=client,
            )

        self.assertIsNone(result)
        self.assertEqual(
            get_type_hints(deliver_meeting_to_blob)["return"],
            Meeting | None,
        )
        self.assertEqual(client.calls, [])
        self.assertEqual(store.AUDIT_LOG, [])
        save.assert_not_called()

    async def test_full_delivery_orders_sas_audio_then_export(self):
        client = CaptureStorageClient()

        result = await self._deliver(client)

        self.assertEqual([call[0] for call in client.calls], ["sas", "audio", "export"])
        expected_time = datetime(2026, 7, 27, 3, 30, tzinfo=timezone.utc)
        self.assertEqual(client.calls[0][2], expected_time)
        self.assertNotEqual(client.calls[1][2], self.audio_path)
        self.assertEqual(client.calls[2][2], expected_time)
        self.assertEqual(client.calls[2][3], store.MEETING_EXPORTS[self.meeting.id])
        self.assertIsNot(client.calls[2][3], store.MEETING_EXPORTS[self.meeting.id])
        self.assertEqual(result.blob_status, BlobStatus.uploaded)
        self.assertIsNone(result.blob_error_message)

    async def test_concurrent_deliveries_serialize_provider_operations(self):
        client = BlockingExportClient()
        with patch("app.services.blob_delivery.store.save_snapshot"):
            first = asyncio.create_task(
                self._deliver(client, include_audio=False)
            )
            self.assertTrue(
                await asyncio.to_thread(client.first_entered.wait, 2)
            )
            second = asyncio.create_task(
                self._deliver(client, include_audio=False)
            )
            await asyncio.sleep(0.1)
            observed_max = client.max_active
            client.release.set()
            await asyncio.gather(first, second)

        self.assertEqual(observed_max, 1)
        self.assertEqual(client.max_active, 1)
        self.assertEqual(
            [call[0] for call in client.calls],
            ["export", "export"],
        )

    async def test_audio_uses_unique_snapshot_then_cleans_it(self):
        client = BlockingAudioClient()
        client.release.set()

        result = await self._deliver(client)

        self.assertEqual(result.blob_status, BlobStatus.uploaded)
        self.assertIsNotNone(client.audio_path)
        self.assertNotEqual(client.audio_path, self.audio_path)
        self.assertEqual(client.audio_path.suffix, ".webm")
        self.assertEqual(client.audio_bytes, b"private audio")
        self.assertFalse(client.audio_path.exists())

    async def test_reprocessing_during_audio_aborts_stale_run(self):
        client = BlockingAudioClient()
        with patch("app.services.blob_delivery.store.save_snapshot"):
            task = asyncio.create_task(self._deliver(client))
            self.assertTrue(
                await asyncio.to_thread(client.audio_started.wait, 2)
            )
            replacement = self.meeting.model_copy(
                update={
                    "processing_attempt": self.meeting.processing_attempt + 1,
                    "pipeline_status": PipelineStatus.processing,
                    "blob_status": BlobStatus.pending,
                    "blob_error_message": None,
                }
            )
            store.MEETINGS[self.meeting.id] = replacement
            store.MEETING_EXPORTS[self.meeting.id] = _export_payload(
                self.meeting.id,
                scheduled_start=None,
            )
            store.MEETING_EXPORTS[self.meeting.id]["summary"] = (
                "Replacement processing output"
            )
            client.release.set()
            await task

        self.assertEqual(
            [call[0] for call in client.calls],
            ["sas", "audio"],
        )
        self.assertIs(store.MEETINGS[self.meeting.id], replacement)
        self.assertEqual(replacement.pipeline_status, PipelineStatus.processing)
        self.assertEqual(replacement.blob_status, BlobStatus.pending)
        self.assertIsNone(replacement.blob_error_message)
        self.assertNotIn(self.meeting.id, store.BLOB_DELIVERY_STARTED_AT)
        self.assertFalse(client.audio_path.exists())

    async def test_export_payload_is_frozen_before_provider_phases(self):
        client = CaptureStorageClient()
        original_summary = store.MEETING_EXPORTS[self.meeting.id]["summary"]

        def mutate_after_freeze(meeting_id, time_basis_utc, access_token):
            client.calls.append(
                ("sas", meeting_id, time_basis_utc, access_token)
            )
            store.MEETING_EXPORTS[meeting_id]["summary"] = "New generation"
            return AudioUploadGrant(
                upload_url="stub://opaque-secret",
                blob_path="private/blob/path",
                expires_at=datetime(2026, 7, 27, 4, 0, tzinfo=timezone.utc),
            )

        client.request_audio_upload_sas = mutate_after_freeze

        await self._deliver(client)

        export_call = client.calls[-1]
        self.assertEqual(export_call[0], "export")
        self.assertEqual(export_call[3]["summary"], original_summary)

    async def test_json_only_delivery_skips_audio_operations(self):
        client = CaptureStorageClient()

        await self._deliver(client, include_audio=False)

        self.assertEqual([call[0] for call in client.calls], ["export"])
        self.assertEqual(self.meeting.blob_status, BlobStatus.uploaded)

    async def test_configured_storage_without_token_fails_before_provider_call(self):
        client = CaptureStorageClient()

        with self.assertLogs("app.services.failure_reasons", level="WARNING") as captured:
            result = await self._deliver(client, token="   ")

        self.assertEqual(client.calls, [])
        self.assertEqual(result.blob_status, BlobStatus.failed)
        self.assertEqual(result.blob_error_code, "azure_signin")
        self.assertEqual(
            result.blob_error_message,
            USER_SENTENCES[FailureCategory.azure_signin],
        )
        self.assertTrue(
            any(
                "delivery_failure" in line and "stage=blob" in line
                for line in captured.output
            )
        )

    async def test_disabled_storage_skips_without_mutating_or_calling_provider(self):
        self.settings.storage_api_enabled = False
        client = CaptureStorageClient()
        before = self.meeting.model_dump()

        result = await self._deliver(client)

        self.assertIs(result, self.meeting)
        self.assertEqual(client.calls, [])
        self.assertEqual(result.model_dump(), before)
        self.assertEqual(store.AUDIT_LOG, [])

    async def test_stub_mode_allows_missing_token(self):
        self.settings.storage_api_url = ""
        client = CaptureStorageClient()

        result = await self._deliver(client, include_audio=False, token=None)

        self.assertEqual([call[0] for call in client.calls], ["export"])
        self.assertEqual(result.blob_status, BlobStatus.uploaded)

    async def test_unready_or_missing_export_uses_fixed_prerequisite_failure(self):
        cases = ("unready", "missing-export")
        for case in cases:
            with self.subTest(case=case):
                self.meeting.pipeline_status = PipelineStatus.processing
                if case == "missing-export":
                    self.meeting.pipeline_status = PipelineStatus.ready
                    store.MEETING_EXPORTS.pop(self.meeting.id)
                client = CaptureStorageClient()

                result = await self._deliver(client)

                self.assertEqual(client.calls, [])
                self.assertEqual(result.blob_status, BlobStatus.failed)
                self.assertEqual(result.blob_error_code, "processing_error")
                self.assertEqual(
                    result.blob_error_message,
                    USER_SENTENCES[FailureCategory.processing_error],
                )
                self.meeting.pipeline_status = PipelineStatus.ready
                store.MEETING_EXPORTS[self.meeting.id] = _export_payload(
                    self.meeting.id
                )

    async def test_missing_audio_fails_before_requesting_sas(self):
        self.audio_path.unlink()
        client = CaptureStorageClient()

        result = await self._deliver(client)

        self.assertEqual(client.calls, [])
        self.assertEqual(result.blob_status, BlobStatus.failed)
        self.assertEqual(result.blob_error_code, "processing_error")
        self.assertEqual(
            result.blob_error_message,
            USER_SENTENCES[FailureCategory.processing_error],
        )

    async def test_audio_filesystem_error_classifies_as_processing_error(self):
        client = CaptureStorageClient()
        with patch(
            "app.services.blob_delivery.audio_dir",
            side_effect=PermissionError("private filesystem path"),
        ):
            result = await self._deliver(client)

        self.assertEqual(client.calls, [])
        self.assertEqual(result.blob_status, BlobStatus.failed)
        self.assertEqual(result.blob_error_code, "processing_error")
        self.assertEqual(
            result.blob_error_message,
            USER_SENTENCES[FailureCategory.processing_error],
        )

    async def test_audio_failure_stops_before_export(self):
        client = CaptureStorageClient(fail_stage="audio")

        result = await self._deliver(client)

        self.assertEqual([call[0] for call in client.calls], ["sas", "audio"])
        self.assertEqual(result.blob_status, BlobStatus.failed)
        self.assertEqual(result.blob_error_code, "network")
        self.assertEqual(
            result.blob_error_message,
            USER_SENTENCES[FailureCategory.network],
        )

    async def test_json_failure_happens_after_audio_and_uses_record_failure(self):
        client = CaptureStorageClient(fail_stage="export")

        result = await self._deliver(client)

        self.assertEqual([call[0] for call in client.calls], ["sas", "audio", "export"])
        self.assertEqual(result.blob_status, BlobStatus.failed)
        self.assertEqual(result.blob_error_code, "network")
        self.assertEqual(
            result.blob_error_message,
            USER_SENTENCES[FailureCategory.network],
        )

    async def test_export_connection_error_classifies_as_network_failure(self):
        client = CaptureStorageClient()

        def _raise_connection_error(*args, **kwargs):
            raise ConnectionError("network down")

        client.upload_meeting_export = _raise_connection_error

        with self.assertLogs("app.services.failure_reasons", level="WARNING") as captured:
            result = await self._deliver(client, include_audio=False)

        self.assertEqual(result.blob_status, BlobStatus.failed)
        self.assertEqual(result.blob_error_code, "network")
        self.assertEqual(
            result.blob_error_message,
            USER_SENTENCES[FailureCategory.network],
        )
        self.assertNotIn("network down", result.blob_error_message)
        self.assertTrue(
            any(
                "delivery_failure" in line and "stage=blob" in line
                for line in captured.output
            )
        )

    async def test_audio_storage_unavailable_classifies_as_service_unavailable(self):
        client = CaptureStorageClient()

        def _raise_unavailable(*args, **kwargs):
            raise StorageApiUnavailable(
                "blob storage was unavailable for audio upload"
            )

        client.upload_audio_to_grant = _raise_unavailable

        with self.assertLogs("app.services.failure_reasons", level="WARNING") as captured:
            result = await self._deliver(client)

        self.assertEqual(result.blob_status, BlobStatus.failed)
        self.assertEqual(result.blob_error_code, "service_unavailable")
        self.assertEqual(
            result.blob_error_message,
            USER_SENTENCES[FailureCategory.service_unavailable],
        )
        self.assertTrue(
            any(
                "delivery_failure" in line and "stage=blob" in line
                for line in captured.output
            )
        )

    async def test_unexpected_error_never_escapes_and_audit_contains_no_secrets(self):
        private_values = [
            "secret-token",
            "sig=secret",
            "private/blob/path",
            "Private summary",
            "private audio",
        ]
        client = CaptureStorageClient(fail_stage="audio", unexpected=True)

        result = await self._deliver(client, token="secret-token")

        self.assertEqual(result.blob_status, BlobStatus.failed)
        audit = store.AUDIT_LOG[-1]
        self.assertEqual(audit.action, "meeting.blob_upload_failed")
        self.assertEqual(audit.actor, "Joseph")
        self.assertEqual(audit.target, self.meeting.title)
        self.assertEqual(audit.before, BlobStatus.pending.value)
        self.assertEqual(audit.after, BlobStatus.failed.value)
        serialized = audit.model_dump_json()
        for private in private_values:
            self.assertNotIn(private, serialized)

    async def test_success_audit_and_non_blob_outputs_are_untouched(self):
        before = self.meeting.model_dump(
            exclude={"blob_status", "blob_error_message"}
        )

        result = await self._deliver(CaptureStorageClient(), include_audio=False)

        self.assertEqual(
            result.model_dump(exclude={"blob_status", "blob_error_message"}),
            before,
        )
        audit = store.AUDIT_LOG[-1]
        self.assertEqual(audit.action, "meeting.blob_upload")
        self.assertEqual(audit.before, BlobStatus.pending.value)
        self.assertEqual(audit.after, BlobStatus.uploaded.value)
        self.assertEqual(audit.meeting_id, self.meeting.id)

    async def test_pending_and_terminal_states_are_snapshotted_and_round_trip(self):
        real_save = store.save_snapshot
        with patch("app.services.blob_delivery.store.save_snapshot") as save:
            result = await self._deliver(
                CaptureStorageClient(),
                include_audio=False,
            )
        self.assertEqual(save.call_count, 2)

        old_snapshot = (
            snapshot_path().read_bytes() if snapshot_path().exists() else None
        )
        try:
            real_save()
            store.MEETINGS.clear()
            self.assertTrue(store.load_snapshot())
            loaded = store.MEETINGS[result.id]
            self.assertEqual(loaded.blob_status, BlobStatus.uploaded)
            self.assertIsNone(loaded.blob_error_message)
        finally:
            if old_snapshot is None:
                snapshot_path().unlink(missing_ok=True)
            else:
                snapshot_path().write_bytes(old_snapshot)

    async def test_started_marker_is_present_in_pending_snapshot_and_cleared_terminally(self):
        marker_snapshots = []

        def capture_marker():
            marker_snapshots.append(dict(store.BLOB_DELIVERY_STARTED_AT))

        with patch(
            "app.services.blob_delivery.store.save_snapshot",
            side_effect=capture_marker,
        ):
            result = await self._deliver(
                CaptureStorageClient(),
                include_audio=False,
            )

        self.assertEqual(result.blob_status, BlobStatus.uploaded)
        self.assertIn(self.meeting.id, marker_snapshots[0])
        self.assertEqual(
            marker_snapshots[0][self.meeting.id].tzinfo,
            timezone.utc,
        )
        self.assertNotIn(self.meeting.id, marker_snapshots[-1])
        self.assertNotIn(self.meeting.id, store.BLOB_DELIVERY_STARTED_AT)


class BlobDeliveryLauncherTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.old_meetings = dict(store.MEETINGS)
        self.old_markers = dict(store.BLOB_DELIVERY_STARTED_AT)
        store.MEETINGS.clear()
        store.BLOB_DELIVERY_STARTED_AT.clear()
        self.meeting = _meeting(
            pipeline_status=PipelineStatus.ready,
            blob_status=BlobStatus.failed,
            blob_error_message="previous failure",
        )
        store.MEETINGS[self.meeting.id] = self.meeting
        self.settings = SimpleNamespace(
            storage_api_enabled=True,
            storage_api_url="",
        )

    async def asyncTearDown(self):
        pending = list(blob_delivery._BLOB_DELIVERY_TASKS)
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        blob_delivery._BLOB_DELIVERY_TASKS.clear()
        store.MEETINGS.clear()
        store.MEETINGS.update(self.old_meetings)
        store.BLOB_DELIVERY_STARTED_AT.clear()
        store.BLOB_DELIVERY_STARTED_AT.update(self.old_markers)

    async def test_kick_sets_pending_synchronously_and_retains_task_until_done(self):
        release = asyncio.Event()

        async def held_delivery(*args, **kwargs):
            await release.wait()
            return self.meeting

        with (
            patch(
                "app.services.blob_delivery.get_settings",
                return_value=self.settings,
            ),
            patch(
                "app.services.blob_delivery.deliver_meeting_to_blob",
                side_effect=held_delivery,
            ) as deliver,
            patch("app.services.blob_delivery.store.save_snapshot") as save,
        ):
            task = kick_blob_delivery(
                self.meeting.id,
                access_token=None,
                actor="Joseph",
                include_audio=False,
            )

            self.assertIsNotNone(task)
            self.assertEqual(self.meeting.blob_status, BlobStatus.pending)
            self.assertIsNone(self.meeting.blob_error_message)
            self.assertIn(task, blob_delivery._BLOB_DELIVERY_TASKS)
            save.assert_called_once_with()
            await asyncio.sleep(0)
            deliver.assert_called_once()
            release.set()
            await task
            await asyncio.sleep(0)
            self.assertNotIn(task, blob_delivery._BLOB_DELIVERY_TASKS)

    async def test_disabled_kick_does_not_schedule_or_mutate(self):
        self.settings.storage_api_enabled = False
        before = self.meeting.model_dump()
        with (
            patch(
                "app.services.blob_delivery.get_settings",
                return_value=self.settings,
            ),
            patch(
                "app.services.blob_delivery.deliver_meeting_to_blob",
            ) as deliver,
        ):
            task = kick_blob_delivery(
                self.meeting.id,
                access_token=None,
                actor="Joseph",
                include_audio=False,
            )

        self.assertIsNone(task)
        self.assertEqual(self.meeting.model_dump(), before)
        deliver.assert_not_called()
        self.assertEqual(blob_delivery._BLOB_DELIVERY_TASKS, set())


class BlobDeliveryReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.old_meetings = dict(store.MEETINGS)
        self.old_markers = dict(store.BLOB_DELIVERY_STARTED_AT)
        store.MEETINGS.clear()
        store.BLOB_DELIVERY_STARTED_AT.clear()

    def tearDown(self):
        store.MEETINGS.clear()
        store.MEETINGS.update(self.old_meetings)
        store.BLOB_DELIVERY_STARTED_AT.clear()
        store.BLOB_DELIVERY_STARTED_AT.update(self.old_markers)

    def test_startup_reconcile_marks_only_ready_pending_blob_delivery_failed(self):
        ready_pending = _meeting(
            pipeline_status=PipelineStatus.ready,
            blob_status=BlobStatus.pending,
            action_item_count=4,
        )
        legacy_ready_pending = _meeting(
            pipeline_status=PipelineStatus.ready,
            blob_status=BlobStatus.pending,
        )
        untouched = [
            legacy_ready_pending,
            _meeting(
                pipeline_status=PipelineStatus.ready,
                blob_status=BlobStatus.uploaded,
            ),
            _meeting(
                pipeline_status=PipelineStatus.pending_audio,
                blob_status=BlobStatus.pending,
            ),
            _meeting(
                pipeline_status=PipelineStatus.queued,
                blob_status=BlobStatus.pending,
            ),
            _meeting(
                pipeline_status=PipelineStatus.processing,
                blob_status=BlobStatus.pending,
            ),
        ]
        store.MEETINGS[ready_pending.id] = ready_pending
        store.BLOB_DELIVERY_STARTED_AT[ready_pending.id] = datetime(
            2026,
            7,
            27,
            4,
            5,
            tzinfo=timezone.utc,
        )
        for meeting in untouched:
            store.MEETINGS[meeting.id] = meeting
        untouched_before = {
            meeting.id: meeting.model_dump() for meeting in untouched
        }

        with self.assertLogs(
            "app.services.failure_reasons", level="WARNING"
        ) as captured, patch(
            "app.services.blob_delivery.store.save_snapshot"
        ) as save:
            changed = reconcile_interrupted_blob_deliveries()

        self.assertEqual(changed, 1)
        self.assertEqual(ready_pending.blob_status, BlobStatus.failed)
        self.assertEqual(ready_pending.blob_error_code, "interrupted")
        self.assertEqual(
            ready_pending.blob_error_message,
            USER_SENTENCES[FailureCategory.interrupted],
        )
        self.assertEqual(ready_pending.pipeline_status, PipelineStatus.ready)
        self.assertEqual(ready_pending.action_item_count, 4)
        self.assertNotIn(ready_pending.id, store.BLOB_DELIVERY_STARTED_AT)
        save.assert_called_once_with()
        self.assertTrue(
            any(
                "delivery_failure" in line
                and "stage=blob" in line
                and "code=startup_reconcile" in line
                for line in captured.output
            )
        )
        for meeting in untouched:
            self.assertEqual(meeting.model_dump(), untouched_before[meeting.id])


class BlobDeliveryTriggerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.old_state = {
            "meetings": dict(store.MEETINGS),
            "access": {key: list(value) for key, value in store.ACCESS.items()},
            "exports": dict(store.MEETING_EXPORTS),
            "transcripts": {key: list(value) for key, value in store.TRANSCRIPTS.items()},
            "participants": {key: list(value) for key, value in store.PARTICIPANTS.items()},
            "summaries": dict(store.SUMMARIES),
            "summary_html": dict(store.SUMMARY_HTML),
            "actions": dict(store.ACTION_ITEMS),
            "audit": list(store.AUDIT_LOG),
            "blob_started": dict(store.BLOB_DELIVERY_STARTED_AT),
        }
        store.MEETINGS.clear()
        store.ACCESS.clear()
        store.MEETING_EXPORTS.clear()
        store.TRANSCRIPTS.clear()
        store.PARTICIPANTS.clear()
        store.SUMMARIES.clear()
        store.SUMMARY_HTML.clear()
        store.ACTION_ITEMS.clear()
        store.AUDIT_LOG.clear()
        store.BLOB_DELIVERY_STARTED_AT.clear()

    def tearDown(self):
        for name, target in (
            ("meetings", store.MEETINGS),
            ("access", store.ACCESS),
            ("exports", store.MEETING_EXPORTS),
            ("transcripts", store.TRANSCRIPTS),
            ("participants", store.PARTICIPANTS),
            ("summaries", store.SUMMARIES),
            ("summary_html", store.SUMMARY_HTML),
            ("actions", store.ACTION_ITEMS),
            ("blob_started", store.BLOB_DELIVERY_STARTED_AT),
        ):
            target.clear()
            target.update(self.old_state[name])
        store.AUDIT_LOG[:] = self.old_state["audit"]

    def _ready_meeting(self, *, blob_status=BlobStatus.pending) -> Meeting:
        meeting = _meeting(
            pipeline_status=PipelineStatus.ready,
            pipeline_stage=PipelineStage.ready,
            unknown_speaker_count=0,
            blob_status=blob_status,
        )
        store.MEETINGS[meeting.id] = meeting
        store.ACCESS[meeting.id] = [
            MeetingAccessEntry(user="Joseph", role=AccessRole.owner),
            MeetingAccessEntry(user="Editor", role=AccessRole.editor),
            MeetingAccessEntry(user="Viewer", role=AccessRole.viewer),
        ]
        return meeting

    async def test_pipeline_ready_delivers_full_export_after_refresh(self):
        meeting = _meeting(pipeline_status=PipelineStatus.queued)
        store.MEETINGS[meeting.id] = meeting

        async def delivery_side_effect(*args, **kwargs):
            self.assertIn(meeting.id, store.MEETING_EXPORTS)
            self.assertEqual(store.MEETINGS[meeting.id].pipeline_status, PipelineStatus.ready)

        deliver = AsyncMock(side_effect=delivery_side_effect)
        with patch.object(pipeline, "STAGE_DELAY_S", 0), patch(
            "app.services.pipeline.deliver_meeting_to_blob", new=deliver
        ):
            await pipeline.run_pipeline(
                meeting.id,
                Path("meeting.webm"),
                storage_token="token",
                storage_actor="Joseph",
            )

        deliver.assert_awaited_once_with(
            meeting.id,
            access_token="token",
            actor="Joseph",
            include_audio=True,
        )
        self.assertEqual(store.MEETINGS[meeting.id].pipeline_status, PipelineStatus.ready)

    async def test_unexpected_pipeline_delivery_error_preserves_ready_outputs(self):
        meeting = _meeting(pipeline_status=PipelineStatus.queued)
        store.MEETINGS[meeting.id] = meeting
        deliver = AsyncMock(side_effect=RuntimeError("unexpected delivery failure"))

        with patch.object(pipeline, "STAGE_DELAY_S", 0), patch(
            "app.services.pipeline.deliver_meeting_to_blob", new=deliver
        ), patch.object(pipeline.logger, "error"):
            await pipeline.run_pipeline(meeting.id, Path("meeting.webm"))

        self.assertEqual(store.MEETINGS[meeting.id].pipeline_status, PipelineStatus.ready)
        self.assertIn(meeting.id, store.MEETING_EXPORTS)

    async def test_reprocess_resets_blob_state_invalidates_export_and_clears_marker(self):
        meeting = self._ready_meeting(blob_status=BlobStatus.uploaded)
        meeting.blob_error_message = "old error"
        meeting.processing_attempt = 4
        store.MEETING_EXPORTS[meeting.id] = _export_payload(meeting.id)
        store.BLOB_DELIVERY_STARTED_AT[meeting.id] = datetime.now(timezone.utc)
        runner = AsyncMock()

        with patch.object(pipeline, "run_pipeline", runner):
            pipeline.kick_pipeline(
                meeting.id,
                Path("meeting.webm"),
                storage_token="token",
                storage_actor="Joseph",
                recorder_email="recorder@example.com",
            )
            await asyncio.gather(*pipeline._PIPELINE_TASKS)

        updated = store.MEETINGS[meeting.id]
        self.assertEqual(updated.processing_attempt, 5)
        self.assertEqual(updated.blob_status, BlobStatus.pending)
        self.assertIsNone(updated.blob_error_message)
        self.assertNotIn(meeting.id, store.MEETING_EXPORTS)
        self.assertNotIn(meeting.id, store.BLOB_DELIVERY_STARTED_AT)
        runner.assert_awaited_once_with(
            meeting.id,
            Path("meeting.webm"),
            storage_token="token",
            storage_actor="Joseph",
            recorder_email="recorder@example.com",
        )

    async def test_finalise_refreshes_then_schedules_json_only_after_uploaded_delivery(self):
        meeting = self._ready_meeting(blob_status=BlobStatus.uploaded)
        events = []

        def refresh(meeting_id):
            self.assertEqual(store.MEETINGS[meeting_id].status, MeetingStatus.finalized)
            self.assertEqual(store.AUDIT_LOG[-1].action, "meeting.finalize")
            events.append(("refresh", meeting_id))

        with patch(
            "app.routers.meetings.refresh_meeting_export",
            side_effect=refresh,
        ), patch(
            "app.routers.meetings.kick_blob_delivery",
            side_effect=lambda *args, **kwargs: events.append(("kick", args, kwargs)),
        ):
            result = await meetings_router.finalize_meeting(
                meeting.id,
                actor="Joseph",
                storage_token=" token ",
            )

        self.assertEqual(result.status, MeetingStatus.finalized)
        self.assertEqual(events[0], ("refresh", meeting.id))
        self.assertEqual(
            events[1],
            ("kick", (meeting.id,), {"access_token": "token", "actor": "Joseph", "include_audio": False}),
        )

    async def test_finalise_uses_full_delivery_for_pending_or_failed_and_resists_launcher_errors(self):
        for blob_status in (BlobStatus.pending, BlobStatus.failed):
            with self.subTest(blob_status=blob_status):
                meeting = self._ready_meeting(blob_status=blob_status)
                with patch("app.routers.meetings.refresh_meeting_export"), patch(
                    "app.routers.meetings.kick_blob_delivery"
                ) as kick:
                    result = await meetings_router.finalize_meeting(meeting.id, actor="Joseph")
                self.assertEqual(result.status, MeetingStatus.finalized)
                self.assertEqual(kick.call_args.kwargs["include_audio"], True)

        meeting = self._ready_meeting(blob_status=BlobStatus.uploaded)
        with patch("app.routers.meetings.refresh_meeting_export"), patch(
            "app.routers.meetings.kick_blob_delivery", side_effect=RuntimeError("launch failed")
        ), patch.object(meetings_router.logger, "error"):
            result = await meetings_router.finalize_meeting(meeting.id, actor="Joseph")
        self.assertEqual(result.status, MeetingStatus.finalized)

    async def test_blob_retry_requires_ready_editor_and_returns_pending_without_sas(self):
        meeting = self._ready_meeting(blob_status=BlobStatus.failed)
        def launch_retry(*args, **kwargs):
            store.MEETINGS[meeting.id].blob_status = BlobStatus.pending
            store.MEETINGS[meeting.id].blob_error_message = None

        with patch("app.routers.meetings.kick_blob_delivery", side_effect=launch_retry) as kick:
            with self.assertRaises(HTTPException) as missing:
                await meetings_router.retry_blob_delivery(uuid4(), actor="Editor")
            self.assertEqual(missing.exception.status_code, 404)

            with self.assertRaises(HTTPException) as denied:
                await meetings_router.retry_blob_delivery(meeting.id, actor="Viewer")
            self.assertEqual(denied.exception.status_code, 403)

            store.MEETINGS[meeting.id] = meeting.model_copy(
                update={"pipeline_status": PipelineStatus.processing}
            )
            with self.assertRaises(HTTPException) as unready:
                await meetings_router.retry_blob_delivery(meeting.id, actor="Editor")
            self.assertEqual(unready.exception.status_code, 409)

            for blob_status in (BlobStatus.pending, BlobStatus.uploaded):
                with self.subTest(blob_status=blob_status):
                    store.MEETINGS[meeting.id] = meeting.model_copy(
                        update={"blob_status": blob_status}
                    )
                    audit_before = list(store.AUDIT_LOG)
                    with self.assertRaises(HTTPException) as not_failed:
                        await meetings_router.retry_blob_delivery(
                            meeting.id,
                            actor="Editor",
                            storage_token="retry-token",
                        )
                    self.assertEqual(not_failed.exception.status_code, 409)
                    self.assertEqual(store.AUDIT_LOG, audit_before)
                    self.assertEqual(store.MEETINGS[meeting.id].blob_status, blob_status)

            store.MEETINGS[meeting.id] = meeting
            result = await meetings_router.retry_blob_delivery(
                meeting.id,
                actor="Editor",
                storage_token=" retry-token ",
            )

        kick.assert_called_once_with(
            meeting.id,
            access_token="retry-token",
            actor="Editor",
            include_audio=True,
        )
        self.assertEqual(result.blob_status, BlobStatus.pending)
        self.assertNotIn("retry-token", result.model_dump_json())

    async def test_edits_refresh_local_export_without_scheduling_blob_delivery(self):
        meeting = self._ready_meeting()
        store.TRANSCRIPTS[meeting.id] = [
            TranscriptSegment(
                speaker="Speaker 1",
                speaker_known=True,
                text="before",
                start_ms=0,
                end_ms=1000,
                raw_speaker="SPEAKER_00",
            )
        ]
        with patch("app.routers.meetings.kick_blob_delivery") as kick:
            await meetings_router.edit_segment(
                meeting.id,
                0,
                EditSegmentRequest(text="after"),
                actor="Editor",
            )

        self.assertEqual(store.TRANSCRIPTS[meeting.id][0].text, "after")
        self.assertIn(meeting.id, store.MEETING_EXPORTS)
        kick.assert_not_called()

    async def test_naming_and_action_mutations_refresh_without_scheduling_blob_delivery(self):
        meeting = self._ready_meeting()
        meeting.unknown_speaker_count = 1
        store.PARTICIPANTS[meeting.id] = [
            MeetingParticipant(name="Speaker 1", known=False)
        ]
        store.TRANSCRIPTS[meeting.id] = [
            TranscriptSegment(
                speaker="Speaker 1",
                speaker_known=False,
                text="before",
                start_ms=0,
                end_ms=1000,
                raw_speaker="SPEAKER_00",
            )
        ]
        action = ActionItem(
            id=uuid4(),
            meeting_id=meeting.id,
            description="Follow up",
        )
        store.ACTION_ITEMS[action.id] = action

        with patch("app.routers.meetings.kick_blob_delivery") as meeting_kick, patch(
            "app.services.blob_delivery.kick_blob_delivery"
        ) as service_kick:
            await meetings_router.name_speaker(
                meeting.id,
                NameSpeakerRequest(label="Speaker 1", name="Avery"),
                actor="Editor",
            )
            await action_items_router.update_action_item(
                action.id,
                ActionItemUpdate(status=ActionItemStatus.done),
                actor="Editor",
            )

        self.assertIn(meeting.id, store.MEETING_EXPORTS)
        meeting_kick.assert_not_called()
        service_kick.assert_not_called()


class BlobDeliveryHttpTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.old_state = {
            "meetings": dict(store.MEETINGS),
            "access": {key: list(value) for key, value in store.ACCESS.items()},
            "exports": dict(store.MEETING_EXPORTS),
            "audit": list(store.AUDIT_LOG),
        }
        store.MEETINGS.clear()
        store.ACCESS.clear()
        store.MEETING_EXPORTS.clear()
        store.AUDIT_LOG.clear()
        self.app = create_app()

    def tearDown(self):
        store.MEETINGS.clear()
        store.MEETINGS.update(self.old_state["meetings"])
        store.ACCESS.clear()
        store.ACCESS.update(self.old_state["access"])
        store.MEETING_EXPORTS.clear()
        store.MEETING_EXPORTS.update(self.old_state["exports"])
        store.AUDIT_LOG[:] = self.old_state["audit"]

    def _ready_meeting(self, *, blob_status=BlobStatus.failed) -> Meeting:
        meeting = _meeting(
            pipeline_status=PipelineStatus.ready,
            pipeline_stage=PipelineStage.ready,
            unknown_speaker_count=0,
            blob_status=blob_status,
        )
        store.MEETINGS[meeting.id] = meeting
        store.ACCESS[meeting.id] = [
            MeetingAccessEntry(user="Joseph", role=AccessRole.owner),
            MeetingAccessEntry(user="Editor", role=AccessRole.editor),
            MeetingAccessEntry(user="Viewer", role=AccessRole.viewer),
        ]
        return meeting

    async def test_http_finalize_propagates_token_and_returns_canonical_pending_after_launcher_error(self):
        meeting = self._ready_meeting(blob_status=BlobStatus.uploaded)

        def launch_then_fail(*args, **kwargs):
            current = store.MEETINGS[meeting.id]
            store.MEETINGS[meeting.id] = current.model_copy(
                update={"blob_status": BlobStatus.pending, "blob_error_message": None}
            )
            raise RuntimeError("launcher failed after pending transition")

        with patch(
            "app.routers.meetings.kick_blob_delivery",
            side_effect=launch_then_fail,
        ) as kick, patch(
            "app.routers.meetings.refresh_meeting_export"
        ), patch.object(
            meetings_router.logger, "error"
        ), patch(
            "app.store.save_snapshot"
        ):
            response = await _asgi_post(
                self.app,
                f"/api/v1/meetings/{meeting.id}/finalize",
                {
                    "X-MN-User": "Joseph",
                    "X-MN-Storage-Token": "finalize-token",
                },
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], MeetingStatus.finalized.value)
        self.assertEqual(payload["blob_status"], BlobStatus.pending.value)
        self.assertNotIn("finalize-token", response.text)
        self.assertNotIn("sig=", response.text)
        kick.assert_called_once_with(
            meeting.id,
            access_token="finalize-token",
            actor="Joseph",
            include_audio=False,
        )

    async def test_http_finalize_enforces_owner_acl_and_readiness(self):
        meeting = self._ready_meeting()
        with patch("app.routers.meetings.kick_blob_delivery") as kick, patch(
            "app.store.save_snapshot"
        ):
            denied = await _asgi_post(
                self.app,
                f"/api/v1/meetings/{meeting.id}/finalize",
                {"X-MN-User": "Editor", "X-MN-Storage-Token": "secret"},
            )
            self.assertEqual(denied.status_code, 403)

            store.MEETINGS[meeting.id] = meeting.model_copy(
                update={"pipeline_status": PipelineStatus.processing}
            )
            unready = await _asgi_post(
                self.app,
                f"/api/v1/meetings/{meeting.id}/finalize",
                {"X-MN-User": "Joseph", "X-MN-Storage-Token": "secret"},
            )

        self.assertEqual(unready.status_code, 409)
        self.assertNotIn("secret", denied.text + unready.text)
        kick.assert_not_called()

    async def test_http_blob_retry_propagates_token_audits_and_returns_pending(self):
        meeting = self._ready_meeting(blob_status=BlobStatus.failed)
        saved_audit_actions = []

        def launch_pending(*args, **kwargs):
            current = store.MEETINGS[meeting.id]
            store.MEETINGS[meeting.id] = current.model_copy(
                update={"blob_status": BlobStatus.pending, "blob_error_message": None}
            )

        def capture_snapshot():
            saved_audit_actions.append([entry.action for entry in store.AUDIT_LOG])

        with patch(
            "app.routers.meetings.kick_blob_delivery",
            side_effect=launch_pending,
        ) as kick, patch(
            "app.store.save_snapshot", side_effect=capture_snapshot
        ):
            response = await _asgi_post(
                self.app,
                f"/api/v1/meetings/{meeting.id}/blob/retry",
                {
                    "X-MN-User": "Editor",
                    "X-MN-Storage-Token": "retry-token",
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["blob_status"], BlobStatus.pending.value)
        self.assertNotIn("retry-token", response.text)
        self.assertNotIn("sig=", response.text)
        kick.assert_called_once_with(
            meeting.id,
            access_token="retry-token",
            actor="Editor",
            include_audio=True,
        )
        retry_audit = [entry for entry in store.AUDIT_LOG if entry.action == "meeting.blob_retry"]
        self.assertEqual(len(retry_audit), 1)
        self.assertEqual(retry_audit[0].actor, "Editor")
        self.assertEqual(retry_audit[0].target, meeting.title)
        self.assertEqual(retry_audit[0].before, BlobStatus.failed.value)
        self.assertEqual(retry_audit[0].after, BlobStatus.pending.value)
        self.assertEqual(retry_audit[0].meeting_id, meeting.id)
        self.assertIn("meeting.blob_retry", saved_audit_actions[-1])
        serialized = retry_audit[0].model_dump_json()
        self.assertNotIn("retry-token", serialized)
        self.assertNotIn("sig=", serialized)

    async def test_http_blob_retry_disabled_storage_audits_actual_unchanged_state(self):
        meeting = self._ready_meeting(blob_status=BlobStatus.failed)
        disabled_settings = SimpleNamespace(
            storage_api_enabled=False,
            storage_api_url="",
        )

        with patch(
            "app.services.blob_delivery.get_settings",
            return_value=disabled_settings,
        ), patch("app.store.save_snapshot"):
            response = await _asgi_post(
                self.app,
                f"/api/v1/meetings/{meeting.id}/blob/retry",
                {
                    "X-MN-User": "Editor",
                    "X-MN-Storage-Token": "retry-token",
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["blob_status"], BlobStatus.failed.value)
        retry_audit = [entry for entry in store.AUDIT_LOG if entry.action == "meeting.blob_retry"]
        self.assertEqual(len(retry_audit), 1)
        self.assertEqual(retry_audit[0].before, BlobStatus.failed.value)
        self.assertEqual(retry_audit[0].after, BlobStatus.failed.value)
        self.assertNotIn("retry-token", retry_audit[0].model_dump_json())

    async def test_http_blob_retry_enforces_editor_acl_and_readiness(self):
        meeting = self._ready_meeting()
        with patch("app.routers.meetings.kick_blob_delivery") as kick, patch(
            "app.store.save_snapshot"
        ):
            denied = await _asgi_post(
                self.app,
                f"/api/v1/meetings/{meeting.id}/blob/retry",
                {"X-MN-User": "Viewer", "X-MN-Storage-Token": "secret"},
            )
            self.assertEqual(denied.status_code, 403)

            store.MEETINGS[meeting.id] = meeting.model_copy(
                update={"pipeline_status": PipelineStatus.processing}
            )
            unready = await _asgi_post(
                self.app,
                f"/api/v1/meetings/{meeting.id}/blob/retry",
                {"X-MN-User": "Editor", "X-MN-Storage-Token": "secret"},
            )
            self.assertEqual(unready.status_code, 409)

            for blob_status in (BlobStatus.pending, BlobStatus.uploaded):
                with self.subTest(blob_status=blob_status):
                    store.MEETINGS[meeting.id] = meeting.model_copy(
                        update={"blob_status": blob_status}
                    )
                    response = await _asgi_post(
                        self.app,
                        f"/api/v1/meetings/{meeting.id}/blob/retry",
                        {"X-MN-User": "Editor", "X-MN-Storage-Token": "secret"},
                    )
                    self.assertEqual(response.status_code, 409)
                    self.assertIn("not failed", response.text)
                    self.assertEqual(store.MEETINGS[meeting.id].blob_status, blob_status)
                    self.assertEqual(store.AUDIT_LOG, [])

        self.assertNotIn("secret", denied.text + unready.text)
        kick.assert_not_called()


if __name__ == "__main__":
    unittest.main()
