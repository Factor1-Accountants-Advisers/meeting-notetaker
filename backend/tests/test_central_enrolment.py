"""IN-379: central voiceprint enrolment through the Storage API seam."""

import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pydantic
from fastapi import HTTPException

from app import store
from app.config import get_settings
from app.paths import voiceprint_path
from app.routers.people import enroll, enrolment_status
from app.schemas import EnrollRequest, EnrolmentStatus, PersonEnrollment
from app.services import storage_api
from app.services import voiceprints as voiceprints_service
from app.services.storage_api import (
    CentralEnrolment,
    StorageApiError,
    StubStorageApiClient,
    get_storage_api_client,
)


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

    def test_enroll_request_rejects_sample_sources_count_mismatch(self):
        with self.assertRaises(pydantic.ValidationError):
            EnrollRequest(
                clips_b64=["QUJD" * 400] * 3,
                consent_confirmed=True,
                sample_sources=["recorded", "uploaded"],
            )


class CentralRegistrationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._people_backup = list(store.PEOPLE)
        self._audit_backup = list(store.AUDIT_LOG)
        storage_api.reset_stub_for_tests()
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
        storage_api.reset_stub_for_tests()
        voiceprint_path().unlink(missing_ok=True)

    def _patched_settings(self):
        return get_settings().model_copy(update={"pyannote_api_key": "test-key"})

    def _valid_body(self) -> EnrollRequest:
        return EnrollRequest(
            clips_b64=["QUJD" * 400] * 3,
            consent_confirmed=True,
            sample_sources=["recorded", "recorded", "uploaded"],
        )

    async def test_enroll_registers_centrally_with_server_stamped_consent(self):
        with patch("app.routers.people.PyannoteAIClient") as mock_client_cls, \
                patch("app.routers.people.get_settings") as mock_get_settings, \
                patch("app.routers.people.central_enrolment_required", return_value=True):
            mock_get_settings.return_value = self._patched_settings()
            mock_client_cls.return_value.extract_voiceprint_from_audio.return_value = "vp-test"

            person = await enroll(
                "joseph@factor1.com.au",
                self._valid_body(),
                actor="Joseph",
                storage_token="tok",
            )

        enrolment = get_storage_api_client().get_enrolment(
            "joseph@factor1.com.au", access_token=None
        )
        self.assertIsNotNone(enrolment)
        self.assertLess(
            abs(datetime.now(timezone.utc) - enrolment.consent_recorded_at),
            timedelta(seconds=60),
        )
        self.assertEqual(enrolment.sample_sources, ["recorded", "recorded", "uploaded"])
        self.assertTrue(person.centrally_enrolled)
        self.assertIsNotNone(person.consent_recorded_at)
        self.assertIn("centrally_enrolled=True", store.AUDIT_LOG[-1].after)

    async def test_central_registration_failure_returns_502_and_no_false_success(self):
        person = next(p for p in store.PEOPLE if p.employee_id == "joseph@factor1.com.au")
        with patch("app.routers.people.PyannoteAIClient") as mock_client_cls, \
                patch("app.routers.people.get_settings") as mock_get_settings, \
                patch("app.routers.people.central_enrolment_required", return_value=True):
            mock_get_settings.return_value = self._patched_settings()
            mock_client_cls.return_value.extract_voiceprint_from_audio.return_value = "vp-test"
            get_storage_api_client().fail_next = True

            with self.assertRaises(HTTPException) as ctx:
                await enroll(
                    "joseph@factor1.com.au",
                    self._valid_body(),
                    actor="Joseph",
                    storage_token="tok",
                )

        self.assertEqual(ctx.exception.status_code, 502)
        self.assertIn("retry", ctx.exception.detail.lower())
        self.assertFalse(person.centrally_enrolled)
        # The local voiceprint write happens before the central attempt
        # (spec §Backend routes: "write the local registry (pre-cutover
        # behaviour and rollback window), then ... register centrally") and
        # is not rolled back on central failure — so person.enrolled is True
        # here by design. The "no false success" invariant this guards is
        # about the CENTRAL record and the HTTP response, not the local
        # rollback-window write: no central record must exist after a 502,
        # and the response itself must never claim success.
        self.assertTrue(person.enrolled)
        self.assertIsNone(
            get_storage_api_client().get_enrolment("joseph@factor1.com.au", access_token=None)
        )

    async def test_enroll_without_central_requirement_skips_registration(self):
        with patch("app.routers.people.PyannoteAIClient") as mock_client_cls, \
                patch("app.routers.people.get_settings") as mock_get_settings, \
                patch("app.routers.people.central_enrolment_required", return_value=False):
            mock_get_settings.return_value = self._patched_settings()
            mock_client_cls.return_value.extract_voiceprint_from_audio.return_value = "vp-test"

            person = await enroll(
                "joseph@factor1.com.au",
                self._valid_body(),
                actor="Joseph",
            )

        self.assertIsNone(
            get_storage_api_client().get_enrolment("joseph@factor1.com.au", access_token=None)
        )
        self.assertFalse(person.centrally_enrolled)
        self.assertTrue(person.enrolled)
        self.assertIsNotNone(person.consent_recorded_at)


