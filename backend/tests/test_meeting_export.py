"""IN-384: canonical structured meeting-output JSON export.

The export is the platform data contract consumed by The Conductor and The
Assistant (storage integration brief v0.2 §2/§6). These tests pin the exact
field set, snake_case names, ISO 8601 UTC timestamps, and honest null
handling before the builder exists.
"""

import asyncio
import json
import unittest
from datetime import date, datetime, timezone
from uuid import uuid4

from pydantic import ValidationError

from app import store
from app.paths import snapshot_path
from app.routers import meetings as meetings_router
from app.schemas import (
    AccessRole,
    ActionItem,
    GraphMeetingAttendeeMetadata,
    GraphMeetingMetadata,
    ManualMeetingAttendee,
    Meeting,
    MeetingAccessEntry,
    MeetingParticipant,
    MeetingSource,
    NameSpeakerRequest,
    PipelineStatus,
    Priority,
    TranscriptSegment,
)
from app.services import pipeline
from app.services.meeting_export import (
    SCHEMA_VERSION,
    MeetingExport,
    build_meeting_export,
    build_meeting_export_for,
    refresh_meeting_export,
)

EXPECTED_TOP_LEVEL_KEYS = {
    "meeting_id",
    "meeting_type",
    "meeting_name",
    "organiser_name",
    "organiser_email",
    "scheduled_start",
    "actual_duration_seconds",
    "full_invitee_list",
    "meeting_description",
    "transcript",
    "summary",
    "key_points",
    "action_items",
    "follow_ups",
    "schema_version",
    "graph_event_id",
    "graph_ical_uid",
    "graph_online_meeting_id",
}

EXPECTED_TRANSCRIPT_KEYS = {"speaker", "text", "start", "end", "confidence", "speaker_source"}

EXPECTED_ACTION_ITEM_KEYS = {
    "description",
    "owner_name",
    "owner_email",
    "owner_confidence",
    "owner_source",
    "action_type",
    "due_date",
    "assigned_to",
    "assigned_to_department",
}

EXPECTED_INVITEE_KEYS = {"name", "email"}


def _meeting(**overrides) -> Meeting:
    defaults = dict(
        id=uuid4(),
        title="Weekly ops catch-up",
        source=MeetingSource.online,
        owner_id="joseph",
        created_at=datetime.now(timezone.utc),
        duration_seconds=1830,
        pipeline_status=PipelineStatus.ready,
    )
    defaults.update(overrides)
    return Meeting(**defaults)


def _graph_metadata(**overrides) -> GraphMeetingMetadata:
    defaults = dict(
        title="Weekly ops catch-up",
        meeting_id="graph-event-1",
        attendees=[
            GraphMeetingAttendeeMetadata(
                name="Joseph Guerrero", email="josephguerrero@factor1.com.au", response="accepted"
            ),
            GraphMeetingAttendeeMetadata(
                name="David Ahlhaus", email="davidahlhaus@factor1.com.au", response="declined"
            ),
        ],
        organizer_email="davidahlhaus@factor1.com.au",
        organizer_name="David Ahlhaus",
        scheduled_start_utc="2026-07-21T02:00:00Z",
        description="Fortnightly operations sync.",
        ical_uid="ical-uid-1",
    )
    defaults.update(overrides)
    return GraphMeetingMetadata(**defaults)


def _segment(**overrides) -> TranscriptSegment:
    defaults = dict(
        speaker="Joseph Guerrero",
        speaker_known=True,
        text="Let's get started.",
        start_ms=1500,
        end_ms=4750,
        speaker_source="pyannote_voiceprint",
        speaker_confidence=0.7,
    )
    defaults.update(overrides)
    return TranscriptSegment(**defaults)


def _export_dict(meeting, segments=(), summary=None, action_items=()) -> dict:
    export = build_meeting_export(
        meeting, list(segments), summary, list(action_items)
    )
    return export.model_dump(mode="json")


