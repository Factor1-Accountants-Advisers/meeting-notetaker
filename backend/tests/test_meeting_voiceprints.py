"""IN-378 meeting-scoped central voiceprint resolution."""

import json
import unittest
from datetime import datetime, timezone
from uuid import UUID

from app.config import get_settings
from app.schemas import (
    GraphMeetingAttendeeMetadata,
    GraphMeetingMetadata,
    ManualMeetingAttendee,
    Meeting,
    MeetingSource,
)
from app.services.meeting_voiceprints import (
    MeetingVoiceprintsUnavailable,
    build_meeting_candidates,
    resolve_meeting_voiceprints,
)
from app.services.storage_api import (
    CentralEnrolment,
    MeetingVoiceprintCandidate,
    MeetingVoiceprintResponse,
    RestStorageApiClient,
    StorageApiContractError,
    StorageApiRejected,
    StorageApiUnavailable,
)
from app.services.voiceprints import Voiceprint


MEETING_ID = UUID("9ab402de-a57f-45a6-8cde-4f89902f5d0b")


def _meeting() -> Meeting:
    return Meeting(
        id=MEETING_ID,
        title="Planning",
        source=MeetingSource.online,
        owner_id="owner@example.com",
        created_at=datetime.now(timezone.utc),
        graph_metadata=GraphMeetingMetadata(
            meeting_id="graph-1",
            organizer_email="Organizer@Example.com",
            attendees=[
                GraphMeetingAttendeeMetadata(email=" Invitee@Example.com "),
                GraphMeetingAttendeeMetadata(email="organizer@example.com"),
                GraphMeetingAttendeeMetadata(email=None),
            ],
        ),
    )


def _central(email: str, person_id: str = "oid-1") -> CentralEnrolment:
    now = datetime.now(timezone.utc)
    return CentralEnrolment(
        person_id=person_id,
        email=email,
        display_name="Known Person",
        voiceprints=["opaque"],
        sample_sources=["recorded"],
        model_version="precision-2",
        consent_recorded_at=now,
        created_at=now,
        updated_at=now,
    )


def _local(email: str) -> Voiceprint:
    return Voiceprint(
        employee_id=email,
        display_name="Local Person",
        voiceprints=["local-opaque"],
        model_version="precision-2",
        enrolled_at=datetime.now(timezone.utc).isoformat(),
    )


class _CapturingClient:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls = []

    def get_meeting_voiceprints(self, meeting_id, candidates, access_token):
        self.calls.append((meeting_id, candidates, access_token))
        if self.error:
            raise self.error
        return self.response


class _EnrolledStoreClient:
    """Resolves each call against a fixed enrolled set, like the real API."""

    def __init__(self, enrolled_emails, fail_on_calls=None):
        self.enrolled = set(enrolled_emails)
        self.fail_on_calls = set(fail_on_calls or ())
        self.calls = []

    def get_meeting_voiceprints(self, meeting_id, candidates, access_token):
        self.calls.append((meeting_id, candidates, access_token))
        if len(self.calls) in self.fail_on_calls:
            raise StorageApiUnavailable("temporary outage")
        return MeetingVoiceprintResponse(
            meeting_id=meeting_id,
            records=[
                _central(candidate.email, person_id=f"oid-{candidate.email}")
                for candidate in candidates
                if candidate.email in self.enrolled
            ],
            missing=[
                candidate
                for candidate in candidates
                if candidate.email not in self.enrolled
            ],
        )


