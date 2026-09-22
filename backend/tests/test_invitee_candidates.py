"""IN-488: who the owner is asked about.

The list is computed backend-side because the domain allowlist lives there,
and it is the exact list the toast and the in-app card display. "5 invitees"
must always mean five OTHER people who are allowed to receive it.
"""

import unittest
from datetime import datetime, timezone
from uuid import uuid4

from app.schemas import (
    GraphMeetingAttendeeMetadata,
    GraphMeetingMetadata,
    ManualMeetingAttendee,
    Meeting,
    MeetingSource,
)
from app.services.recipient_policy import invitee_candidates


def _meeting(graph_metadata=None, source=MeetingSource.online, manual_attendees=None):
    return Meeting(
        id=uuid4(),
        title="Test",
        source=source,
        owner_id="joseph",
        created_at=datetime.now(timezone.utc),
        graph_metadata=graph_metadata,
        manual_attendees=manual_attendees or [],
    )


def _calendar(attendees, organizer="joseph@factor1.com.au"):
    return GraphMeetingMetadata(
        meeting_id="evt-1",
        organizer_email=organizer,
        attendees=attendees,
    )


def _pairs(candidates):
    return [(c.name, c.email) for c in candidates]


class InviteeCandidateTests(unittest.TestCase):
    def test_calendar_meeting_uses_graph_attendees_with_names(self):
        meeting = _meeting(
            _calendar(
                [
                    GraphMeetingAttendeeMetadata(name="David Ahlhaus", email="da@factor1.com.au"),
                    GraphMeetingAttendeeMetadata(name="Mel Tran", email="mel@factor1.com.au"),
                ]
            )
        )
        self.assertEqual(
            _pairs(invitee_candidates(meeting, "joseph@factor1.com.au")),
            [("David Ahlhaus", "da@factor1.com.au"), ("Mel Tran", "mel@factor1.com.au")],
        )

    def test_ad_hoc_recording_uses_the_attendee_picker(self):
        meeting = _meeting(
            source=MeetingSource.in_person,
            manual_attendees=[ManualMeetingAttendee(name="David Ahlhaus", email="da@factor1.com.au")],
        )
        self.assertEqual(
            _pairs(invitee_candidates(meeting, "joseph@factor1.com.au")),
            [("David Ahlhaus", "da@factor1.com.au")],
        )

    def test_organizer_and_recorder_are_never_candidates(self):
        meeting = _meeting(
            _calendar(
                [
                    GraphMeetingAttendeeMetadata(email="Organizer@Factor1.com.au"),
                    GraphMeetingAttendeeMetadata(email="recorder@factor1.com.au"),
                    GraphMeetingAttendeeMetadata(email="da@factor1.com.au"),
                ],
                organizer="organizer@factor1.com.au",
            )
        )
        self.assertEqual(
            _pairs(invitee_candidates(meeting, " Recorder@factor1.com.au ")),
            [(None, "da@factor1.com.au")],
        )

    def test_recorder_who_picked_themselves_is_excluded_from_ad_hoc(self):
        meeting = _meeting(
            source=MeetingSource.in_person,
            manual_attendees=[
                ManualMeetingAttendee(email="joseph@factor1.com.au"),
                ManualMeetingAttendee(email="da@factor1.com.au"),
            ],
        )
        self.assertEqual(
            _pairs(invitee_candidates(meeting, "joseph@factor1.com.au")),
            [(None, "da@factor1.com.au")],
        )

    def test_external_addresses_never_appear(self):
        # 7 Aug 2026: an interview transcript reached a candidate's gmail.
        meeting = _meeting(
            _calendar(
                [
                    GraphMeetingAttendeeMetadata(email="da@factor1.com.au"),
                    GraphMeetingAttendeeMetadata(email="juliannplatero@gmail.com"),
                    GraphMeetingAttendeeMetadata(email="staff@eager.com.au"),
                ]
            )
        )
        self.assertEqual(
            [c.email for c in invitee_candidates(meeting, "joseph@factor1.com.au")],
            ["da@factor1.com.au", "staff@eager.com.au"],
        )

    def test_all_external_means_no_candidates_so_no_prompt(self):
        meeting = _meeting(_calendar([GraphMeetingAttendeeMetadata(email="someone@gmail.com")]))
        self.assertEqual(invitee_candidates(meeting, "joseph@factor1.com.au"), [])

    def test_duplicates_collapse_case_insensitively_and_first_name_wins(self):
        meeting = _meeting(
            _calendar(
                [
                    GraphMeetingAttendeeMetadata(name="David Ahlhaus", email="DA@factor1.com.au"),
                    GraphMeetingAttendeeMetadata(name="D. Ahlhaus", email="da@factor1.com.au"),
                ]
            )
        )
        self.assertEqual(
            _pairs(invitee_candidates(meeting, "joseph@factor1.com.au")),
            [("David Ahlhaus", "da@factor1.com.au")],
        )

    def test_attendee_without_an_email_is_skipped_and_blank_name_is_none(self):
        meeting = _meeting(
            _calendar(
                [
                    GraphMeetingAttendeeMetadata(name="Boardroom", email=None),
                    GraphMeetingAttendeeMetadata(name="   ", email="da@factor1.com.au"),
                ]
            )
        )
        self.assertEqual(
            _pairs(invitee_candidates(meeting, "joseph@factor1.com.au")),
            [(None, "da@factor1.com.au")],
        )

    def test_calendar_branch_wins_when_manual_attendees_are_also_present(self):
        meeting = _meeting(
            _calendar([GraphMeetingAttendeeMetadata(email="da@factor1.com.au")]),
            manual_attendees=[ManualMeetingAttendee(email="mel@factor1.com.au")],
        )
        self.assertEqual(
            [c.email for c in invitee_candidates(meeting, "joseph@factor1.com.au")],
            ["da@factor1.com.au"],
        )


if __name__ == "__main__":
    unittest.main()
