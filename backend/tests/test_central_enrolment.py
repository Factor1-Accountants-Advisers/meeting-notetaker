"""IN-379: central voiceprint enrolment through the Storage API seam."""

import unittest
from datetime import datetime, timezone

from app.services import storage_api
from app.services.storage_api import CentralEnrolment, StorageApiError, StubStorageApiClient


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
        enrolment = CentralEnrolment(
            person_id="joseph@factor1.com.au",
            display_name="Joseph Guerrero",
            voiceprints=["vp1", "vp2", "vp3"],
            sample_sources=["recorded", "recorded", "uploaded"],
            model_version="precision-2",
            consent_recorded_at=datetime.now(timezone.utc),
        )
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
        enrolment = CentralEnrolment(
            person_id="joseph@factor1.com.au",
            display_name="Joseph Guerrero",
            voiceprints=["vp1"],
            sample_sources=["recorded"],
            model_version="precision-2",
            consent_recorded_at=datetime.now(timezone.utc),
        )
        with self.assertRaises(StorageApiError):
            client.register_voiceprint(enrolment, None)


if __name__ == "__main__":
    unittest.main()
