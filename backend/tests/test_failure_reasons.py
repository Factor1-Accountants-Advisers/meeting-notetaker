"""Tests for the IN-391 failure taxonomy and classifier."""
import logging
import unittest
from datetime import datetime, timezone
from urllib.error import URLError
from uuid import uuid4

from app.schemas import Meeting
from app.services.failure_reasons import (
    FailureCategory,
    FailureReason,
    classify,
    log_delivery_failure,
)


class _FakeHttpError(Exception):
    def __init__(self, status_code: int) -> None:
        super().__init__(f"HTTP {status_code}")
        self.status_code = status_code


class ClassifyTests(unittest.TestCase):
    def test_transport_errors_classify_as_network(self) -> None:
        for exc in (
            URLError("dns failure"),
            ConnectionError("reset"),
            TimeoutError("timed out"),
        ):
            with self.subTest(exc=exc):
                reason = classify(exc, stage="blob")
                self.assertIs(reason.category, FailureCategory.network)

    def test_http_401_and_403_classify_as_azure_signin(self) -> None:
        for code in (401, 403):
            reason = classify(_FakeHttpError(code), stage="sharepoint")
            self.assertIs(reason.category, FailureCategory.azure_signin)

    def test_http_408_429_5xx_classify_as_service_unavailable(self) -> None:
        for code in (408, 429, 500, 503):
            reason = classify(_FakeHttpError(code), stage="blob")
            self.assertIs(reason.category, FailureCategory.service_unavailable)

    def test_unknown_exception_falls_back_to_processing_error(self) -> None:
        reason = classify(ValueError("boom"), stage="pipeline")
        self.assertIs(reason.category, FailureCategory.processing_error)

    def test_wrapper_exception_inherits_cause_category(self) -> None:
        # e.g. MeetingVoiceprintsUnavailable raised `from` a transport error
        try:
            try:
                raise ConnectionError("reset by peer")
            except ConnectionError as cause:
                raise RuntimeError("voiceprint lookup unavailable") from cause
        except RuntimeError as wrapper:
            reason = classify(wrapper, stage="pipeline")
        self.assertIs(reason.category, FailureCategory.network)
        # detail still names the outer wrapper for grep-ability
        self.assertIn("RuntimeError", reason.technical_detail)

    def test_user_sentence_never_contains_exception_text(self) -> None:
        reason = classify(ValueError("SECRET sas token"), stage="pipeline")
        self.assertNotIn("SECRET", reason.user_sentence)
        self.assertIn("SECRET", reason.technical_detail)

    def test_technical_detail_truncated_to_500(self) -> None:
        reason = classify(ValueError("x" * 2000), stage="pipeline")
        self.assertLessEqual(len(reason.technical_detail), 500)

    def test_local_file_errors_are_not_misclassified_as_network(self) -> None:
        # Bare `isinstance(root, OSError)` used to catch these too — a local
        # file error is not a network problem.
        reason = classify(
            FileNotFoundError(2, "No such file", "x.webm"), stage="pipeline"
        )
        self.assertIs(reason.category, FailureCategory.processing_error)

    def test_socket_style_os_error_without_filename_classifies_as_network(self) -> None:
        reason = classify(OSError("connection reset"), stage="blob")
        self.assertIs(reason.category, FailureCategory.network)

    def test_raise_from_none_does_not_unwrap_the_swallowed_context(self) -> None:
        try:
            try:
                raise ConnectionError("reset by peer")
            except ConnectionError:
                raise RuntimeError("wrapped, cause suppressed") from None
        except RuntimeError as wrapper:
            reason = classify(wrapper, stage="pipeline")
        # `from None` explicitly suppresses the cause; classify must not
        # reach into __context__ to find the swallowed ConnectionError.
        self.assertIs(reason.category, FailureCategory.processing_error)

    def test_multiline_exception_text_yields_single_line_detail(self) -> None:
        reason = classify(ValueError("line one\nline two\nline three"), stage="pipeline")
        self.assertNotIn("\n", reason.technical_detail)

    def test_wrapped_exception_detail_contains_cause_marker(self) -> None:
        try:
            try:
                raise ConnectionError("reset by peer")
            except ConnectionError as cause:
                raise RuntimeError("voiceprint lookup unavailable") from cause
        except RuntimeError as wrapper:
            reason = classify(wrapper, stage="pipeline")
        self.assertIn("(cause: ", reason.technical_detail)

    def test_every_category_has_a_user_sentence(self) -> None:
        for category in FailureCategory:
            reason = FailureReason.for_category(category, detail="branch")
            self.assertTrue(reason.user_sentence)


class LogDeliveryFailureTests(unittest.TestCase):
    def test_log_line_is_structured_and_greppable(self) -> None:
        reason = FailureReason.for_category(
            FailureCategory.azure_signin, detail="signin_check"
        )
        with self.assertLogs("app.services.failure_reasons", level=logging.WARNING) as captured:
            log_delivery_failure("00000000-0000-0000-0000-000000000001", "blob", reason, code="signin_check")
        line = captured.output[0]
        for fragment in ("delivery_failure", "stage=blob", "category=azure_signin", "code=signin_check"):
            self.assertIn(fragment, line)


class SchemaBackCompatTests(unittest.TestCase):
    def _legacy_payload(self) -> dict:
        return {
            "id": str(uuid4()),
            "title": "Legacy",
            "source": "online",
            "owner_id": "user-1",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

    def test_legacy_meeting_loads_with_none_error_codes(self) -> None:
        meeting = Meeting.model_validate(self._legacy_payload())
        self.assertIsNone(meeting.blob_error_code)
        self.assertIsNone(meeting.sharepoint_error_code)
        self.assertIsNone(meeting.delivery_error_code)


if __name__ == "__main__":
    unittest.main()
