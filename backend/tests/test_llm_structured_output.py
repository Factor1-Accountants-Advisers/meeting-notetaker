import unittest

from pydantic import ValidationError

from app.schemas import StructuredMeetingOutput, TranscriptSegment
from app.services.llm import (
    PROVIDER_UNAVAILABLE_FLAG,
    STRUCTURED_OUTPUT_SCHEMA_VERSION,
    StubLLMProvider,
    compose_plain_summary,
    render_summary_html,
)


EXPECTED_OUTPUT_FIELDS = {
    "schema_version",
    "summary",
    "key_points",
    "decisions",
    "action_items",
    "unresolved_questions",
    "next_meeting",
    "follow_ups",
    "quality_flags",
    "source_chunks",
}

EXPECTED_ACTION_FIELDS = {
    "description",
    "owner_name",
    "owner_email",
    "owner_confidence",
    "owner_source",
    "action_type",
    "due_date",
    "assigned_to",
    "assigned_to_department",
    "priority",
}


def _valid_output() -> dict:
    return {
        "schema_version": "1.0",
        "summary": "The team reviewed the pilot.",
        "key_points": ["Pilot timing was reviewed"],
        "decisions": ["Proceed with the pilot"],
        "action_items": [
            {
                "description": "Confirm the pilot date",
                "owner_name": "Joseph Guerrero",
                "owner_email": None,
                "owner_confidence": "high",
                "owner_source": "explicit_speaker",
                "action_type": None,
                "due_date": None,
                "assigned_to": None,
                "assigned_to_department": None,
                "priority": "medium",
            }
        ],
        "unresolved_questions": [],
        "next_meeting": [],
        "follow_ups": ["Check client availability"],
        "quality_flags": [],
        "source_chunks": [1],
    }


class StructuredMeetingOutputContractTests(unittest.TestCase):
    def test_schema_shape_and_version_are_pinned(self):
        output = StructuredMeetingOutput.model_validate(_valid_output())
        data = output.model_dump(mode="json")

        self.assertEqual(STRUCTURED_OUTPUT_SCHEMA_VERSION, "1.0")
        self.assertEqual(data["schema_version"], "1.0")
        self.assertEqual(set(data), EXPECTED_OUTPUT_FIELDS)
        self.assertEqual(set(data["action_items"][0]), EXPECTED_ACTION_FIELDS)

    def test_missing_required_field_is_rejected(self):
        data = _valid_output()
        data.pop("schema_version")

        with self.assertRaises(ValidationError):
            StructuredMeetingOutput.model_validate(data)

    def test_unknown_field_is_rejected(self):
        data = _valid_output()
        data["legacy_summary"] = "must not be stitched downstream"

        with self.assertRaises(ValidationError):
            StructuredMeetingOutput.model_validate(data)

    def test_unsupported_schema_version_is_rejected(self):
        data = _valid_output()
        data["schema_version"] = "2.0"

        with self.assertRaises(ValidationError):
            StructuredMeetingOutput.model_validate(data)


class StubStructuredOutputTests(unittest.IsolatedAsyncioTestCase):
    async def test_unconfigured_provider_returns_explicit_versioned_output(self):
        output = await StubLLMProvider().generate(
            [
                TranscriptSegment(
                    speaker="Joseph Guerrero",
                    speaker_known=True,
                    text="A transcript that must not trigger a network call.",
                    start_ms=0,
                    end_ms=5000,
                )
            ]
        )

        self.assertEqual(output.schema_version, "1.0")
        self.assertEqual(
            output.summary,
            "Summary unavailable — configure MN_OPENAI_API_KEY.",
        )
        self.assertEqual(output.action_items, [])
        self.assertEqual(output.quality_flags, [PROVIDER_UNAVAILABLE_FLAG])
        self.assertEqual(
            compose_plain_summary(output),
            "Summary unavailable — configure MN_OPENAI_API_KEY.",
        )
        self.assertIsNone(render_summary_html(output))


if __name__ == "__main__":
    unittest.main()
