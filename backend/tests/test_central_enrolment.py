"""IN-379: central voiceprint enrolment through the Storage API seam."""

import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pydantic
from fastapi import HTTPException

from app import store
from app.config import get_settings
from app.routers.people import enroll, enrolment_status, flag_reenrollment
from app.schemas import EnrollRequest, EnrolmentStatus, PersonEnrollment
from app.services import storage_api
from app.services import voiceprints as voiceprints_service
from app.services.storage_api import (
    CentralEnrolment,
    RestStorageApiClient,
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

    def test_central_enrolment_disabled_even_when_url_is_configured(self):
        with patch("app.services.storage_api.get_settings") as settings:
            settings.return_value.storage_api_url = "https://api.example"
            settings.return_value.storage_api_enabled = False
            self.assertFalse(storage_api.central_enrolment_required())

    def test_factory_returns_stub_when_central_enrolment_is_disabled(self):
        with patch("app.services.storage_api.get_settings") as settings:
            settings.return_value.storage_api_url = "https://api.example"
            settings.return_value.storage_api_enabled = False
            storage_api.reset_stub_for_tests()
            self.assertIsInstance(storage_api.get_storage_api_client(), StubStorageApiClient)

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


class _FakeHttpResponse:
    """Minimal stand-in for the context manager `urlopen` returns."""

    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "_FakeHttpResponse":
        return self

    def __exit__(self, *exc_info) -> bool:
        return False


class RestStorageApiClientMalformedRecordTests(unittest.TestCase):
    """IN-379 review: the REST seam must never leak a raw ValidationError —
    every seam failure must stay inside the StorageApiError contract so the
    status endpoint's fail-closed catch holds."""

    def _fake_opener_returning(self, payload: dict):
        def opener(req, timeout=30):
            return _FakeHttpResponse(json.dumps(payload).encode("utf-8"))

        return opener

    def test_get_enrolment_wraps_malformed_record_in_storage_api_error(self):
        # Missing required fields (display_name, voiceprints, sample_sources,
        # consent_recorded_at) — CentralEnrolment.model_validate raises
        # pydantic.ValidationError today, which must not escape the seam.
        client = RestStorageApiClient(
            "http://x", opener=self._fake_opener_returning({"person_id": "x"})
        )
        with self.assertRaises(StorageApiError):
            client.get_enrolment("x", access_token="tok")

    def test_register_voiceprint_wraps_malformed_record_in_storage_api_error(self):
        client = RestStorageApiClient(
            "http://x", opener=self._fake_opener_returning({"person_id": "x"})
        )
        with self.assertRaises(StorageApiError):
            client.register_voiceprint(_enrolment(), access_token="tok")


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
        voiceprints_service.reset_repository_for_tests()
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
        voiceprints_service.reset_repository_for_tests()

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

    async def test_enroll_normalizes_mixed_case_employee_id(self):
        """Only /people/me lowercases at creation today, so a mixed-case path
        param 404s against the lowercase-keyed local registry. Normalizing in
        enroll() keeps the central person_id and local registry key
        consistently lowercase (IN-379 review)."""
        with patch("app.routers.people.PyannoteAIClient") as mock_client_cls, \
                patch("app.routers.people.get_settings") as mock_get_settings, \
                patch("app.routers.people.central_enrolment_required", return_value=True):
            mock_get_settings.return_value = self._patched_settings()
            mock_client_cls.return_value.extract_voiceprint_from_audio.return_value = "vp-test"

            person = await enroll(
                "Joseph@Factor1.com.au",
                self._valid_body(),
                actor="Joseph",
                storage_token="tok",
            )

        self.assertEqual(person.employee_id, "joseph@factor1.com.au")
        enrolment = get_storage_api_client().get_enrolment(
            "joseph@factor1.com.au", access_token=None
        )
        self.assertIsNotNone(enrolment)
        self.assertEqual(enrolment.person_id, "joseph@factor1.com.au")


class FlagReenrollmentNormalizationTests(unittest.IsolatedAsyncioTestCase):
    """IN-379: flag_reenrollment was the only person-keyed endpoint that
    still matched employee_id case-sensitively after Task 4 normalized
    enroll() — a mixed-case path param 404s against the lowercase-keyed
    local registry."""

    def setUp(self):
        self._people_backup = list(store.PEOPLE)
        self._audit_backup = list(store.AUDIT_LOG)
        store.PEOPLE.append(
            PersonEnrollment(
                employee_id="joseph@factor1.com.au",
                display_name="Joseph Guerrero",
                role="Factor1 staff",
                enrolled=True,
            )
        )

    def tearDown(self):
        store.PEOPLE[:] = self._people_backup
        store.AUDIT_LOG[:] = self._audit_backup

    async def test_flag_reenrollment_normalizes_mixed_case_employee_id(self):
        person = await flag_reenrollment("Joseph@Factor1.com.au", actor="Joseph")
        self.assertEqual(person.employee_id, "joseph@factor1.com.au")
        self.assertTrue(person.reenrollment_required)


class EnrolmentStatusTests(unittest.IsolatedAsyncioTestCase):
    """Gate source of truth (IN-379): GET /people/me/enrolment-status."""

    def setUp(self):
        self._people_backup = list(store.PEOPLE)
        self._audit_backup = list(store.AUDIT_LOG)
        storage_api.reset_stub_for_tests()
        # The voiceprint repository is a process-wide singleton (see
        # app.services.voiceprints.get_voiceprint_repository); clearing just
        # its backing file does not clear its in-memory cache, so a prior
        # test's local enrolment (e.g. CentralRegistrationTests, same
        # "joseph@factor1.com.au" id) would otherwise leak into
        # _sync_people_with_voiceprint_registry() here and flip
        # enrolled_locally regardless of what this test seeds.
        voiceprints_service.reset_repository_for_tests()

    def tearDown(self):
        store.PEOPLE[:] = self._people_backup
        store.AUDIT_LOG[:] = self._audit_backup
        storage_api.reset_stub_for_tests()
        voiceprints_service.reset_repository_for_tests()

    def _seed_person(self, enrolled: bool) -> None:
        store.PEOPLE.append(
            PersonEnrollment(
                employee_id="joseph@factor1.com.au",
                display_name="Joseph Guerrero",
                role="Factor1 staff",
                enrolled=enrolled,
            )
        )

    async def test_required_status_uses_email_locally_and_oid_centrally(self):
        self._seed_person(enrolled=True)

        class _CapturingStorageApiClient:
            def __init__(self):
                self.calls = []

            def get_enrolment(self, person_id, access_token=None):
                self.calls.append((person_id, access_token))
                return _enrolment(person_id)

        client = _CapturingStorageApiClient()
        with patch("app.routers.people.central_enrolment_required", return_value=True), \
                patch("app.routers.people.get_storage_api_client", return_value=client):
            result = await enrolment_status(
                user_email="joseph@factor1.com.au",
                user_oid="oid-123",
                storage_token="token-123",
            )

        self.assertTrue(result.enrolled_locally)
        self.assertTrue(result.centrally_enrolled)
        self.assertEqual(client.calls, [("oid-123", "token-123")])

    async def test_required_status_without_oid_does_not_call_central_api(self):
        self._seed_person(enrolled=True)

        class _UnexpectedStorageApiClient:
            def get_enrolment(self, person_id, access_token=None):
                raise AssertionError("central API must not be called without an OID")

        client = _UnexpectedStorageApiClient()
        with patch("app.routers.people.central_enrolment_required", return_value=True), \
                patch("app.routers.people.get_storage_api_client", return_value=client):
            result = await enrolment_status(
                user_email="joseph@factor1.com.au",
                user_oid=None,
                storage_token="token-123",
            )

        self.assertTrue(result.enrolled_locally)
        self.assertFalse(result.centrally_enrolled)

    async def test_required_status_without_token_does_not_call_central_api(self):
        self._seed_person(enrolled=True)

        class _UnexpectedStorageApiClient:
            def get_enrolment(self, person_id, access_token=None):
                raise AssertionError("central API must not be called without a token")

        client = _UnexpectedStorageApiClient()
        with patch("app.routers.people.central_enrolment_required", return_value=True), \
                patch("app.routers.people.get_storage_api_client", return_value=client):
            result = await enrolment_status(
                user_email="joseph@factor1.com.au",
                user_oid="oid-123",
                storage_token=None,
            )

        self.assertTrue(result.enrolled_locally)
        self.assertFalse(result.centrally_enrolled)

    async def test_not_required_and_locally_enrolled(self):
        self._seed_person(enrolled=True)
        with patch("app.routers.people.central_enrolment_required", return_value=False):
            result = await enrolment_status(user_email="joseph@factor1.com.au", storage_token=None)
        self.assertIsInstance(result, EnrolmentStatus)
        self.assertTrue(result.enrolled_locally)
        self.assertFalse(result.centrally_enrolled)
        self.assertFalse(result.central_required)

    async def test_reenrollment_flagged_person_is_not_locally_enrolled(self):
        """IN-379 final review: a person flagged for re-enrolment (IN-76
        flag-reenrollment) must not pass the pre-cutover gate even though
        `enrolled` is still True — otherwise a flagged person keeps sailing
        through on stale local enrolment."""
        store.PEOPLE.append(
            PersonEnrollment(
                employee_id="joseph@factor1.com.au",
                display_name="Joseph Guerrero",
                role="Factor1 staff",
                enrolled=True,
                reenrollment_required=True,
            )
        )
        with patch("app.routers.people.central_enrolment_required", return_value=False):
            result = await enrolment_status(user_email="joseph@factor1.com.au", storage_token=None)
        self.assertFalse(result.enrolled_locally)
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
            result = await enrolment_status(
                user_email="joseph@factor1.com.au",
                user_oid="oid-123",
                storage_token="token-123",
            )
        self.assertTrue(result.enrolled_locally)
        self.assertFalse(result.centrally_enrolled)
        self.assertTrue(result.central_required)

    async def test_required_with_central_record_is_case_insensitive(self):
        self._seed_person(enrolled=True)
        get_storage_api_client().register_voiceprint(_enrolment("oid-123"), access_token=None)
        with patch("app.routers.people.central_enrolment_required", return_value=True):
            result = await enrolment_status(
                user_email="Joseph@Factor1.com.au",
                user_oid="oid-123",
                storage_token="token-123",
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

    async def test_whitespace_only_user_email_header_fails_closed(self):
        """A header of only whitespace must be treated the same as a missing
        header — normalize before the guard, not after (IN-379 review)."""
        self._seed_person(enrolled=True)
        get_storage_api_client().register_voiceprint(_enrolment(), access_token=None)
        with patch("app.routers.people.central_enrolment_required", return_value=True):
            result = await enrolment_status(user_email="   ", storage_token=None)
        self.assertFalse(result.enrolled_locally)
        self.assertFalse(result.centrally_enrolled)
        self.assertTrue(result.central_required)

    async def test_disabled_central_record_does_not_satisfy_gate(self):
        """The gate must count only active central records — a disabled
        record (e.g. offboarded staff) must not satisfy central_required
        (IN-379 review)."""
        self._seed_person(enrolled=True)
        disabled = _enrolment("oid-123").model_copy(update={"status": "disabled"})
        get_storage_api_client().register_voiceprint(disabled, access_token=None)
        with patch("app.routers.people.central_enrolment_required", return_value=True):
            result = await enrolment_status(
                user_email="joseph@factor1.com.au",
                user_oid="oid-123",
                storage_token="token-123",
            )
        self.assertTrue(result.enrolled_locally)
        self.assertFalse(result.centrally_enrolled)
        self.assertTrue(result.central_required)

    async def test_central_only_enrolment_satisfies_gate_fields(self):
        """Headline cutover scenario: enrolled centrally on another machine,
        no local voiceprint on this one — the gate must still open."""
        self._seed_person(enrolled=False)
        get_storage_api_client().register_voiceprint(_enrolment("oid-123"), access_token=None)
        with patch("app.routers.people.central_enrolment_required", return_value=True):
            result = await enrolment_status(
                user_email="joseph@factor1.com.au",
                user_oid="oid-123",
                storage_token="token-123",
            )
        self.assertFalse(result.enrolled_locally)
        self.assertTrue(result.centrally_enrolled)
        self.assertTrue(result.central_required)

    async def test_storage_error_during_status_fails_closed(self):
        """A raised StorageApiError from the storage client must never escape
        the status endpoint — it must fail closed instead."""
        self._seed_person(enrolled=True)

        class _BoomStorageApiClient:
            def get_enrolment(self, person_id, access_token=None):
                raise StorageApiError("boom")

        with patch("app.routers.people.central_enrolment_required", return_value=True), \
                patch("app.routers.people.get_storage_api_client", return_value=_BoomStorageApiClient()):
            result = await enrolment_status(
                user_email="joseph@factor1.com.au",
                user_oid="oid-123",
                storage_token="token-123",
            )
        self.assertTrue(result.enrolled_locally)
        self.assertFalse(result.centrally_enrolled)
        self.assertTrue(result.central_required)


if __name__ == "__main__":
    unittest.main()
