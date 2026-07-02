import unittest

from app.schemas import GraphMeetingAttendeeMetadata, GraphMeetingMetadata, Meeting, MeetingSource, TranscriptSegment
from app.services.speaker_matching import (
    IdentityRange,
    _apply_identity_ranges,
    _candidate_voiceprints_for_meeting,
)
from app.services.voiceprints import Voiceprint
from datetime import datetime, timezone
from uuid import uuid4


def vp(employee_id: str, display_name: str, voiceprints=None) -> Voiceprint:
    return Voiceprint(
        employee_id=employee_id,
        display_name=display_name,
        voiceprints=voiceprints or [f"vp-{employee_id}"],
        model_version="precision-2",
        enrolled_at="2026-07-02T00:00:00Z",
    )


def segment(speaker: str, start: int, end: int) -> TranscriptSegment:
    return TranscriptSegment(
        speaker=speaker,
        speaker_known=False,
        start_ms=start,
        end_ms=end,
        text=f"text from {speaker}",
    )


class SpeakerIdentityMatchingTests(unittest.TestCase):
    def test_attendee_first_candidates_then_organizer_then_controlled_expansion(self):
        records = [
            vp("david@factor1.com.au", "David Ahlhaus"),
            vp("benjamin@factor1.com.au", "Benjamin Bryant"),
            vp("joseph@factor1.com.au", "Joseph Guerrero"),
            vp("outside@example.com", "Outside Person"),
        ]
        meeting = Meeting(
            id=uuid4(),
            title="Candidate order",
            source=MeetingSource.online,
            owner_id="joseph@factor1.com.au",
            created_at=datetime.now(timezone.utc),
            graph_metadata=GraphMeetingMetadata(
                meeting_id="graph-1",
                organizer_email="joseph@factor1.com.au",
                attendees=[
                    GraphMeetingAttendeeMetadata(email="benjamin@factor1.com.au", name="Benjamin"),
                    GraphMeetingAttendeeMetadata(email="david@factor1.com.au", name="David"),
                ],
            ),
        )

        ordered = _candidate_voiceprints_for_meeting(
            records,
            meeting,
            controlled_expansion_employee_ids={"joseph@factor1.com.au"},
        )

        self.assertEqual(
            [item.employee_id for item in ordered],
            ["benjamin@factor1.com.au", "david@factor1.com.au", "joseph@factor1.com.au"],
        )

    def test_owner_alias_selects_enrolled_recorder_for_in_person_meeting(self):
        records = [
            vp("josephguerrero@factor1.com.au", "Joseph Miguel Guerrero"),
            vp("outside@example.com", "Outside Person"),
        ]
        meeting = Meeting(
            id=uuid4(),
            title="In person owner alias",
            source=MeetingSource.in_person,
            owner_id="joseph",
            created_at=datetime.now(timezone.utc),
        )

        ordered = _candidate_voiceprints_for_meeting(records, meeting)

        self.assertEqual([item.employee_id for item in ordered], ["josephguerrero@factor1.com.au"])

    def test_identity_evidence_is_preserved_on_high_confidence_match(self):
        segments = [segment("SPEAKER_00", 0, 5000)]
        ranges = [
            IdentityRange(
                start_ms=0,
                end_ms=5000,
                raw_speaker="SPEAKER_00",
                display_name="Joseph Guerrero",
                confidence=0.92,
                source_label="Joseph #1",
                provider_job_id="job-123",
            )
        ]

        matched, participants, unknown_count = _apply_identity_ranges(segments, ranges)

        self.assertEqual(unknown_count, 0)
        self.assertEqual(participants[0].name, "Joseph Guerrero")
        self.assertTrue(matched[0].speaker_known)
        self.assertEqual(matched[0].raw_speaker, "SPEAKER_00")
        self.assertEqual(matched[0].speaker_source, "pyannote_voiceprint")
        self.assertEqual(matched[0].speaker_confidence, 0.92)
        self.assertEqual(matched[0].speaker_evidence_job_id, "job-123")

    def test_low_confidence_match_stays_unknown_with_reason(self):
        segments = [segment("SPEAKER_00", 0, 5000)]
        ranges = [
            IdentityRange(
                start_ms=0,
                end_ms=5000,
                raw_speaker="SPEAKER_00",
                display_name="Joseph Guerrero",
                confidence=0.40,
                source_label="Joseph #1",
            )
        ]

        matched, participants, unknown_count = _apply_identity_ranges(segments, ranges, min_confidence=0.62)

        self.assertEqual(unknown_count, 1)
        self.assertEqual(participants[0].name, "Unknown 1")
        self.assertFalse(matched[0].speaker_known)
        self.assertEqual(matched[0].raw_speaker, "SPEAKER_00")
        self.assertEqual(matched[0].speaker_source, "unknown")
        self.assertEqual(matched[0].unknown_reason, "low_confidence")

    def test_short_overlap_match_stays_unknown(self):
        segments = [segment("SPEAKER_00", 0, 5000)]
        ranges = [
            IdentityRange(
                start_ms=4500,
                end_ms=5000,
                raw_speaker="SPEAKER_00",
                display_name="Joseph Guerrero",
                confidence=0.99,
                source_label="Joseph #1",
            )
        ]

        matched, participants, unknown_count = _apply_identity_ranges(segments, ranges)

        self.assertEqual(unknown_count, 1)
        self.assertEqual(participants[0].name, "Unknown 1")
        self.assertEqual(matched[0].unknown_reason, "insufficient_overlap")


if __name__ == "__main__":
    unittest.main()
