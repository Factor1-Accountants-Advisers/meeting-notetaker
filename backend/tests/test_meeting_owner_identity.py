import unittest
from uuid import UUID

from pydantic import ValidationError

from app import store
from app.routers.meetings import create_meeting
from app.schemas import (
    AccessRole,
    ManualMeetingAttendee,
    MeetingCreate,
    MeetingSource,
)
from app.services.speaker_matching import _candidate_voiceprints_for_meeting
from app.services.voiceprints import Voiceprint


class MeetingOwnerIdentityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._meetings = dict(store.MEETINGS)
        self._access = {key: list(value) for key, value in store.ACCESS.items()}

    def tearDown(self):
        store.MEETINGS.clear()
        store.MEETINGS.update(self._meetings)
        store.ACCESS.clear()
        store.ACCESS.update(self._access)

    async def test_create_meeting_uses_signed_in_actor_as_owner(self):
        meeting = await create_meeting(
            MeetingCreate(
                title="Manual meeting by David",
                context="Internal",
                source=MeetingSource.in_person,
            ),
            actor="davidahlhaus@factor1.com.au",
        )

        self.assertIsInstance(meeting.id, UUID)
        self.assertEqual(meeting.owner_id, "davidahlhaus@factor1.com.au")
        self.assertEqual(store.MEETINGS[meeting.id].owner_id, "davidahlhaus@factor1.com.au")
        self.assertEqual(store.ACCESS[meeting.id][0].user, "davidahlhaus@factor1.com.au")
        self.assertEqual(store.ACCESS[meeting.id][0].role, AccessRole.owner)

    async def test_create_meeting_persists_normalized_manual_attendees(self):
        meeting = await create_meeting(
            MeetingCreate(
                title="Ad-hoc planning",
                source=MeetingSource.online,
                manual_attendees=[
                    ManualMeetingAttendee(
                        name=" David Ahlhaus ",
                        email=" DAVIDAHLHAUS@Factor1.com.au ",
                    ),
                    ManualMeetingAttendee(
                        name=None,
                        email="benjaminbryant@factor1.com.au",
                    ),
                ],
            ),
            actor="josephguerrero@factor1.com.au",
        )

        self.assertEqual(
            [attendee.model_dump() for attendee in meeting.manual_attendees],
            [
                {
                    "name": "David Ahlhaus",
                    "email": "davidahlhaus@factor1.com.au",
                },
                {
                    "name": None,
                    "email": "benjaminbryant@factor1.com.au",
                },
            ],
        )
        self.assertEqual(
            store.MEETINGS[meeting.id].manual_attendees,
            meeting.manual_attendees,
        )

    def test_manual_attendees_reject_invalid_email_and_more_than_49_people(self):
        with self.assertRaises(ValidationError):
            ManualMeetingAttendee(name="Not an email", email="invalid")

        with self.assertRaises(ValidationError):
            MeetingCreate(
                title="Too many people",
                source=MeetingSource.online,
                manual_attendees=[
                    ManualMeetingAttendee(
                        name=f"Person {index}",
                        email=f"person{index}@factor1.com.au",
                    )
                    for index in range(50)
                ],
            )

    async def test_manual_meeting_owner_selects_recorders_voiceprint_candidate(self):
        meeting = await create_meeting(
            MeetingCreate(
                title="Manual meeting by David",
                context="Internal",
                source=MeetingSource.in_person,
            ),
            actor="davidahlhaus@factor1.com.au",
        )
        records = [
            Voiceprint(
                employee_id="josephguerrero@factor1.com.au",
                display_name="Joseph Miguel Guerrero",
                voiceprints=["joseph-vp"],
                model_version="precision-2",
                enrolled_at="2026-07-03T00:00:00Z",
            ),
            Voiceprint(
                employee_id="davidahlhaus@factor1.com.au",
                display_name="David Ahlhaus",
                voiceprints=["david-vp"],
                model_version="precision-2",
                enrolled_at="2026-07-03T00:00:00Z",
            ),
        ]

        candidates = _candidate_voiceprints_for_meeting(records, meeting)

        self.assertEqual([candidate.employee_id for candidate in candidates], ["davidahlhaus@factor1.com.au"])


if __name__ == "__main__":
    unittest.main()
