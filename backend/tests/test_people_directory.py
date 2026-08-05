"""Central people directory merged into GET /people (attendee suggestions).

Root cause fixed here (diagnosed live, 5 Aug 2026): the manual-recording
attendee dropdown filters to enrolled people, but post-Slice-2 enrolment
lives centrally and each install's people store held only the signed-in
"me" with enrolled=False — so the dropdown was empty fleet-wide.
"""

import json
import unittest
import urllib.error
from unittest.mock import patch

from app import store
from app.routers.people import list_people
from app.schemas import PersonEnrollment
from app.services import storage_api
from app.services.storage_api import (
    CentralEnrolment,
    DirectoryEntry,
    RestStorageApiClient,
    StorageApiError,
    StorageApiUnavailable,
)
from tests.test_central_enrolment import _enrolment


class _FakeHttpResponse:
    def __init__(self, body: bytes):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self) -> bytes:
        return self._body


class StubDirectoryTests(unittest.TestCase):
    def setUp(self):
        storage_api.reset_stub_for_tests()

    def test_stub_lists_active_enrolments_only(self):
        client = storage_api.get_storage_api_client()
        client.register_voiceprint(_enrolment(), None)
        disabled = _enrolment(
            person_id="dee@factor1.com.au", email="dee@factor1.com.au"
        ).model_copy(update={"status": "disabled", "display_name": "Dee Disabled"})
        client.register_voiceprint(disabled, None)

        entries = client.list_directory(None)

        self.assertEqual(
            entries,
            [DirectoryEntry(email="joseph@factor1.com.au", display_name="Joseph Guerrero")],
        )


class RestDirectoryTests(unittest.TestCase):
    def test_rest_client_parses_directory_response_with_bearer(self):
        seen = {}

        def opener(req, timeout=30):
            seen["url"] = req.full_url
            seen["auth"] = req.get_header("Authorization")
            seen["timeout"] = timeout
            return _FakeHttpResponse(
                json.dumps(
                    {"items": [{"email": "amy@factor1.com.au", "display_name": "Amy Active"}]}
                ).encode("utf-8")
            )

        client = RestStorageApiClient("https://storage.example", opener=opener)
        entries = client.list_directory("tok")

        self.assertEqual(
            entries, [DirectoryEntry(email="amy@factor1.com.au", display_name="Amy Active")]
        )
        self.assertEqual(seen["url"], "https://storage.example/api/v1/voiceprints/directory")
        self.assertEqual(seen["auth"], "Bearer tok")
        # A hung central API must not take the whole /people response past the
        # main-process proxy's 15s GET abort — the directory read is bounded.
        self.assertLessEqual(seen["timeout"], 5)

    def test_rest_client_maps_404_to_unavailable(self):
        # An old deployed server without the endpoint reads as "temporarily
        # can't consult" (degrade to local-only), never as a rejection.
        def opener(req, timeout=30):
            raise urllib.error.HTTPError(req.full_url, 404, "Not Found", hdrs=None, fp=None)

        client = RestStorageApiClient("http://x", opener=opener)
        with self.assertRaises(StorageApiUnavailable):
            client.list_directory("tok")


class _FakeDirectoryClient:
    def __init__(self, entries=None, error: Exception | None = None):
        self.entries = entries or []
        self.error = error
        self.calls = 0

    def list_directory(self, access_token):
        self.calls += 1
        if self.error:
            raise self.error
        return self.entries


class ListPeopleDirectoryMergeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        storage_api.reset_stub_for_tests()
        self._old_people = list(store.PEOPLE)
        store.PEOPLE.clear()
        store.PEOPLE.append(
            PersonEnrollment(
                employee_id="josephguerrero@factor1.com.au",
                display_name="Joseph Miguel Guerrero",
                role="Factor1 staff",
                enrolled=False,
                model_version=None,
                reenrollment_required=False,
            )
        )

    def tearDown(self):
        store.PEOPLE.clear()
        store.PEOPLE.extend(self._old_people)

    async def test_directory_adds_unknown_people_as_centrally_enrolled(self):
        client = _FakeDirectoryClient(
            entries=[DirectoryEntry(email="amy@factor1.com.au", display_name="Amy Active")]
        )
        with patch("app.routers.people.get_storage_api_client", return_value=client):
            people = await list_people()

        amy = next(p for p in people if p.employee_id == "amy@factor1.com.au")
        self.assertTrue(amy.centrally_enrolled)
        self.assertFalse(amy.enrolled)
        self.assertEqual(amy.display_name, "Amy Active")
        self.assertEqual(amy.role, "Factor1 staff")

    async def test_directory_marks_existing_person_centrally_enrolled(self):
        client = _FakeDirectoryClient(
            entries=[
                DirectoryEntry(
                    email="josephguerrero@factor1.com.au",
                    display_name="Joseph Miguel Guerrero",
                )
            ]
        )
        with patch("app.routers.people.get_storage_api_client", return_value=client):
            people = await list_people()

        me = next(p for p in people if p.employee_id == "josephguerrero@factor1.com.au")
        self.assertTrue(me.centrally_enrolled)
        self.assertFalse(me.enrolled)  # local flag untouched

    async def test_person_dropped_from_directory_loses_central_flag(self):
        store.PEOPLE[0].centrally_enrolled = True
        client = _FakeDirectoryClient(entries=[])
        with patch("app.routers.people.get_storage_api_client", return_value=client):
            people = await list_people()

        me = next(p for p in people if p.employee_id == "josephguerrero@factor1.com.au")
        self.assertFalse(me.centrally_enrolled)
        # Never removed — local records survive central offboarding/hiccups.
        self.assertEqual(len(people), 1)

    async def test_directory_failure_leaves_local_list_untouched(self):
        store.PEOPLE[0].centrally_enrolled = True
        client = _FakeDirectoryClient(error=StorageApiError("central down"))
        with patch("app.routers.people.get_storage_api_client", return_value=client):
            people = await list_people()

        me = next(p for p in people if p.employee_id == "josephguerrero@factor1.com.au")
        self.assertTrue(me.centrally_enrolled)  # stale beats broken
        self.assertEqual(client.calls, 1)

    async def test_no_storage_identity_skips_central_call_when_required(self):
        client = _FakeDirectoryClient()
        with (
            patch("app.routers.people.get_storage_api_client", return_value=client),
            patch("app.routers.people.central_enrolment_required", return_value=True),
        ):
            await list_people()

        self.assertEqual(client.calls, 0)


if __name__ == "__main__":
    unittest.main()
