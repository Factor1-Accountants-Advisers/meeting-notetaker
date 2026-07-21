"""IN-379: central voiceprint enrolment through the Storage API seam."""

import unittest
from datetime import datetime, timezone

from app import store
from app.schemas import PersonEnrollment
from app.services import storage_api
from app.services.storage_api import CentralEnrolment, StorageApiError, StubStorageApiClient


def _enrolment(person_id="joseph@factor1.com.au") -> CentralEnrolment:
    return CentralEnrolment(
        person_id=person_id,
        display_name="Joseph Guerrero",
        voiceprints=["vp1", "vp2", "vp3"],
        sample_sources=["recorded", "recorded", "uploaded"],
        model_version="precision-2",
        consent_recorded_at=datetime.now(timezone.utc),
    )


class StorageApiSeamTests(unittest.TestCase):
    def setUp(self):
        storage_api.reset_stub_for_tests()

    def test_central_enrolment_not_required_when_url_empty(self):
        self.assertFalse(storage_api.central_enrolment_required())

    def test_factory_returns_stub_when_url_empty(self):
        client = storage_api.get_storage_api_client()
        self.assertIsInstance(client, StubStorageApiClient)

    def test_stub_register_and_get_roundtrip_upserts(self):
        client = storage_api.get_storage_api_client()
        enrolment = _enrolment()
        first = client.register_voiceprint(enrolment, None)

        fetched = client.get_enrolment("joseph@factor1.com.au", None)
        self.assertIsNotNone(fetched)
        self.assertEqual(fetched.status, "active")
        self.assertEqual(len(fetched.voiceprints), 3)

        second = client.register_voiceprint(enrolment, None)
        self.assertEqual(second.created_at, first.created_at)
        self.assertGreaterEqual(second.updated_at, first.updated_at)

    def test_stub_get_unknown_person_returns_none(self):
        client = storage_api.get_storage_api_client()
        self.assertIsNone(client.get_enrolment("nobody@factor1.com.au", None))

    def test_stub_failure_injection_raises_storage_api_error(self):
        client = storage_api.get_storage_api_client()
        client.fail_next = True
        enrolment = _enrolment()
        with self.assertRaises(StorageApiError):
            client.register_voiceprint(enrolment, None)


class ConsentEnforcementTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._people_backup = list(store.PEOPLE)
        self._audit_backup = list(store.AUDIT_LOG)
        store.PEOPLE.append(
            PersonEnrollment(
                employee_id="joseph@factor1.com.au",
                display_name="Joseph Guerrero",
                role="Factor1 staff",
                enrolled=False,
            )
        )

    def tearDown(self):
        store.PEOPLE[:] = self._people_backup
        store.AUDIT_LOG[:] = self._audit_backup

    async def test_enroll_without_consent_returns_422_before_any_provider_call(self):
        from fastapi import HTTPException

        from app.routers.people import enroll
        from app.schemas import EnrollRequest

        body = EnrollRequest(clips_b64=["QUJD" * 400] * 3, consent_confirmed=False)
        with self.assertRaises(HTTPException) as ctx:
            await enroll("joseph@factor1.com.au", body, actor="Joseph")
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertIn("consent", ctx.exception.detail.lower())

    def test_person_enrollment_defaults_are_backward_compatible(self):
        person = PersonEnrollment(
            employee_id="x@factor1.com.au", display_name="X", enrolled=False
        )
        self.assertFalse(person.centrally_enrolled)
        self.assertIsNone(person.consent_recorded_at)


if __name__ == "__main__":
    unittest.main()