class MeetingExportBuilderTests(unittest.TestCase):
    def test_export_contains_exact_top_level_fields(self):
        data = _export_dict(_meeting(graph_metadata=_graph_metadata()), [_segment()], "A summary.")
        self.assertEqual(set(data.keys()), EXPECTED_TOP_LEVEL_KEYS)

    def test_schema_version_is_1_0(self):
        self.assertEqual(SCHEMA_VERSION, "1.0")
        data = _export_dict(_meeting())
        self.assertEqual(data["schema_version"], "1.0")

    def test_transcript_maps_milliseconds_to_seconds_and_preserves_evidence(self):
        data = _export_dict(_meeting(), [_segment(start_ms=1500, end_ms=4750)])
        self.assertEqual(len(data["transcript"]), 1)
        entry = data["transcript"][0]
        self.assertEqual(set(entry.keys()), EXPECTED_TRANSCRIPT_KEYS)
        self.assertEqual(entry["start"], 1.5)
        self.assertEqual(entry["end"], 4.75)
        self.assertEqual(entry["speaker"], "Joseph Guerrero")
        self.assertEqual(entry["confidence"], 0.7)
        self.assertEqual(entry["speaker_source"], "pyannote_voiceprint")

    def test_action_items_map_known_fields_and_null_unavailable_ones(self):
        meeting = _meeting()
        item = ActionItem(
            id=uuid4(),
            meeting_id=meeting.id,
            owner="Joseph Guerrero",
            description="Send the revised budget",
            deadline=date(2026, 8, 1),
            priority=Priority.high,
        )
        data = _export_dict(meeting, action_items=[item])
        self.assertEqual(len(data["action_items"]), 1)
        entry = data["action_items"][0]
        self.assertEqual(set(entry.keys()), EXPECTED_ACTION_ITEM_KEYS)
        self.assertEqual(entry["description"], "Send the revised budget")
        self.assertEqual(entry["owner_name"], "Joseph Guerrero")
        self.assertEqual(entry["due_date"], "2026-08-01")
        for null_field in (
            "owner_email",
            "owner_confidence",
            "owner_source",
            "action_type",
            "assigned_to",
            "assigned_to_department",
        ):
            self.assertIsNone(entry[null_field], null_field)

    def test_meeting_type_client_when_any_external_invitee(self):
        metadata = _graph_metadata(
            attendees=[
                GraphMeetingAttendeeMetadata(name="Joseph", email="joseph@factor1.com.au"),
                GraphMeetingAttendeeMetadata(name="Client", email="Contact@ACMECORP.com"),
            ]
        )
        data = _export_dict(_meeting(graph_metadata=metadata))
        self.assertEqual(data["meeting_type"], "client")

    def test_meeting_type_internal_when_all_invitees_factor1(self):
        metadata = _graph_metadata(
            attendees=[
                GraphMeetingAttendeeMetadata(name="Joseph", email="JOSEPH@FACTOR1.COM.AU"),
                GraphMeetingAttendeeMetadata(name="David", email="davidahlhaus@factor1.com.au"),
            ]
        )
        data = _export_dict(_meeting(graph_metadata=metadata))
        self.assertEqual(data["meeting_type"], "internal")

    def test_meeting_type_internal_fallback_without_usable_emails(self):
        no_email = _graph_metadata(
            attendees=[GraphMeetingAttendeeMetadata(name="Walk-in guest", email=None)]
        )
        self.assertEqual(_export_dict(_meeting(graph_metadata=no_email))["meeting_type"], "internal")
        self.assertEqual(_export_dict(_meeting(graph_metadata=None))["meeting_type"], "internal")

    def test_invitees_retained_regardless_of_rsvp_and_deduped_case_insensitively(self):
        metadata = _graph_metadata(
            attendees=[
                GraphMeetingAttendeeMetadata(
                    name="Joseph Guerrero", email="josephguerrero@factor1.com.au", response="accepted"
                ),
                GraphMeetingAttendeeMetadata(
                    name="Joseph Guerrero", email="JosephGuerrero@Factor1.com.au", response="none"
                ),
                GraphMeetingAttendeeMetadata(
                    name="David Ahlhaus", email="davidahlhaus@factor1.com.au", response="declined"
                ),
                GraphMeetingAttendeeMetadata(name="Boardroom guest", email=None),
            ]
        )
        data = _export_dict(_meeting(graph_metadata=metadata))
        invitees = data["full_invitee_list"]
        # Duplicate email collapses; declined and email-less invitees survive.
        self.assertEqual(len(invitees), 3)
        for entry in invitees:
            self.assertEqual(set(entry.keys()), EXPECTED_INVITEE_KEYS)
        emails = [i["email"] for i in invitees]
        self.assertIn("davidahlhaus@factor1.com.au", emails)
        self.assertIn(None, emails)
        self.assertEqual(
            len([e for e in emails if e and e.lower() == "josephguerrero@factor1.com.au"]), 1
        )

    def test_manual_attendees_are_exported_without_changing_manual_type_fallback(self):
        data = _export_dict(
            _meeting(
                graph_metadata=None,
                manual_attendees=[
                    ManualMeetingAttendee(
                        name="David Ahlhaus",
                        email="davidahlhaus@factor1.com.au",
                    ),
                    ManualMeetingAttendee(
                        name="Benjamin Bryant",
                        email="benjaminbryant@factor1.com.au",
                    ),
                ],
            )
        )

        self.assertEqual(
            data["full_invitee_list"],
            [
                {
                    "name": "David Ahlhaus",
                    "email": "davidahlhaus@factor1.com.au",
                },
                {
                    "name": "Benjamin Bryant",
                    "email": "benjaminbryant@factor1.com.au",
                },
            ],
        )
        self.assertEqual(data["meeting_type"], "internal")

    def test_missing_optional_sources_serialize_as_null_or_empty_without_dropping_keys(self):
        data = _export_dict(_meeting(graph_metadata=None, duration_seconds=None))
        self.assertEqual(set(data.keys()), EXPECTED_TOP_LEVEL_KEYS)
        self.assertIsNone(data["organiser_name"])
        self.assertIsNone(data["organiser_email"])
        self.assertIsNone(data["scheduled_start"])
        self.assertIsNone(data["actual_duration_seconds"])
        self.assertIsNone(data["meeting_description"])
        self.assertIsNone(data["summary"])
        self.assertEqual(data["full_invitee_list"], [])
        self.assertEqual(data["transcript"], [])
        self.assertEqual(data["action_items"], [])
        self.assertEqual(data["key_points"], [])
        self.assertEqual(data["follow_ups"], [])

    def test_graph_identifiers_are_mapped_honestly(self):
        data = _export_dict(_meeting(graph_metadata=_graph_metadata()))
        self.assertEqual(data["graph_event_id"], "graph-event-1")
        self.assertEqual(data["graph_ical_uid"], "ical-uid-1")
        # The true Teams online meeting id is not captured in Slice 1;
        # exporting null beats exporting the iCalUId under a wrong name.
        self.assertIsNone(data["graph_online_meeting_id"])

    def test_legacy_online_meeting_id_field_backfills_ical_uid(self):
        # Slice 1 normalisation stored iCalUId in online_meeting_id
        # (src/main/graph/normalise.ts); old snapshots only have that field.
        metadata = _graph_metadata(ical_uid=None, online_meeting_id="legacy-ical-uid")
        data = _export_dict(_meeting(graph_metadata=metadata))
        self.assertEqual(data["graph_ical_uid"], "legacy-ical-uid")
        self.assertIsNone(data["graph_online_meeting_id"])

    def test_graph_metadata_scheduled_start_organiser_and_description_flow_through(self):
        data = _export_dict(_meeting(graph_metadata=_graph_metadata()))
        self.assertEqual(data["organiser_name"], "David Ahlhaus")
        self.assertEqual(data["organiser_email"], "davidahlhaus@factor1.com.au")
        self.assertEqual(data["meeting_description"], "Fortnightly operations sync.")
        self.assertEqual(data["scheduled_start"], "2026-07-21T02:00:00Z")
        parsed = datetime.fromisoformat(data["scheduled_start"].replace("Z", "+00:00"))
        self.assertEqual(parsed.utcoffset().total_seconds(), 0)

    def test_meeting_name_and_duration_come_from_the_canonical_meeting(self):
        meeting = _meeting(title="Q1 client review", duration_seconds=2400)
        data = _export_dict(meeting)
        self.assertEqual(data["meeting_name"], "Q1 client review")
        self.assertEqual(data["actual_duration_seconds"], 2400)
        self.assertEqual(data["meeting_id"], str(meeting.id))


