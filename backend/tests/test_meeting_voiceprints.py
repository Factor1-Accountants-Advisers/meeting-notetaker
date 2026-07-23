"""IN-378 meeting-scoped central voiceprint resolution."""

import unittest
from datetime import datetime, timezone
from uuid import UUID

from app.config import get_settings
from app.schemas import (
    GraphMeetingAttendeeMetadata,
    GraphMeetingMetadata,
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
    MeetingVoiceprintResponse,
    StorageApiError,
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


class MeetingResolutionTests(unittest.TestCase):
    def setUp(self):
        self.settings = get_settings().model_copy(
            update={
                "storage_api_enabled": True,
                "storage_api_url": "https://storage.example",
            }
        )

    def test_central_success_is_authoritative_and_called_once(self):
        response = MeetingVoiceprintResponse(
            meeting_id=MEETING_ID,
            records=[_central("invitee@example.com")],
            missing=["organizer@example.com"],
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

    def test_central_success_with_no_records_does_not_revive_local_data(self):
        client = _CapturingClient(
            response=MeetingVoiceprintResponse(
                meeting_id=MEETING_ID,
                records=[],
                missing=["invitee@example.com"],
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
        client = _CapturingClient(error=StorageApiError("temporary outage"))

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

    def test_central_failure_without_relevant_local_data_is_retryable(self):
        client = _CapturingClient(error=StorageApiError("temporary outage"))

        with self.assertRaises(MeetingVoiceprintsUnavailable):
            resolve_meeting_voiceprints(
                _meeting(),
                recorder_email="recorder@example.com",
                access_token="token",
                settings=self.settings,
                client=client,
                local_records=[_local("unrelated@example.com")],
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


if __name__ == "__main__":
    unittest.main()
