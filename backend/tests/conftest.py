"""Test hermeticity: neutralize a developer's real backend/.env leakage.

A populated ``backend/.env`` (real ``MN_STORAGE_API_URL``, credentials,
etc. — restored from the credentials archive for local dev work) is a
legitimate dev-machine artifact, but it must never change what the test
suite asserts. Without this, ``get_storage_api_client()`` silently returns
a ``RestStorageApiClient`` pointed at the real central Storage API instead
of the stub — every stub-mode test then either fails outright or, worse,
makes live network calls — which is exactly the ~24-25 failures this
fixture eliminates (see ``test_central_enrolment.py``,
``test_people_directory.py``, ``test_blob_delivery.py``,
``test_meeting_export.py``, ``test_storage_api_meetings.py``).

This autouse fixture forces the settings seam (``app.config.get_settings``)
to report ``storage_api_url=""`` / ``storage_api_enabled=False`` for every
test, regardless of ``.env`` content, unless a test explicitly overrides the
seam itself — e.g. ``patch("app.services.storage_api.get_settings", ...)``
(``test_central_enrolment.py::StorageApiSeamTests``) or
``patch("app.services.blob_delivery.get_settings", ...)``
(``test_blob_delivery.py``). Those patches replace the callable entirely
for the duration of their ``with``/``patch.start()`` block, so they win
outright over this fixture's env vars — no opt-out marker is needed.

``pyannote_api_key`` gets the same treatment for the same reason, found by
running the suite with a real ``.env`` and diffing failures: a populated
key flips ``app.services.speech.get_speech_provider()`` from
``StubSpeechProvider`` to the real ``PyannoteAITranscriptionProvider``,
which then fails on the synthetic (non-existent) audio files several
pipeline tests use, in a way unrelated to what those tests assert. Every
other ``.env`` key present on this dev machine
(``sharepoint_drive_id``/``folder_path``, ``voiceprint_expansion_*``,
``storage_api_scope``, ``openai_api_key``) was checked against a full-suite
run and does not change any test's outcome, so it is deliberately left
alone — narrower is safer than a blanket reset of every ``MN_`` var.
"""

import os

import pytest

from app.config import get_settings

_NEUTRALIZED = {
    "MN_STORAGE_API_URL": "",
    "MN_STORAGE_API_ENABLED": "false",
    "MN_PYANNOTE_API_KEY": "",
    # The suite pins the full IN-93/IN-387 fan-out; the organiser-only
    # default is covered explicitly in test_organizer_only_delivery.py.
    "MN_DELIVERY_RECIPIENTS": "attendees",
}


@pytest.fixture(autouse=True)
def _hermetic_storage_settings():
    previous = {key: os.environ.get(key) for key in _NEUTRALIZED}
    os.environ.update(_NEUTRALIZED)
    get_settings.cache_clear()
    try:
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        get_settings.cache_clear()
