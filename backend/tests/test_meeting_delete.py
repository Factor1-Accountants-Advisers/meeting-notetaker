"""Owner may delete a meeting that never received audio (join-trigger J4:
a discarded false start must not leave an empty Draft behind).

The renderer creates the backend meeting before capture starts, so a
false-start discard needs a tidy-up call. These tests pin the guard rails:
owner-only, refused once anything was uploaded or processed, audited.
"""

import base64
import json
import unittest
from unittest.mock import patch
from uuid import uuid4

from app import store
from app.paths import audio_dir
from app.routers import meetings as meetings_router
from app.schemas import (
    AccessRole,
    MeetingAccessEntry,
    MeetingCreate,
    MeetingSource,
    PipelineStatus,
    UploadAudioRequest,
)
from app.services.pipeline import audio_path_for, mic_track_path
from fastapi import HTTPException

OWNER = "joseph@factor1.com.au"
VIEWER = "viewer@factor1.com.au"
OUTSIDER = "someone@factor1.com.au"


class MeetingDeleteTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._meetings = dict(store.MEETINGS)
        self._access = {key: list(value) for key, value in store.ACCESS.items()}
        self._audit = list(store.AUDIT_LOG)

    def tearDown(self):
        store.MEETINGS.clear()
        store.MEETINGS.update(self._meetings)
        store.ACCESS.clear()
        store.ACCESS.update(self._access)
        store.AUDIT_LOG[:] = self._audit

    async def asyncSetUp(self):
        created = await meetings_router.create_meeting(
            MeetingCreate(title="False start", source=MeetingSource.online),
            actor=OWNER,
        )
        self.meeting_id = created.id

    async def test_owner_deletes_untouched_meeting(self):
        await meetings_router.delete_meeting(self.meeting_id, actor=OWNER)

        self.assertNotIn(self.meeting_id, store.MEETINGS)
        # The owner access entry is created alongside the meeting; nothing
        # may dangle once the meeting is gone.
        self.assertNotIn(self.meeting_id, store.ACCESS)
        audit = [a for a in store.AUDIT_LOG if a.action == "meeting.delete"]
        self.assertTrue(audit, "delete must be audited")
        self.assertEqual(audit[-1].meeting_id, self.meeting_id)
        self.assertEqual(audit[-1].target, "False start")
        before = json.loads(audit[-1].before or "null")
        self.assertEqual(
            set(before),
            {"id", "title", "source", "owner_id", "created_at", "pipeline_status"},
        )
        self.assertEqual(before["id"], str(self.meeting_id))
        self.assertEqual(before["pipeline_status"], "pending_audio")

    async def test_non_owner_is_forbidden(self):
        # A viewer is on the access list, so require() answers 403 (not the
        # existence-hiding 404 an outsider gets).
        store.ACCESS[self.meeting_id].append(
            MeetingAccessEntry(user=VIEWER, role=AccessRole.viewer)
        )
        with self.assertRaises(HTTPException) as ctx:
            await meetings_router.delete_meeting(self.meeting_id, actor=VIEWER)
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn(self.meeting_id, store.MEETINGS)

    async def test_outsider_cannot_see_meeting(self):
        # Codebase rule (access.require): actors with no access entry get 404
        # so the endpoint does not reveal that the meeting exists.
        with self.assertRaises(HTTPException) as ctx:
            await meetings_router.delete_meeting(self.meeting_id, actor=OUTSIDER)
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn(self.meeting_id, store.MEETINGS)

    async def test_meeting_with_audio_or_pipeline_is_refused(self):
        m = store.MEETINGS[self.meeting_id]
        store.MEETINGS[self.meeting_id] = m.model_copy(
            update={"pipeline_status": PipelineStatus.queued}
        )
        with self.assertRaises(HTTPException) as ctx:
            await meetings_router.delete_meeting(self.meeting_id, actor=OWNER)
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn(self.meeting_id, store.MEETINGS)

    async def test_meeting_with_audio_on_disk_is_refused(self):
        # upload_audio writes the file before flipping pipeline_status, so the
        # on-disk marker must refuse on its own.
        path = audio_path_for(self.meeting_id, "audio/webm")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"")
        try:
            with self.assertRaises(HTTPException) as ctx:
                await meetings_router.delete_meeting(self.meeting_id, actor=OWNER)
            self.assertEqual(ctx.exception.status_code, 409)
            self.assertIn(self.meeting_id, store.MEETINGS)
        finally:
            path.unlink(missing_ok=True)

    async def test_unknown_meeting_is_404(self):
        with self.assertRaises(HTTPException) as ctx:
            await meetings_router.delete_meeting(uuid4(), actor=OWNER)
        self.assertEqual(ctx.exception.status_code, 404)

    async def test_upload_racing_a_delete_is_refused_and_leaves_no_audio(self):
        # Reverse race: DELETE wins while upload_audio is awaiting
        # _prepare_uploaded_audio. The handler must not re-insert the meeting
        # from its stale local copy, and the file it just wrote must not
        # survive as an orphan.
        original = meetings_router._prepare_uploaded_audio

        async def delete_then_prepare(meeting_id, *args, **kwargs):
            store.MEETINGS.pop(meeting_id, None)
            store.ACCESS.pop(meeting_id, None)
            return await original(meeting_id, *args, **kwargs)

        body = UploadAudioRequest(audio_b64=base64.b64encode(b"a" * 2048).decode("ascii"))
        markers = (
            audio_path_for(self.meeting_id, "audio/webm"),
            mic_track_path(self.meeting_id),
        )
        try:
            with (
                patch("app.routers.meetings._prepare_uploaded_audio", new=delete_then_prepare),
                patch("app.routers.meetings.kick_pipeline") as kick,
                self.assertRaises(HTTPException) as ctx,
            ):
                await meetings_router.upload_audio(self.meeting_id, body, actor=OWNER)
            self.assertEqual(ctx.exception.status_code, 409)
            self.assertNotIn(self.meeting_id, store.MEETINGS)
            kick.assert_not_called()
            for path in markers:
                self.assertFalse(path.exists(), f"orphaned audio left behind: {path}")
            self.assertEqual(list(audio_dir().glob(f"{self.meeting_id}.*")), [])
        finally:
            for path in audio_dir().glob(f"{self.meeting_id}.*"):
                path.unlink(missing_ok=True)
