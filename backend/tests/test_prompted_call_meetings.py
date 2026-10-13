import asyncio
import base64
from pathlib import Path
import json
import threading
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch, AsyncMock
from uuid import uuid4

import tests.conftest_env  # noqa: F401

from fastapi import HTTPException
from fastapi import FastAPI

from app import store
from app.routers import meetings as meetings_router
from app.schemas import (
    AccessRole,
    CallObservationRequest,
    CallRecordResolveResponse,
    CallLookupStatus,
    DeliveryStatus,
    GraphMeetingMetadata,
    GraphMeetingAttendeeMetadata,
    UploadAudioRequest,
    InviteeDecision,
    Meeting,
    MeetingAccessEntry,
    MeetingSource,
    MeetingStatus,
    PipelineStatus,
    PromptedCallMetadata,
)
from app.services.storage_api import StorageApiUnavailable


class FakeCallRecordClient:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def resolve_call_records(self, meeting_id, started_at_utc, ended_at_utc, access_token):
        self.calls.append((meeting_id, started_at_utc, ended_at_utc, access_token))
        return CallRecordResolveResponse.model_validate(self.response)


class UnavailableCallRecordClient:
    def resolve_call_records(self, meeting_id, started_at_utc, ended_at_utc, access_token):
        raise StorageApiUnavailable("storage unavailable")


class SlowCallRecordClient:
    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()
        self.calls = 0
        self._calls_lock = threading.Lock()

    def resolve_call_records(self, meeting_id, started_at_utc, ended_at_utc, access_token):
        with self._calls_lock:
            self.calls += 1
        self.started.set()
        if not self.release.wait(timeout=5):
            raise AssertionError("slow storage fixture was not released")
        return CallRecordResolveResponse(
            status="resolved",
            participants=[{"name": "David", "email": "da@factor1.com.au"}],
            retry_after_seconds=60,
        )


async def _post_json(path: str, payload: dict, headers: list[tuple[bytes, bytes]]) -> int:
    app = FastAPI()
    app.include_router(meetings_router.router, prefix="/api/v1")
    body = json.dumps(payload).encode("utf-8")
    status_holder: dict[str, int] = {}

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("utf-8"),
        "query_string": b"",
        "root_path": "",
        "headers": headers,
        "client": ("testclient", 123),
        "server": ("testserver", 80),
    }

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(message):
        if message["type"] == "http.response.start":
            status_holder["status"] = message["status"]

    await app(scope, receive, send)
    return status_holder["status"]


