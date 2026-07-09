import unittest

from app.schemas import GraphMeetingAttendeeMetadata, GraphMeetingMetadata, Meeting, MeetingSource, TranscriptSegment
from app.config import Settings
from app.services.speaker_matching import (
    IdentityRange,
    _apply_identity_ranges,
    _candidate_voiceprints_for_meeting,
    _controlled_expansion_ids_from_settings,
    _merge_expansion_matches,
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

    def test_controlled_expansion_is_capped_and_only_uses_configured_people(self):
        records = [
            vp("david@factor1.com.au", "David Ahlhaus"),
            vp("benjamin@factor1.com.au", "Benjamin Bryant"),
            vp("tc@factor1.com.au", "TC"),
            vp("df@factor1.com.au", "DF"),
            vp("random@factor1.com.au", "Random Person"),
        ]
        meeting = Meeting(
            id=uuid4(),
            title="Expansion cap",
            source=MeetingSource.online,
            owner_id="joseph@factor1.com.au",
            created_at=datetime.now(timezone.utc),
            graph_metadata=GraphMeetingMetadata(
                meeting_id="graph-1",
                organizer_email="david@factor1.com.au",
                attendees=[GraphMeetingAttendeeMetadata(email="benjamin@factor1.com.au", name="Benjamin")],
            ),
        )

        ordered = _candidate_voiceprints_for_meeting(
            records,
            meeting,
            controlled_expansion_employee_ids=["df@factor1.com.au", "tc@factor1.com.au", "random@factor1.com.au"],
            max_controlled_expansion=2,
        )

        self.assertEqual(
            [item.employee_id for item in ordered],
            ["benjamin@factor1.com.au", "david@factor1.com.au", "df@factor1.com.au", "tc@factor1.com.au"],
        )

    def test_controlled_expansion_ids_are_loaded_from_config(self):
        settings = Settings(
            voiceprint_expansion_employee_ids=" df@factor1.com.au, tc@factor1.com.au ,,",
            voiceprint_expansion_cap=1,
        )

        self.assertEqual(_controlled_expansion_ids_from_settings(settings), ["df@factor1.com.au"])

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

    def test_owner_display_name_selects_enrolled_recorder_for_in_person_meeting(self):
        records = [
            vp("josephguerrero@factor1.com.au", "Joseph Miguel Guerrero"),
            vp("outside@example.com", "Outside Person"),
        ]
        meeting = Meeting(
            id=uuid4(),
            title="In person owner display name",
            source=MeetingSource.in_person,
            owner_id="joseph miguel guerrero",
            created_at=datetime.now(timezone.utc),
        )

        ordered = _candidate_voiceprints_for_meeting(records, meeting)

        self.assertEqual([item.employee_id for item in ordered], ["josephguerrero@factor1.com.au"])

    def test_controlled_expansion_candidates_survive_unmatched_owner(self):
        records = [
            vp("davidahlhaus@factor1.com.au", "David Ahlhaus"),
            vp("outside@example.com", "Outside Person"),
        ]
        meeting = Meeting(
            id=uuid4(),
            title="In person unmatched owner",
            source=MeetingSource.in_person,
            owner_id="unmatched display name",
            created_at=datetime.now(timezone.utc),
        )

        ordered = _candidate_voiceprints_for_meeting(
            records,
            meeting,
            controlled_expansion_employee_ids=["davidahlhaus@factor1.com.au"],
        )

        self.assertEqual([item.employee_id for item in ordered], ["davidahlhaus@factor1.com.au"])

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
        self.assertEqual(participants[0].name, "Speaker 1")
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
        self.assertEqual(participants[0].name, "Speaker 1")
        self.assertEqual(matched[0].unknown_reason, "insufficient_overlap")

    def test_expansion_merge_preserves_distinct_segments_in_same_cluster(self):
        """Regression: IN-79 expansion merge must not collapse a cluster to one segment."""
        base = [
            TranscriptSegment(
                speaker="Speaker 1",
                speaker_known=False,
                text="David's actual first sentence",
                start_ms=1000,
                end_ms=3000,
                raw_speaker="SPEAKER_01",
            ),
            TranscriptSegment(
                speaker="Speaker 1",
                speaker_known=False,
                text="David's actual second sentence",
                start_ms=4000,
                end_ms=6000,
                raw_speaker="SPEAKER_01",
            ),
            TranscriptSegment(
                speaker="Speaker 2",
                speaker_known=False,
                text="other speaker text",
                start_ms=7000,
                end_ms=8000,
                raw_speaker="SPEAKER_02",
            ),
        ]
        expanded = [
            TranscriptSegment(
                speaker="David Ahlhaus",
                speaker_known=True,
                text="David's actual first sentence",
                start_ms=1000,
                end_ms=3000,
                raw_speaker="SPEAKER_01",
                speaker_source="pyannote_voiceprint_expansion",
                speaker_confidence=0.90,
            ),
            # This segment did not pass the expansion gate; it must keep its own
            # text/timestamps and remain Unknown rather than inheriting the first
            # known segment object for the whole SPEAKER_01 cluster.
            TranscriptSegment(
                speaker="Speaker 1",
                speaker_known=False,
                text="David's actual second sentence",
                start_ms=4000,
                end_ms=6000,
                raw_speaker="SPEAKER_01",
            ),
            TranscriptSegment(
                speaker="Speaker 2",
                speaker_known=False,
                text="other speaker text",
                start_ms=7000,
                end_ms=8000,
                raw_speaker="SPEAKER_02",
            ),
        ]

        merged, participants, unknown_count = _merge_expansion_matches(base, expanded)

        self.assertEqual(len(merged), 3)
        self.assertEqual(merged[0].speaker, "David Ahlhaus")
        self.assertTrue(merged[0].speaker_known)
        self.assertEqual(merged[0].text, "David's actual first sentence")
        self.assertEqual((merged[0].start_ms, merged[0].end_ms), (1000, 3000))

        self.assertEqual(merged[1].speaker, "Speaker 1")
        self.assertFalse(merged[1].speaker_known)
        self.assertEqual(merged[1].text, "David's actual second sentence")
        self.assertEqual((merged[1].start_ms, merged[1].end_ms), (4000, 6000))

        self.assertEqual(merged[2].speaker, "Speaker 2")
        self.assertFalse(merged[2].speaker_known)
        self.assertEqual(merged[2].text, "other speaker text")
        self.assertEqual((merged[2].start_ms, merged[2].end_ms), (7000, 8000))

        self.assertEqual([(p.name, p.known) for p in participants], [
            ("David Ahlhaus", True),
            ("Speaker 1", False),
            ("Speaker 2", False),
        ])
        self.assertEqual(unknown_count, 2)

    def test_cluster_identity_propagates_to_unmatched_segments(self):
        # IN-86: one raw cluster, identity range covers only the first turn.
        # The whole cluster is David; the rest must not become a phantom Unknown.
        segments = [
            segment("SPEAKER_02", 0, 3000),
            segment("SPEAKER_02", 3000, 6000),
            segment("SPEAKER_02", 6000, 9000),
        ]
        ranges = [
            IdentityRange(
                start_ms=0,
                end_ms=3000,
                raw_speaker="SPEAKER_02",
                display_name="David Ahlhaus",
                confidence=0.9,
                source_label="David #1",
                provider_job_id="job-1",
            )
        ]
        matched, participants, unknown_count = _apply_identity_ranges(segments, ranges)
        self.assertTrue(all(s.speaker == "David Ahlhaus" and s.speaker_known for s in matched))
        self.assertEqual(unknown_count, 0)
        self.assertEqual([(p.name, p.known) for p in participants], [("David Ahlhaus", True)])

    def test_propagation_does_not_leak_across_clusters(self):
        # A different raw cluster with no match stays Unknown (per-cluster only).
        segments = [
            segment("SPEAKER_00", 0, 3000),
            segment("SPEAKER_01", 3000, 6000),
        ]
        ranges = [
            IdentityRange(
                start_ms=0,
                end_ms=3000,
                raw_speaker="SPEAKER_00",
                display_name="David Ahlhaus",
                confidence=0.9,
                source_label="David #1",
                provider_job_id="job-1",
            )
        ]
        matched, participants, unknown_count = _apply_identity_ranges(segments, ranges)
        self.assertEqual(unknown_count, 1)
        self.assertEqual(matched[0].speaker, "David Ahlhaus")
        self.assertFalse(matched[1].speaker_known)
        self.assertEqual(matched[1].speaker, "Speaker 1")


if __name__ == "__main__":
    unittest.main()