class MeetingExportContractTests(unittest.TestCase):
    """The v1.0 contract must reject values downstream consumers cannot trust."""

    def _valid_kwargs(self, **overrides) -> dict:
        kwargs = dict(meeting_id=str(uuid4()), meeting_type="internal", meeting_name="Contract test")
        kwargs.update(overrides)
        return kwargs

    def test_meeting_type_rejects_values_outside_contract(self):
        with self.assertRaises(ValidationError):
            MeetingExport(**self._valid_kwargs(meeting_type="external"))

    def test_schema_version_rejects_other_values(self):
        with self.assertRaises(ValidationError):
            MeetingExport(**self._valid_kwargs(schema_version="2.0"))

    def test_owner_confidence_is_the_categorical_scale_from_the_structured_output_plan(self):
        # docs/implementation-plans/2026-07-01-long-meeting-pipeline-slice1-plan.md
        # defines owner_confidence as "high|medium|low|unknown".
        from app.services.meeting_export import ExportActionItem

        for level in ("high", "medium", "low", "unknown"):
            self.assertEqual(
                ExportActionItem(description="x", owner_confidence=level).owner_confidence,
                level,
            )
        self.assertIsNone(ExportActionItem(description="x").owner_confidence)
        for invalid in (0.7, "certain"):
            with self.assertRaises(ValidationError, msg=repr(invalid)):
                ExportActionItem(description="x", owner_confidence=invalid)

    def test_scheduled_start_rejects_malformed_or_naive_timestamps(self):
        for bad in ("not-a-date", "2026-07-21T02:00:00"):
            with self.assertRaises(ValidationError, msg=bad):
                MeetingExport(**self._valid_kwargs(scheduled_start=bad))

    def test_scheduled_start_normalises_non_utc_offsets_to_utc(self):
        export = MeetingExport(
            **self._valid_kwargs(scheduled_start="2026-07-21T12:00:00+10:00")
        )
        self.assertEqual(export.model_dump(mode="json")["scheduled_start"], "2026-07-21T02:00:00Z")

    def test_builder_normalises_offset_and_nulls_unparseable_scheduled_start(self):
        offset = _graph_metadata(scheduled_start_utc="2026-07-21T12:00:00+10:00")
        data = _export_dict(_meeting(graph_metadata=offset))
        self.assertEqual(data["scheduled_start"], "2026-07-21T02:00:00Z")
        # A metadata formatting wart must degrade to null, never fail the pipeline.
        garbage = _graph_metadata(scheduled_start_utc="whenever suits")
        self.assertIsNone(_export_dict(_meeting(graph_metadata=garbage))["scheduled_start"])


class MeetingExportStoreTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._old_state = {
            "meetings": dict(store.MEETINGS),
            "access": {k: list(v) for k, v in store.ACCESS.items()},
            "summaries": dict(store.SUMMARIES),
            "summary_html": dict(store.SUMMARY_HTML),
            "participants": {k: list(v) for k, v in store.PARTICIPANTS.items()},
            "transcripts": {k: list(v) for k, v in store.TRANSCRIPTS.items()},
            "actions": dict(store.ACTION_ITEMS),
            "audit": list(store.AUDIT_LOG),
            "exports": dict(store.MEETING_EXPORTS),
        }

    def tearDown(self):
        store.MEETINGS.clear()
        store.MEETINGS.update(self._old_state["meetings"])
        store.ACCESS.clear()
        store.ACCESS.update(self._old_state["access"])
        store.SUMMARIES.clear()
        store.SUMMARIES.update(self._old_state["summaries"])
        store.SUMMARY_HTML.clear()
        store.SUMMARY_HTML.update(self._old_state["summary_html"])
        store.PARTICIPANTS.clear()
        store.PARTICIPANTS.update(self._old_state["participants"])
        store.TRANSCRIPTS.clear()
        store.TRANSCRIPTS.update(self._old_state["transcripts"])
        store.ACTION_ITEMS.clear()
        store.ACTION_ITEMS.update(self._old_state["actions"])
        store.AUDIT_LOG[:] = self._old_state["audit"]
        store.MEETING_EXPORTS.clear()
        store.MEETING_EXPORTS.update(self._old_state["exports"])
        store.save_snapshot()

    def _seed_ready_meeting(self) -> Meeting:
        meeting = _meeting(graph_metadata=_graph_metadata())
        store.MEETINGS[meeting.id] = meeting
        store.ACCESS[meeting.id] = [MeetingAccessEntry(user="Joseph", role=AccessRole.owner)]
        store.SUMMARIES[meeting.id] = "A stored summary."
        store.PARTICIPANTS[meeting.id] = [MeetingParticipant(name="Speaker 1", known=False)]
        store.TRANSCRIPTS[meeting.id] = [
            _segment(speaker="Speaker 1", speaker_known=False, speaker_source="unknown")
        ]
        return meeting

    def test_build_for_missing_meeting_returns_none(self):
        self.assertIsNone(build_meeting_export_for(uuid4()))

    def test_build_for_reads_scattered_stores(self):
        meeting = self._seed_ready_meeting()
        export = build_meeting_export_for(meeting.id)
        data = export.model_dump(mode="json")
        self.assertEqual(data["summary"], "A stored summary.")
        self.assertEqual(len(data["transcript"]), 1)

    async def test_pipeline_success_produces_canonical_artifact(self):
        meeting = _meeting(
            source=MeetingSource.upload,
            graph_metadata=_graph_metadata(),
            pipeline_status=PipelineStatus.queued,
        )
        store.MEETINGS[meeting.id] = meeting
        await pipeline.run_pipeline(meeting.id, pipeline.audio_path_for(meeting.id, "audio/webm"))
        self.assertEqual(
            store.MEETINGS[meeting.id].pipeline_status, PipelineStatus.ready
        )
        artifact = store.MEETING_EXPORTS.get(meeting.id)
        self.assertIsNotNone(artifact)
        self.assertEqual(artifact["schema_version"], "1.0")
        self.assertEqual(set(artifact.keys()), EXPECTED_TOP_LEVEL_KEYS)

    def test_snapshot_roundtrip_preserves_export_artifact(self):
        meeting = self._seed_ready_meeting()
        refresh_meeting_export(meeting.id)
        self.assertIn(meeting.id, store.MEETING_EXPORTS)
        store.save_snapshot()
        store.MEETING_EXPORTS.clear()
        self.assertTrue(store.load_snapshot())
        self.assertIn(meeting.id, store.MEETING_EXPORTS)
        self.assertEqual(store.MEETING_EXPORTS[meeting.id]["schema_version"], "1.0")

    def test_older_snapshot_without_export_key_still_loads(self):
        self._seed_ready_meeting()
        store.save_snapshot()
        raw = json.loads(snapshot_path().read_text(encoding="utf-8"))
        raw.pop("meeting_exports", None)
        snapshot_path().write_text(json.dumps(raw), encoding="utf-8")
        self.assertTrue(store.load_snapshot())

    async def test_reprocessing_invalidates_export_and_replaces_action_items(self):
        meeting = self._seed_ready_meeting()
        stale_item_id = uuid4()
        store.ACTION_ITEMS[stale_item_id] = ActionItem(
            id=stale_item_id,
            meeting_id=meeting.id,
            owner="Joseph Guerrero",
            description="Obsolete item from the first processing run",
        )
        refresh_meeting_export(meeting.id)
        self.assertIn(meeting.id, store.MEETING_EXPORTS)

        # Fresh audio accepted / run queued: the stale artifact must not be
        # readable while the meeting reprocesses.
        pipeline.kick_pipeline(
            meeting.id, pipeline.audio_path_for(meeting.id, "audio/webm")
        )
        self.assertNotIn(meeting.id, store.MEETING_EXPORTS)

        await asyncio.gather(*pipeline._PIPELINE_TASKS)
        self.assertEqual(store.MEETINGS[meeting.id].pipeline_status, PipelineStatus.ready)
        # A new canonical export exists and the prior run's items are gone
        # (stub LLM returns none), not accumulated alongside new ones.
        self.assertIn(meeting.id, store.MEETING_EXPORTS)
        self.assertNotIn(stale_item_id, store.ACTION_ITEMS)
        remaining = [
            i for i in store.ACTION_ITEMS.values() if i.meeting_id == meeting.id
        ]
        self.assertEqual(remaining, [])
        self.assertEqual(store.MEETING_EXPORTS[meeting.id]["action_items"], [])

    def test_snapshot_load_drops_invalid_export_entries_but_keeps_valid_ones(self):
        meeting = self._seed_ready_meeting()
        refresh_meeting_export(meeting.id)
        store.save_snapshot()
        raw = json.loads(snapshot_path().read_text(encoding="utf-8"))
        raw["meeting_exports"][str(uuid4())] = {"schema_version": "9.9", "junk": True}
        snapshot_path().write_text(json.dumps(raw), encoding="utf-8")
        self.assertTrue(store.load_snapshot())
        # The corrupt derived artifact is dropped; the valid one survives.
        self.assertEqual(len(store.MEETING_EXPORTS), 1)
        self.assertIn(meeting.id, store.MEETING_EXPORTS)

    async def test_post_ready_speaker_naming_refreshes_stored_export(self):
        meeting = self._seed_ready_meeting()
        refresh_meeting_export(meeting.id)
        self.assertEqual(
            store.MEETING_EXPORTS[meeting.id]["transcript"][0]["speaker"], "Speaker 1"
        )
        await meetings_router.name_speaker(
            meeting.id,
            NameSpeakerRequest(label="Speaker 1", name="Ayda Thom"),
            actor="Joseph",
        )
        self.assertEqual(
            store.MEETING_EXPORTS[meeting.id]["transcript"][0]["speaker"], "Ayda Thom"
        )


if __name__ == "__main__":
    unittest.main()