class MeetingCandidateTests(unittest.TestCase):
    def test_candidates_are_ordered_normalized_and_deduplicated(self):
        candidates = build_meeting_candidates(
            _meeting(),
            recorder_email=" Recorder@Example.com ",
            expansion_emails=[
                "Expansion@Example.com",
                "invitee@example.com",
            ],
        )

        self.assertEqual(
            [(candidate.email, candidate.source) for candidate in candidates],
            [
                ("invitee@example.com", "invitee"),
                ("organizer@example.com", "invitee"),
                ("recorder@example.com", "recorder"),
                ("expansion@example.com", "controlled_expansion"),
            ],
        )

    def test_owner_email_is_recorder_fallback(self):
        candidates = build_meeting_candidates(
            _meeting(),
            recorder_email=None,
            expansion_emails=[],
        )
        self.assertIn(
            ("owner@example.com", "recorder"),
            [(candidate.email, candidate.source) for candidate in candidates],
        )

    def test_manual_attendees_precede_recorder_and_expansion(self):
        meeting = Meeting(
            id=MEETING_ID,
            title="Ad-hoc planning",
            source=MeetingSource.online,
            owner_id="owner@example.com",
            created_at=datetime.now(timezone.utc),
            manual_attendees=[
                ManualMeetingAttendee(
                    name="David Ahlhaus",
                    email="David@Example.com",
                ),
                ManualMeetingAttendee(
                    name="Benjamin Bryant",
                    email="benjamin@example.com",
                ),
            ],
        )

        candidates = build_meeting_candidates(
            meeting,
            recorder_email="Recorder@Example.com",
            expansion_emails=[
                "david@example.com",
                "expansion@example.com",
            ],
        )

        self.assertEqual(
            [(candidate.email, candidate.source) for candidate in candidates],
            [
                ("david@example.com", "invitee"),
                ("benjamin@example.com", "invitee"),
                ("recorder@example.com", "recorder"),
                ("expansion@example.com", "controlled_expansion"),
            ],
        )


def _large_meeting(attendee_count: int) -> Meeting:
    return Meeting(
        id=MEETING_ID,
        title="Firmwide catchup",
        source=MeetingSource.online,
        owner_id="owner@example.com",
        created_at=datetime.now(timezone.utc),
        graph_metadata=GraphMeetingMetadata(
            meeting_id="large-graph-meeting",
            organizer_email="organizer@example.com",
            attendees=[
                GraphMeetingAttendeeMetadata(
                    email=f"attendee{index:03d}@example.com"
                )
                for index in range(attendee_count)
            ],
        ),
    )


class LargeMeetingCandidateTests(unittest.TestCase):
    """IN-486: >50-invitee meetings must never silently truncate candidates."""

    def test_all_attendees_organizer_and_recorder_are_candidates(self):
        candidates = build_meeting_candidates(
            _large_meeting(101),
            recorder_email="recorder@example.com",
            expansion_emails=[],
        )

        emails = [candidate.email for candidate in candidates]
        self.assertEqual(len(candidates), 103)
        self.assertIn("attendee070@example.com", emails)
        self.assertIn("attendee100@example.com", emails)
        self.assertIn(
            ("organizer@example.com", "organizer"),
            [(candidate.email, candidate.source) for candidate in candidates],
        )
        self.assertIn(
            ("recorder@example.com", "recorder"),
            [(candidate.email, candidate.source) for candidate in candidates],
        )

    def test_pathological_meeting_caps_with_warning_and_keeps_priority_sources(self):
        # IN-486: the defensive overall bound may drop invitees, but never
        # silently and never the organiser/recorder/expansion sources.
        with self.assertLogs(
            "app.services.meeting_voiceprints", level="WARNING"
        ) as logs:
            candidates = build_meeting_candidates(
                _large_meeting(510),
                recorder_email="recorder@example.com",
                expansion_emails=["expansion@example.com"],
            )

        self.assertEqual(len(candidates), 500)
        pairs = {(candidate.email, candidate.source) for candidate in candidates}
        self.assertIn(("organizer@example.com", "organizer"), pairs)
        self.assertIn(("recorder@example.com", "recorder"), pairs)
        self.assertIn(("expansion@example.com", "controlled_expansion"), pairs)
        self.assertTrue(
            any("dropped=13" in message for message in logs.output),
            logs.output,
        )


