import asyncio
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import tests.conftest_env  # noqa: F401

from app import store
from app.paths import snapshot_path
from app.schemas import (
    BlobStatus,
    Meeting,
    MeetingSource,
    MeetingStatus,
    PipelineStage,
    PipelineStatus,
)
from app.services import blob_delivery
from app.services.blob_delivery import (
    deliver_meeting_to_blob,
    kick_blob_delivery,
    meeting_time_basis_utc,
    reconcile_interrupted_blob_deliveries,
)
from app.services.storage_api import AudioUploadGrant


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
        old_snapshot = snapshot_path().read_bytes() if snapshot_path().exists() else None
        meeting = _meeting()
        try:
            store.MEETINGS.clear()
            store.MEETINGS[meeting.id] = meeting
            store.save_snapshot()
            raw = json.loads(snapshot_path().read_text(encoding="utf-8"))
            raw["meetings"][str(meeting.id)].pop("blob_status")
            raw["meetings"][str(meeting.id)].pop("blob_error_message")
            snapshot_path().write_text(json.dumps(raw), encoding="utf-8")

            store.MEETINGS.clear()
            self.assertTrue(store.load_snapshot())
            loaded = store.MEETINGS[meeting.id]
            self.assertEqual(loaded.blob_status, BlobStatus.pending)
            self.assertIsNone(loaded.blob_error_message)
        finally:
            store.MEETINGS.clear()
            store.MEETINGS.update(old_meetings)
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
        }
        store.MEETINGS.clear()
        store.MEETING_EXPORTS.clear()
        store.AUDIT_LOG.clear()
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

    async def _deliver(self, client, include_audio=True, token="access-token"):
        return await deliver_meeting_to_blob(
            self.meeting.id,
            access_token=token,
            actor="Joseph",
            include_audio=include_audio,
            client=client,
        )

    async def test_full_delivery_orders_sas_audio_then_export(self):
        client = CaptureStorageClient()

        result = await self._deliver(client)

        self.assertEqual([call[0] for call in client.calls], ["sas", "audio", "export"])
        expected_time = datetime(2026, 7, 27, 3, 30, tzinfo=timezone.utc)
        self.assertEqual(client.calls[0][2], expected_time)
        self.assertEqual(client.calls[1][2], self.audio_path)
        self.assertEqual(client.calls[2][2], expected_time)
        self.assertIs(client.calls[2][3], store.MEETING_EXPORTS[self.meeting.id])
        self.assertEqual(result.blob_status, BlobStatus.uploaded)
        self.assertIsNone(result.blob_error_message)

    async def test_json_only_delivery_skips_audio_operations(self):
        client = CaptureStorageClient()

        await self._deliver(client, include_audio=False)

        self.assertEqual([call[0] for call in client.calls], ["export"])
        self.assertEqual(self.meeting.blob_status, BlobStatus.uploaded)

    async def test_configured_storage_without_token_fails_before_provider_call(self):
        client = CaptureStorageClient()

        result = await self._deliver(client, token="   ")

        self.assertEqual(client.calls, [])
        self.assertEqual(result.blob_status, BlobStatus.failed)
        self.assertEqual(
            result.blob_error_message,
            "Sign in is required to upload this meeting to secure storage.",
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
                self.assertEqual(
                    result.blob_error_message,
                    "Secure storage upload is waiting for processed meeting data.",
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
        self.assertEqual(
            result.blob_error_message,
            "Secure storage upload failed while uploading audio. Retry when connected.",
        )

    async def test_audio_filesystem_error_is_contained_as_audio_failure(self):
        client = CaptureStorageClient()
        with patch(
            "app.services.blob_delivery.audio_dir",
            side_effect=OSError("private filesystem path"),
        ):
            result = await self._deliver(client)

        self.assertEqual(client.calls, [])
        self.assertEqual(result.blob_status, BlobStatus.failed)
        self.assertEqual(
            result.blob_error_message,
            "Secure storage upload failed while uploading audio. Retry when connected.",
        )

    async def test_audio_failure_stops_before_export(self):
        client = CaptureStorageClient(fail_stage="audio")

        result = await self._deliver(client)

        self.assertEqual([call[0] for call in client.calls], ["sas", "audio"])
        self.assertEqual(result.blob_status, BlobStatus.failed)
        self.assertEqual(
            result.blob_error_message,
            "Secure storage upload failed while uploading audio. Retry when connected.",
        )

    async def test_json_failure_happens_after_audio_and_uses_record_failure(self):
        client = CaptureStorageClient(fail_stage="export")

        result = await self._deliver(client)

        self.assertEqual([call[0] for call in client.calls], ["sas", "audio", "export"])
        self.assertEqual(result.blob_status, BlobStatus.failed)
        self.assertEqual(
            result.blob_error_message,
            "Secure storage upload failed while uploading the meeting record. Retry when connected.",
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


class BlobDeliveryLauncherTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.old_meetings = dict(store.MEETINGS)
        store.MEETINGS.clear()
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
        store.MEETINGS.clear()

    def tearDown(self):
        store.MEETINGS.clear()
        store.MEETINGS.update(self.old_meetings)

    def test_startup_reconcile_marks_only_ready_pending_blob_delivery_failed(self):
        ready_pending = _meeting(
            pipeline_status=PipelineStatus.ready,
            blob_status=BlobStatus.pending,
            action_item_count=4,
        )
        untouched = [
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
        for meeting in untouched:
            store.MEETINGS[meeting.id] = meeting
        untouched_before = {
            meeting.id: meeting.model_dump() for meeting in untouched
        }

        with patch("app.services.blob_delivery.store.save_snapshot") as save:
            changed = reconcile_interrupted_blob_deliveries()

        self.assertEqual(changed, 1)
        self.assertEqual(ready_pending.blob_status, BlobStatus.failed)
        self.assertEqual(
            ready_pending.blob_error_message,
            "Secure storage upload was interrupted. Retry when connected.",
        )
        self.assertEqual(ready_pending.pipeline_status, PipelineStatus.ready)
        self.assertEqual(ready_pending.action_item_count, 4)
        save.assert_called_once_with()
        for meeting in untouched:
            self.assertEqual(meeting.model_dump(), untouched_before[meeting.id])


if __name__ == "__main__":
    unittest.main()