class EnrolmentStatusTests(unittest.IsolatedAsyncioTestCase):
    """Gate source of truth (IN-379): GET /people/me/enrolment-status."""

    def setUp(self):
        self._people_backup = list(store.PEOPLE)
        self._audit_backup = list(store.AUDIT_LOG)
        storage_api.reset_stub_for_tests()
        # The voiceprint repository is a process-wide singleton (see
        # app.services.voiceprints.get_voiceprint_repository); deleting its
        # backing file (below) does not clear its in-memory cache, so a
        # prior test's local enrolment (e.g. CentralRegistrationTests, same
        # "joseph@factor1.com.au" id) would otherwise leak into
        # _sync_people_with_voiceprint_registry() here and flip
        # enrolled_locally regardless of what this test seeds.
        voiceprints_service._voiceprint_repo = None

    def tearDown(self):
        store.PEOPLE[:] = self._people_backup
        store.AUDIT_LOG[:] = self._audit_backup
        storage_api.reset_stub_for_tests()
        voiceprint_path().unlink(missing_ok=True)
        voiceprints_service._voiceprint_repo = None

    def _seed_person(self, enrolled: bool) -> None:
        store.PEOPLE.append(
            PersonEnrollment(
                employee_id="joseph@factor1.com.au",
                display_name="Joseph Guerrero",
                role="Factor1 staff",
                enrolled=enrolled,
            )
        )

    async def test_not_required_and_locally_enrolled(self):
        self._seed_person(enrolled=True)
        with patch("app.routers.people.central_enrolment_required", return_value=False):
            result = await enrolment_status(user_email="joseph@factor1.com.au", storage_token=None)
        self.assertIsInstance(result, EnrolmentStatus)
        self.assertTrue(result.enrolled_locally)
        self.assertFalse(result.centrally_enrolled)
        self.assertFalse(result.central_required)

    async def test_not_required_and_not_locally_enrolled(self):
        self._seed_person(enrolled=False)
        with patch("app.routers.people.central_enrolment_required", return_value=False):
            result = await enrolment_status(user_email="joseph@factor1.com.au", storage_token=None)
        self.assertFalse(result.enrolled_locally)
        self.assertFalse(result.centrally_enrolled)
        self.assertFalse(result.central_required)

    async def test_required_locally_enrolled_no_central_record(self):
        self._seed_person(enrolled=True)
        with patch("app.routers.people.central_enrolment_required", return_value=True):
            result = await enrolment_status(user_email="joseph@factor1.com.au", storage_token=None)
        self.assertTrue(result.enrolled_locally)
        self.assertFalse(result.centrally_enrolled)
        self.assertTrue(result.central_required)

    async def test_required_with_central_record_is_case_insensitive(self):
        self._seed_person(enrolled=True)
        get_storage_api_client().register_voiceprint(_enrolment(), access_token=None)
        with patch("app.routers.people.central_enrolment_required", return_value=True):
            result = await enrolment_status(
                user_email="Joseph@Factor1.com.au", storage_token=None
            )
        self.assertTrue(result.enrolled_locally)
        self.assertTrue(result.centrally_enrolled)
        self.assertTrue(result.central_required)

    async def test_missing_user_email_header_fails_closed(self):
        self._seed_person(enrolled=True)
        get_storage_api_client().register_voiceprint(_enrolment(), access_token=None)
        with patch("app.routers.people.central_enrolment_required", return_value=True):
            result = await enrolment_status(user_email=None, storage_token=None)
        self.assertFalse(result.enrolled_locally)
        self.assertFalse(result.centrally_enrolled)
        self.assertTrue(result.central_required)


if __name__ == "__main__":
    unittest.main()