class MeetingResolutionTests(unittest.TestCase):
    def setUp(self):
        self.settings = get_settings().model_copy(
            update={
                "storage_api_enabled": True,
                "storage_api_url": "https://storage.example",
                # Isolate from the developer's backend.env — a populated
                # expansion list would inflate every candidate count below.
                "voiceprint_expansion_employee_ids": "",
            }
        )

    def test_central_success_is_authoritative_and_called_once(self):
        response = MeetingVoiceprintResponse(
            meeting_id=MEETING_ID,
            records=[_central("invitee@example.com")],
            missing=[
                {
                    "email": "organizer@example.com",
                    "source": "organizer",
                }
            ],
        )
        client = _CapturingClient(response=response)

        result = resolve_meeting_voiceprints(
            _meeting(),
            recorder_email="recorder@example.com",
            access_token="token",
            settings=self.settings,
            client=client,
            local_records=[_local("organizer@example.com")],
        )

        self.assertEqual(len(client.calls), 1)
        self.assertEqual(client.calls[0][0], MEETING_ID)
        self.assertEqual(client.calls[0][2], "token")
        self.assertEqual([record.employee_id for record in result.records], ["invitee@example.com"])
        self.assertFalse(result.degraded)
        self.assertEqual(result.request_count, 1)

    def test_central_success_with_no_records_does_not_revive_local_data(self):
        client = _CapturingClient(
            response=MeetingVoiceprintResponse(
                meeting_id=MEETING_ID,
                records=[],
                missing=[
                    {
                        "email": "invitee@example.com",
                        "source": "invitee",
                    }
                ],
            )
        )

        result = resolve_meeting_voiceprints(
            _meeting(),
            recorder_email="recorder@example.com",
            access_token="token",
            settings=self.settings,
            client=client,
            local_records=[_local("invitee@example.com")],
        )

        self.assertEqual(result.records, [])
        self.assertFalse(result.degraded)

    def test_central_failure_uses_only_relevant_local_fallback(self):
        client = _CapturingClient(error=StorageApiUnavailable("temporary outage"))

        result = resolve_meeting_voiceprints(
            _meeting(),
            recorder_email="recorder@example.com",
            access_token="token",
            settings=self.settings,
            client=client,
            local_records=[
                _local("invitee@example.com"),
                _local("unrelated@example.com"),
            ],
        )

        self.assertEqual([record.employee_id for record in result.records], ["invitee@example.com"])
        self.assertTrue(result.degraded)
        self.assertEqual(result.request_count, 2)  # one attempt + one retry

    def test_large_meeting_lookup_is_paginated_in_batches_of_50(self):
        # IN-486: an enrolled speaker past invite position 50 is identified.
        client = _EnrolledStoreClient(
            enrolled_emails=["attendee070@example.com", "recorder@example.com"]
        )

        result = resolve_meeting_voiceprints(
            _large_meeting(101),
            recorder_email="recorder@example.com",
            access_token="token",
            settings=self.settings,
            client=client,
            local_records=[],
        )

        self.assertEqual(len(client.calls), 3)
        for _, batch, token in client.calls:
            self.assertLessEqual(len(batch), 50)
            self.assertEqual(token, "token")
        requested = [
            candidate.email for _, batch, _ in client.calls for candidate in batch
        ]
        self.assertEqual(len(requested), 103)
        self.assertEqual(len(set(requested)), 103)
        self.assertEqual(
            sorted(record.employee_id for record in result.records),
            ["attendee070@example.com", "recorder@example.com"],
        )
        self.assertFalse(result.degraded)
        self.assertEqual(result.request_count, 3)

    def test_partial_batch_failure_keeps_central_and_falls_back_for_failed_batch(self):
        # 26 Aug Timesheet regression: one failed batch must not discard the
        # answers central already gave. Central stays authoritative for every
        # candidate it ruled on; local fallback covers ONLY the failed batch.
        client = _EnrolledStoreClient(
            enrolled_emails=["attendee000@example.com", "attendee100@example.com"],
            fail_on_calls={2, 3},  # batch 2: first attempt and its retry
        )

        result = resolve_meeting_voiceprints(
            _large_meeting(101),
            recorder_email="recorder@example.com",
            access_token="token",
            settings=self.settings,
            client=client,
            local_records=[
                # In the failed batch — local fills in.
                _local("attendee070@example.com"),
                # Batch 1 succeeded — central's answer stands, no local copy.
                _local("attendee000@example.com"),
            ],
        )

        self.assertTrue(result.degraded)
        self.assertEqual(len(client.calls), 4)
        self.assertEqual(client.calls[1][1], client.calls[2][1])
        self.assertEqual(result.request_count, 4)
        self.assertEqual(
            sorted(record.employee_id for record in result.records),
            [
                "attendee000@example.com",
                "attendee070@example.com",
                "attendee100@example.com",
            ],
        )

    def test_transient_batch_failure_recovers_on_retry(self):
        # A single flaky batch response must not degrade the whole meeting.
        client = _EnrolledStoreClient(
            enrolled_emails=["attendee070@example.com"],
            fail_on_calls={2},
        )

        result = resolve_meeting_voiceprints(
            _large_meeting(101),
            recorder_email="recorder@example.com",
            access_token="token",
            settings=self.settings,
            client=client,
            local_records=[],
        )

        self.assertFalse(result.degraded)
        self.assertEqual(len(client.calls), 4)
        self.assertEqual(result.request_count, 4)
        self.assertEqual(
            [record.employee_id for record in result.records],
            ["attendee070@example.com"],
        )

    def test_fallback_covers_every_candidate_in_large_meetings(self):
        # IN-486: candidates past position 50 keep local-fallback coverage too.
        client = _CapturingClient(error=StorageApiUnavailable("temporary outage"))

        result = resolve_meeting_voiceprints(
            _large_meeting(51),
            recorder_email="recorder@example.com",
            access_token="token",
            settings=self.settings,
            client=client,
            local_records=[
                _local("attendee000@example.com"),
                _local("attendee049@example.com"),
                _local("attendee050@example.com"),
                _local("organizer@example.com"),
                _local("recorder@example.com"),
            ],
        )

        self.assertEqual(
            [record.employee_id for record in result.records],
            [
                "attendee000@example.com",
                "attendee049@example.com",
                "attendee050@example.com",
                "organizer@example.com",
                "recorder@example.com",
            ],
        )
        self.assertTrue(result.degraded)

    def test_central_failure_without_relevant_local_data_is_retryable(self):
        client = _CapturingClient(error=StorageApiUnavailable("temporary outage"))

        with self.assertRaises(MeetingVoiceprintsUnavailable):
            resolve_meeting_voiceprints(
                _meeting(),
                recorder_email="recorder@example.com",
                access_token="token",
                settings=self.settings,
                client=client,
                local_records=[_local("unrelated@example.com")],
            )

    def test_auth_rejection_never_activates_local_fallback(self):
        client = _CapturingClient(error=StorageApiRejected("unauthorized"))

        with self.assertRaises(StorageApiRejected):
            resolve_meeting_voiceprints(
                _meeting(),
                recorder_email="recorder@example.com",
                access_token="token",
                settings=self.settings,
                client=client,
                local_records=[_local("invitee@example.com")],
            )

    def test_contract_failure_never_activates_local_fallback(self):
        client = _CapturingClient(
            error=StorageApiContractError("malformed response")
        )

        with self.assertRaises(StorageApiContractError):
            resolve_meeting_voiceprints(
                _meeting(),
                recorder_email="recorder@example.com",
                access_token="token",
                settings=self.settings,
                client=client,
                local_records=[_local("invitee@example.com")],
            )

    def test_disabled_central_cutover_preserves_legacy_matcher_loading(self):
        settings = self.settings.model_copy(update={"storage_api_enabled": False})

        result = resolve_meeting_voiceprints(
            _meeting(),
            recorder_email="recorder@example.com",
            access_token=None,
            settings=settings,
            client=_CapturingClient(error=AssertionError("must not call")),
            local_records=[],
        )

        self.assertIsNone(result.records)
        self.assertFalse(result.degraded)
        self.assertEqual(result.request_count, 0)


if __name__ == "__main__":
    unittest.main()


class MeetingLookupTimeoutTests(unittest.TestCase):
    def test_meeting_candidates_request_uses_extended_timeout(self):
        # 26 Aug Timesheet: a 3-batch lookup against the sequential server hot
        # path can exceed the default 30s; this endpoint gets a longer budget.
        captured = {}

        class _Response:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                return json.dumps(
                    {"meeting_id": str(MEETING_ID), "records": [], "missing": []}
                ).encode("utf-8")

        def opener(req, timeout=30):
            captured["timeout"] = timeout
            return _Response()

        client = RestStorageApiClient("https://storage.example", opener=opener)
        client.get_meeting_voiceprints(
            MEETING_ID,
            [MeetingVoiceprintCandidate(email="a@example.com", source="invitee")],
            "token-value",
        )

        self.assertEqual(captured["timeout"], 120)