class PromptedCallMeetingTests(unittest.IsolatedAsyncioTestCase):
    async def test_creation_cannot_seed_prompted_recipients(self):
        from app.schemas import MeetingCreate
        injected = self.meeting.graph_metadata.model_copy(deep=True)
        injected.attendees = [GraphMeetingAttendeeMetadata(email="other@factor1.com.au", name="Injected")]
        created = await meetings_router.create_meeting(
            MeetingCreate(title="Prompted fixture", source=MeetingSource.online,
                          graph_metadata=injected), actor="Joseph")
        self.assertEqual(created.graph_metadata.attendees, [])

    def setUp(self):
        self.old_meetings = dict(store.MEETINGS)
        self.old_access = {key: list(value) for key, value in store.ACCESS.items()}
        self.old_audit = list(store.AUDIT_LOG)
        self.meeting_id = uuid4()
        self.started = datetime(2026, 10, 6, 8, 0, tzinfo=timezone.utc)
        self.ended = self.started + timedelta(minutes=12)
        # Production expiry uses wall time. Freeze only this router's clock so
        # these fixed call fixtures remain valid tomorrow and next year too.
        self.now = self.ended + timedelta(minutes=1)
        clock_patch = patch("app.routers.meetings.datetime", wraps=datetime)
        self.clock = clock_patch.start()
        self.clock.now.return_value = self.now
        self.addCleanup(clock_patch.stop)
        self.meeting = Meeting(
            id=self.meeting_id,
            title="Alex External",
            source=MeetingSource.online,
            owner_id="joseph",
            created_at=self.started,
            pipeline_status=PipelineStatus.ready,
            graph_metadata=GraphMeetingMetadata(
                title="Alex External",
                attendees=[],
                meeting_id="teams-call-1",
                prompted_call=PromptedCallMetadata(
                    nonce="teams-call-1",
                    observed_start_utc=self.started.isoformat(),
                ),
            ),
            invitee_decision=InviteeDecision.declined,
            delivery_status=DeliveryStatus.emailed,
            delivery_recipients=["joseph@factor1.com.au"],
        )
        store.MEETINGS[self.meeting_id] = self.meeting
        store.ACCESS[self.meeting_id] = [
            MeetingAccessEntry(user="Joseph", role=AccessRole.owner),
            MeetingAccessEntry(user="Editor", role=AccessRole.editor),
            MeetingAccessEntry(user="Viewer", role=AccessRole.viewer),
        ]

    def tearDown(self):
        store.MEETINGS.clear(); store.MEETINGS.update(self.old_meetings)
        store.ACCESS.clear(); store.ACCESS.update(self.old_access)
        store.AUDIT_LOG[:] = self.old_audit

    async def _upload_fixture(self, metadata):
        store.MEETINGS[self.meeting_id] = store.MEETINGS[self.meeting_id].model_copy(
            update={"pipeline_status": PipelineStatus.pending_audio}
        )
        body = UploadAudioRequest(
            audio_b64=base64.b64encode(b"fixture-audio" * 200).decode("ascii"),
            graph_metadata=metadata,
        )
        with patch("app.routers.meetings._prepare_uploaded_audio", new_callable=AsyncMock, return_value=Path("fixture.webm")), patch("app.routers.meetings.kick_pipeline"):
            return await meetings_router.upload_audio(
                self.meeting_id, body, actor="Joseph", storage_token=None,
                user_email="joseph@factor1.com.au", graph_token=None,
            )

    async def test_upload_preserves_durable_hangup_despite_stale_renderer_metadata(self):
        stale_metadata = self.meeting.graph_metadata.model_copy(deep=True)
        await meetings_router.observe_prompted_call(
            self.meeting_id, CallObservationRequest(ended_at_utc=self.ended), actor="Joseph"
        )
        uploaded = await self._upload_fixture(stale_metadata)
        self.assertEqual(uploaded.graph_metadata.prompted_call.observed_end_utc, self.ended.isoformat())
        self.assertIsNotNone(uploaded.call_lookup_deadline_at)

    async def test_upload_recovers_hangup_when_observation_post_was_lost(self):
        incoming = self.meeting.graph_metadata.model_copy(deep=True)
        incoming.prompted_call.observed_end_utc = self.ended.isoformat()
        uploaded = await self._upload_fixture(incoming)
        self.assertEqual(uploaded.call_lookup_status, CallLookupStatus.pending)
        self.assertEqual(uploaded.call_lookup_deadline_at, self.ended + timedelta(minutes=180))

    async def test_prompted_upload_cannot_replace_trusted_attendees(self):
        trusted = GraphMeetingAttendeeMetadata(name="David", email="da@factor1.com.au")
        store.MEETINGS[self.meeting_id].graph_metadata.attendees = [trusted]
        incoming = self.meeting.graph_metadata.model_copy(deep=True)
        incoming.attendees = [GraphMeetingAttendeeMetadata(name="Injected", email="injected@factor1.com.au")]
        uploaded = await self._upload_fixture(incoming)
        self.assertEqual([a.email for a in uploaded.graph_metadata.attendees], ["da@factor1.com.au"])

    async def test_prompted_upload_refuses_a_different_call_marker(self):
        incoming = self.meeting.graph_metadata.model_copy(deep=True)
        incoming.prompted_call.nonce = "different-call"
        with self.assertRaises(HTTPException) as error:
            await self._upload_fixture(incoming)
        self.assertEqual(error.exception.status_code, 409)

    async def test_observed_end_is_owner_only_and_persists_lookup_window(self):
        with self.assertRaises(HTTPException) as error:
            await meetings_router.observe_prompted_call(
                self.meeting_id,
                CallObservationRequest(ended_at_utc=self.ended),
                actor="Editor",
            )
        self.assertEqual(error.exception.status_code, 403)

        updated = await meetings_router.observe_prompted_call(
            self.meeting_id,
            CallObservationRequest(ended_at_utc=self.ended),
            actor="Joseph",
        )
        self.assertEqual(updated.graph_metadata.prompted_call.observed_end_utc, self.ended.isoformat())
        self.assertEqual(updated.call_lookup_status.value, "pending")
        self.assertIsNotNone(updated.call_lookup_next_retry_at)
        self.assertIsNotNone(updated.call_lookup_deadline_at)
        self.assertTrue(any(a.action == "meeting.prompted_call_observed_end" for a in store.AUDIT_LOG))

    async def test_observation_and_resolution_require_explicit_owner_acl_before_io(self):
        for actor in ("Editor", "Viewer", "Unknown"):
            with self.assertRaises(HTTPException) as error:
                await meetings_router.observe_prompted_call(
                    self.meeting_id,
                    CallObservationRequest(ended_at_utc=self.ended),
                    actor=actor,
                )
            self.assertIn(error.exception.status_code, (403, 404))

        await meetings_router.observe_prompted_call(
            self.meeting_id,
            CallObservationRequest(ended_at_utc=self.ended),
            actor="Joseph",
        )
        fake = FakeCallRecordClient({"status": "resolved", "participants": []})
        with patch("app.routers.meetings.get_storage_api_client", return_value=fake):
            for actor in ("Editor", "Viewer", "Unknown"):
                with self.assertRaises(HTTPException) as error:
                    await meetings_router.resolve_call_participants(
                        self.meeting_id,
                        actor=actor,
                        storage_token="token",
                    )
                self.assertIn(error.exception.status_code, (403, 404))

            store.ACCESS.pop(self.meeting_id)
            with self.assertRaises(HTTPException) as error:
                await meetings_router.resolve_call_participants(
                    self.meeting_id,
                    actor="Joseph",
                    storage_token="token",
                )
            self.assertIn(error.exception.status_code, (403, 404))
        self.assertEqual(fake.calls, [])

    async def test_http_resolve_rejects_renderer_recipient_fields(self):
        await meetings_router.observe_prompted_call(
            self.meeting_id,
            CallObservationRequest(ended_at_utc=self.ended),
            actor="Joseph",
        )
        fake = FakeCallRecordClient({"status": "resolved", "participants": []})
        with patch("app.routers.meetings.get_storage_api_client", return_value=fake):
            response_status = await _post_json(
                f"/api/v1/meetings/{self.meeting_id}/call-participants/resolve",
                {"recipients": ["attacker@example.com"]},
                [
                    (b"content-type", b"application/json"),
                    (b"x-mn-user", b"Joseph"),
                    (b"x-mn-storage-token", b"token"),
                ],
            )
        self.assertEqual(response_status, 422)
        self.assertEqual(fake.calls, [])
        self.assertEqual(store.MEETINGS[self.meeting_id].graph_metadata.attendees, [])

    async def test_resolve_is_owner_only_and_renderer_cannot_supply_recipients(self):
        await meetings_router.observe_prompted_call(
            self.meeting_id,
            CallObservationRequest(ended_at_utc=self.ended),
            actor="Joseph",
        )
        fake = FakeCallRecordClient({
            "status": "resolved",
            "participants": [{"name": "David", "email": "da@factor1.com.au"}],
            "retry_after_seconds": 60,
        })
        with patch("app.routers.meetings.get_storage_api_client", return_value=fake):
            with self.assertRaises(HTTPException) as error:
                await meetings_router.resolve_call_participants(
                    self.meeting_id,
                    actor="Editor",
                    storage_token="token",
                )
            self.assertEqual(error.exception.status_code, 403)

            updated = await meetings_router.resolve_call_participants(
                self.meeting_id,
                actor="Joseph",
                storage_token="token",
            )
        self.assertEqual(updated.graph_metadata.attendees[0].email, "da@factor1.com.au")
        self.assertEqual(updated.call_lookup_status.value, "resolved")
        self.assertEqual(updated.delivery_recipients, ["joseph@factor1.com.au"])
        replayed_at = self.ended
        store.MEETINGS[self.meeting_id] = updated.model_copy(
            update={
                "delivery_emailed_at": replayed_at,
                "invitee_recipients": ["mel@factor1.com.au"],
            }
        )
        durable = store.MEETINGS[self.meeting_id]
        self.assertEqual(durable.delivery_emailed_at, replayed_at)
        self.assertEqual(durable.invitee_recipients, ["mel@factor1.com.au"])
        self.assertIs(updated.invitee_decision, InviteeDecision.declined)
        self.assertEqual(fake.calls[0][3], "token")
        self.assertTrue(any(a.action == "meeting.prompted_call_resolve_attempt" for a in store.AUDIT_LOG))
        self.assertTrue(any(a.action == "meeting.prompted_call_resolve" for a in store.AUDIT_LOG))

    async def test_slow_resolution_keeps_single_flight_past_retry_cadence(self):
        await meetings_router.observe_prompted_call(
            self.meeting_id,
            CallObservationRequest(ended_at_utc=self.ended),
            actor="Joseph",
        )
        client = SlowCallRecordClient()
        with patch("app.routers.meetings.get_storage_api_client", return_value=client):
            first = asyncio.create_task(
                meetings_router.resolve_call_participants(
                    self.meeting_id, actor="Joseph", storage_token="token"
                )
            )
            self.assertTrue(await asyncio.to_thread(client.started.wait, 2))
            store.MEETINGS[self.meeting_id].call_lookup_next_retry_at = (
                self.now - timedelta(seconds=1)
            )
            second = asyncio.create_task(
                meetings_router.resolve_call_participants(
                    self.meeting_id, actor="Joseph", storage_token="token"
                )
            )
            await asyncio.sleep(0.05)
            self.assertEqual(client.calls, 1)
            client.release.set()
            await asyncio.gather(first, second)

    async def test_resolution_refuses_finalization_during_provider_io(self):
        await meetings_router.observe_prompted_call(
            self.meeting_id,
            CallObservationRequest(ended_at_utc=self.ended),
            actor="Joseph",
        )
        client = SlowCallRecordClient()
        with patch("app.routers.meetings.get_storage_api_client", return_value=client):
            task = asyncio.create_task(
                meetings_router.resolve_call_participants(
                    self.meeting_id, actor="Joseph", storage_token="token"
                )
            )
            self.assertTrue(await asyncio.to_thread(client.started.wait, 2))
            store.MEETINGS[self.meeting_id] = store.MEETINGS[self.meeting_id].model_copy(
                update={"status": MeetingStatus.finalized}
            )
            client.release.set()
            with self.assertRaises(HTTPException) as error:
                await task
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(store.MEETINGS[self.meeting_id].graph_metadata.attendees, [])

    async def test_finalized_resolution_is_denied_before_storage_io(self):
        await meetings_router.observe_prompted_call(
            self.meeting_id,
            CallObservationRequest(ended_at_utc=self.ended),
            actor="Joseph",
        )
        store.MEETINGS[self.meeting_id] = store.MEETINGS[self.meeting_id].model_copy(
            update={"status": MeetingStatus.finalized}
        )
        client = FakeCallRecordClient({"status": "resolved", "participants": []})
        with patch("app.routers.meetings.get_storage_api_client", return_value=client):
            with self.assertRaises(HTTPException) as error:
                await meetings_router.resolve_call_participants(
                    self.meeting_id, actor="Joseph", storage_token="token"
                )
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(client.calls, [])

    async def test_resolution_refuses_source_replacement_during_provider_io(self):
        await meetings_router.observe_prompted_call(
            self.meeting_id,
            CallObservationRequest(ended_at_utc=self.ended),
            actor="Joseph",
        )
        client = SlowCallRecordClient()
        with patch("app.routers.meetings.get_storage_api_client", return_value=client):
            task = asyncio.create_task(
                meetings_router.resolve_call_participants(
                    self.meeting_id, actor="Joseph", storage_token="token"
                )
            )
            self.assertTrue(await asyncio.to_thread(client.started.wait, 2))
            store.MEETINGS[self.meeting_id] = store.MEETINGS[self.meeting_id].model_copy(
                update={"source": MeetingSource.in_person, "graph_metadata": None}
            )
            client.release.set()
            with self.assertRaises(HTTPException) as error:
                await task
        self.assertEqual(error.exception.status_code, 409)

    async def test_resolution_refuses_owner_acl_change_during_provider_io(self):
        await meetings_router.observe_prompted_call(
            self.meeting_id,
            CallObservationRequest(ended_at_utc=self.ended),
            actor="Joseph",
        )
        client = SlowCallRecordClient()
        with patch("app.routers.meetings.get_storage_api_client", return_value=client):
            task = asyncio.create_task(
                meetings_router.resolve_call_participants(
                    self.meeting_id, actor="Joseph", storage_token="token"
                )
            )
            self.assertTrue(await asyncio.to_thread(client.started.wait, 2))
            store.ACCESS[self.meeting_id] = [
                MeetingAccessEntry(user="Other", role=AccessRole.owner)
            ]
            client.release.set()
            with self.assertRaises(HTTPException) as error:
                await task
        self.assertIn(error.exception.status_code, (403, 404))
        self.assertEqual(store.MEETINGS[self.meeting_id].graph_metadata.attendees, [])

    async def test_resolution_refuses_removed_meeting_during_provider_io(self):
        await meetings_router.observe_prompted_call(
            self.meeting_id,
            CallObservationRequest(ended_at_utc=self.ended),
            actor="Joseph",
        )
        client = SlowCallRecordClient()
        with patch("app.routers.meetings.get_storage_api_client", return_value=client):
            task = asyncio.create_task(
                meetings_router.resolve_call_participants(
                    self.meeting_id, actor="Joseph", storage_token="token"
                )
            )
            self.assertTrue(await asyncio.to_thread(client.started.wait, 2))
            store.MEETINGS.pop(self.meeting_id)
            client.release.set()
            with self.assertRaises(HTTPException) as error:
                await task
        self.assertEqual(error.exception.status_code, 404)

    async def test_ambiguous_and_unavailable_never_add_recipients(self):
        await meetings_router.observe_prompted_call(
            self.meeting_id,
            CallObservationRequest(ended_at_utc=self.ended),
            actor="Joseph",
        )
        for response, expected in (
            ({"status": "ambiguous", "participants": [], "retry_after_seconds": 60}, "ambiguous"),
            ({"status": "pending", "participants": [], "retry_after_seconds": 60}, "pending"),
        ):
            fake = FakeCallRecordClient(response)
            with patch("app.routers.meetings.get_storage_api_client", return_value=fake):
                updated = await meetings_router.resolve_call_participants(
                    self.meeting_id,
                    actor="Joseph",
                    storage_token="token",
                )
            self.assertEqual(updated.call_lookup_status.value, expected)
            self.assertEqual(updated.graph_metadata.attendees, [])
            store.MEETINGS[self.meeting_id] = store.MEETINGS[self.meeting_id].model_copy(
                update={"call_lookup_next_retry_at": None}
            )

    async def test_storage_unavailable_is_explicit_and_retryable(self):
        await meetings_router.observe_prompted_call(
            self.meeting_id,
            CallObservationRequest(ended_at_utc=self.ended),
            actor="Joseph",
        )
        with patch(
            "app.routers.meetings.get_storage_api_client",
            return_value=UnavailableCallRecordClient(),
        ):
            updated = await meetings_router.resolve_call_participants(
                self.meeting_id,
                actor="Joseph",
                storage_token="token",
            )
        self.assertEqual(updated.call_lookup_status.value, "unavailable")
        self.assertIsNotNone(updated.call_lookup_next_retry_at)
        self.assertEqual(updated.graph_metadata.attendees, [])

    async def test_expiry_is_persisted_and_does_not_call_storage(self):
        await meetings_router.observe_prompted_call(
            self.meeting_id,
            CallObservationRequest(ended_at_utc=self.ended),
            actor="Joseph",
        )
        store.MEETINGS[self.meeting_id] = store.MEETINGS[self.meeting_id].model_copy(
            update={
                "call_lookup_deadline_at": self.now - timedelta(seconds=1),
                "call_lookup_next_retry_at": None,
            }
        )
        fake = FakeCallRecordClient({"status": "resolved", "participants": []})
        with patch("app.routers.meetings.get_storage_api_client", return_value=fake):
            updated = await meetings_router.resolve_call_participants(
                self.meeting_id,
                actor="Joseph",
                storage_token="token",
            )
        self.assertEqual(updated.call_lookup_status.value, "expired")
        self.assertEqual(fake.calls, [])
        self.assertTrue(any(a.action == "meeting.prompted_call_resolve_expired" for a in store.AUDIT_LOG))

    async def test_resolved_participant_lookup_is_durable_past_deadline(self):
        await meetings_router.observe_prompted_call(
            self.meeting_id,
            CallObservationRequest(ended_at_utc=self.ended),
            actor="Joseph",
        )
        store.MEETINGS[self.meeting_id] = store.MEETINGS[self.meeting_id].model_copy(
            update={
                "call_lookup_status": CallLookupStatus.resolved,
                "call_lookup_deadline_at": self.now - timedelta(seconds=1),
                "call_lookup_next_retry_at": None,
            }
        )
        fake = FakeCallRecordClient({"status": "resolved", "participants": []})
        with patch("app.routers.meetings.get_storage_api_client", return_value=fake):
            updated = await meetings_router.resolve_call_participants(
                self.meeting_id,
                actor="Joseph",
                storage_token="token",
            )
        self.assertEqual(updated.call_lookup_status.value, "resolved")
        self.assertEqual(fake.calls, [])

    async def test_manual_and_calendar_meetings_are_not_call_linked(self):
        for source, metadata in (
            (MeetingSource.in_person, None),
            (MeetingSource.online, GraphMeetingMetadata(title="Scheduled", attendees=[], meeting_id="event-1")),
        ):
            meeting_id = uuid4()
            store.MEETINGS[meeting_id] = self.meeting.model_copy(
                update={"id": meeting_id, "source": source, "graph_metadata": metadata}
            )
            with self.assertRaises(HTTPException) as error:
                await meetings_router.observe_prompted_call(
                    meeting_id,
                    CallObservationRequest(ended_at_utc=self.ended),
                    actor="Joseph",
                )
            self.assertIn(error.exception.status_code, (403, 409))

    async def test_snapshot_round_trip_retains_call_state(self):
        await meetings_router.observe_prompted_call(
            self.meeting_id,
            CallObservationRequest(ended_at_utc=self.ended),
            actor="Joseph",
        )
        store.save_snapshot()
        store.MEETINGS.clear()
        self.assertTrue(store.load_snapshot())
        restored = store.MEETINGS[self.meeting_id]
        self.assertEqual(restored.call_lookup_status.value, "pending")
        self.assertEqual(restored.graph_metadata.prompted_call.observed_end_utc, self.ended.isoformat())


if __name__ == "__main__":
    unittest.main()
