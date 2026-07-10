"""IN-106 — the minutes output must match David's AI Summary Instructions doc.

Line-by-line review on 2026-07-10 found the template structure fully
implemented but four behavioral rules missing: Australian spelling, verb-led
action items, disagreement handling ("Unresolved: ..."), and Next Meeting
extraction (previously hardcoded to TBC). These tests pin all four plus the
next-meeting data path from LLM insights through to the rendered minutes.
"""

import unittest

from app.routers.meetings import (
    _extract_next_meeting_from_summary,
    _format_transcript,
)
from app.services.llm import (
    _CHUNK_SYSTEM_PROMPT,
    _REDUCE_SYSTEM_PROMPT,
    _compose_plain_summary,
)


class SummaryCompositionTests(unittest.TestCase):
    def test_next_meeting_section_rendered_from_insights(self):
        summary = _compose_plain_summary(
            {
                "overview": "Overview.",
                "next_meeting": ["Date: Friday 18 July 10am", "Review budget figures"],
            }
        )
        self.assertIn("Next meeting", summary)
        self.assertIn("- Date: Friday 18 July 10am", summary)
        self.assertIn("- Review budget figures", summary)

    def test_next_meeting_section_omitted_when_empty(self):
        summary = _compose_plain_summary({"overview": "Overview.", "next_meeting": []})
        self.assertNotIn("Next meeting", summary)


class NextMeetingExtractionTests(unittest.TestCase):
    SUMMARY = (
        "Overview.\n"
        "\n"
        "Decisions\n"
        "- Proceed with pilot\n"
        "\n"
        "Next meeting\n"
        "- Date: Friday 18 July 10am\n"
        "- Review budget figures\n"
    )

    def test_extracts_only_next_meeting_bullets(self):
        items = _extract_next_meeting_from_summary(self.SUMMARY)
        self.assertEqual(items, ["Date: Friday 18 July 10am", "Review budget figures"])

    def test_minutes_render_next_meeting_date_and_agenda(self):
        text = _format_transcript([], "Sync", [], summary_text=self.SUMMARY)
        self.assertIn("Date: Friday 18 July 10am", text)
        self.assertIn("Agenda items flagged for next meeting: Review budget figures", text)
        self.assertNotIn("Date: TBC", text)

    def test_minutes_fall_back_to_template_placeholders(self):
        text = _format_transcript([], "Sync", [], summary_text="Overview only.")
        self.assertIn("Date: TBC", text)
        self.assertIn("Agenda items flagged for next meeting: None noted", text)


class Jira106PromptRuleTests(unittest.TestCase):
    """The behavioral rules agreed in IN-106 must stay in the LLM prompts."""

    def test_reduce_prompt_carries_language_and_quality_rules(self):
        self.assertIn("Australian spelling", _REDUCE_SYSTEM_PROMPT)
        self.assertIn("verb", _REDUCE_SYSTEM_PROMPT)
        self.assertIn("Unresolved:", _REDUCE_SYSTEM_PROMPT)
        self.assertIn("next_meeting", _REDUCE_SYSTEM_PROMPT)

    def test_chunk_prompt_forbids_invention_and_captures_disagreements(self):
        self.assertIn("Do not infer or invent", _CHUNK_SYSTEM_PROMPT)
        self.assertIn("Unresolved:", _CHUNK_SYSTEM_PROMPT)


if __name__ == "__main__":
    unittest.main()
