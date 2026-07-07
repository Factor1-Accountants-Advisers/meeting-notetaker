"""Seeded voiceprints must satisfy the enrollment gate (Jose T install, 2026-07-07).

Packaged installs seed voiceprints.json on first launch, but store.PEOPLE
starts empty — the People screen showed seeded colleagues as absent and the
renderer's enrollment gate blocked auto-record for users with seeded prints.
"""

import asyncio
import unittest

from app import store
from app.routers.people import ensure_current_staff, list_people
from app.schemas import CurrentUserRequest
from app.services.voiceprints import Voiceprint, get_voiceprint_repository


class SeededEnrollmentSyncTests(unittest.TestCase):
    def setUp(self):
        self._people_backup = list(store.PEOPLE)
        store.PEOPLE[:] = []
        get_voiceprint_repository().enroll(
            Voiceprint(
                employee_id="seeded@factor1.com.au",
                display_name="Seeded Person",
                voiceprints=["opaque-provider-payload"],
                model_version="precision-2",
                enrolled_at="2026-07-07T00:00:00+00:00",
            )
        )

    def tearDown(self):
        store.PEOPLE[:] = self._people_backup

    def test_list_people_reflects_seeded_registry(self):
        people = asyncio.run(list_people())
        seeded = next(p for p in people if p.employee_id == "seeded@factor1.com.au")
        self.assertTrue(seeded.enrolled)
        self.assertEqual(seeded.model_version, "precision-2")
        self.assertEqual(seeded.display_name, "Seeded Person")

    def test_first_sign_in_of_seeded_user_is_enrolled(self):
        person = asyncio.run(
            ensure_current_staff(
                CurrentUserRequest(name="Seeded Person", email="seeded@factor1.com.au"),
                actor="Seeded Person",
            )
        )
        self.assertTrue(person.enrolled)

    def test_unseeded_user_still_starts_not_enrolled(self):
        person = asyncio.run(
            ensure_current_staff(
                CurrentUserRequest(name="Fresh Person", email="fresh@factor1.com.au"),
                actor="Fresh Person",
            )
        )
        self.assertFalse(person.enrolled)
