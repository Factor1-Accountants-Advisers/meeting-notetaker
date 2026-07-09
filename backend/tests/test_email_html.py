import unittest
from datetime import date
from uuid import uuid4

from app.schemas import ActionItem, ActionItemStatus, Priority
from app.services.email import build_meeting_notes_email_html


class EmailHtmlTests(unittest.TestCase):
    def _action(self, meeting_id):
        return ActionItem(
            id=uuid4(),
            meeting_id=meeting_id,
            owner="Joseph Guerrero",
            description="Send the follow-up email",
            deadline=date(2026, 7, 15),
            priority=Priority.high,
            status=ActionItemStatus.open,
        )

    def test_uses_rich_summary_fragment_and_renders_action_table(self):
        meeting_id = uuid4()
        body = build_meeting_notes_email_html(
            meeting_title="Quarterly review",
            summary_html=(
                '<p style="margin:0;">Overview paragraph.</p>'
                "<h3>Decisions</h3><ul><li>Approved budget</li></ul>"
            ),
            summary_text="ignored when html is present",
            note="Please review before Friday.",
            action_items=[self._action(meeting_id)],
        )

        self.assertIn("Quarterly review", body)
        self.assertIn("Overview paragraph.", body)
        self.assertIn("Approved budget", body)
        self.assertIn("Please review before Friday.", body)
        self.assertIn("Action items", body)
        self.assertIn("Send the follow-up email", body)
        self.assertIn("15 Jul 2026", body)
        self.assertNotIn("ignored when html is present", body)

    def test_falls_back_to_plain_summary_when_no_html(self):
        body = build_meeting_notes_email_html(
            meeting_title="Stand-up",
            summary_html=None,
            summary_text="First paragraph.\n\nSecond paragraph.",
            note=None,
            action_items=[],
        )

        self.assertIn("Stand-up", body)
        self.assertIn("First paragraph.", body)
        self.assertIn("Second paragraph.", body)
        self.assertIn("full transcript is attached", body.lower())

    def test_escapes_caller_supplied_text(self):
        body = build_meeting_notes_email_html(
            meeting_title="<script>alert(1)</script>",
            summary_html=None,
            summary_text="Plain body",
            note="<b>note</b>",
            action_items=[],
        )

        self.assertNotIn("<script>alert(1)</script>", body)
        self.assertIn("&lt;script&gt;", body)
        self.assertNotIn("<b>note</b>", body)


if __name__ == "__main__":
    unittest.main()
