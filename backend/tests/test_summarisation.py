"""Tests for summarisation service (TDD - written first).

Tests Claude API summarisation and action item extraction.
Following TDD: write tests FIRST, watch them fail, then implement.
"""
import json
import pytest
from unittest.mock import Mock, patch, MagicMock
from datetime import date
from sqlalchemy.orm import Session

from app.models import Meeting, Transcript, Summary, ActionItem, MeetingStatus


class TestClaudeSummarisation:
    """Tests for Claude API summarisation."""

    def test_summarise_transcript_returns_structured_response(self):
        """Summarisation should return summary, key_points, action_items, follow_ups."""
        from app.services.summarisation import summarise_transcript

        transcript_text = """
        Speaker 1: Let's discuss the Q4 budget review.
        Speaker 2: I think we need to increase the marketing spend by 20%.
        Speaker 1: Good idea. Can you prepare a proposal by Friday?
        Speaker 2: Sure, I'll have it ready by then.
        """

        # Mock Claude API response
        mock_response = {
            "summary": "Discussion about Q4 budget review and marketing spend increase.",
            "key_points": [
                "Q4 budget review discussed",
                "Proposal to increase marketing spend by 20%"
            ],
            "action_items": [
                {
                    "description": "Prepare marketing spend increase proposal",
                    "owner": "Speaker 2",
                    "due_date": "2026-03-21"
                }
            ],
            "follow_ups": [
                "Review the marketing spend proposal when ready"
            ]
        }

        with patch("app.services.summarisation.call_claude_api") as mock_claude:
            mock_claude.return_value = mock_response

            result = summarise_transcript(transcript_text)

        assert "summary" in result
        assert "key_points" in result
        assert "action_items" in result
        assert "follow_ups" in result
        assert isinstance(result["key_points"], list)
        assert isinstance(result["action_items"], list)

    def test_summarise_transcript_handles_empty_transcript(self):
        """Should handle empty transcripts gracefully."""
        from app.services.summarisation import summarise_transcript

        mock_response = {
            "summary": "No meaningful content to summarise.",
            "key_points": [],
            "action_items": [],
            "follow_ups": []
        }

        with patch("app.services.summarisation.call_claude_api") as mock_claude:
            mock_claude.return_value = mock_response

            result = summarise_transcript("")

        assert result["summary"] == "No meaningful content to summarise."
        assert result["key_points"] == []
        assert result["action_items"] == []

    def test_call_claude_api_sends_correct_prompt(self):
        """Should send transcript with proper system prompt to Claude."""
        from app.services.summarisation import call_claude_api

        transcript = "Speaker 1: Hello\nSpeaker 2: Hi there"

        mock_client = Mock()
        mock_message = Mock()
        mock_message.content = [Mock(text=json.dumps({
            "summary": "Greeting exchange",
            "key_points": [],
            "action_items": [],
            "follow_ups": []
        }))]
        mock_client.messages.create.return_value = mock_message

        with patch("app.services.summarisation.get_anthropic_client") as mock_get_client:
            mock_get_client.return_value = mock_client

            result = call_claude_api(transcript)

        # Verify API was called
        mock_client.messages.create.assert_called_once()
        call_args = mock_client.messages.create.call_args

        # Check that transcript is in the user message
        user_message = call_args.kwargs["messages"][0]["content"]
        assert transcript in user_message

    def test_call_claude_api_handles_api_error(self):
        """Should raise on API errors."""
        from app.services.summarisation import call_claude_api

        with patch("app.services.summarisation.get_anthropic_client") as mock_get_client:
            mock_client = Mock()
            mock_client.messages.create.side_effect = Exception("API Error")
            mock_get_client.return_value = mock_client

            with pytest.raises(Exception, match="API Error"):
                call_claude_api("test transcript")

    def test_call_claude_api_handles_invalid_json(self):
        """Should raise ValueError on invalid JSON response."""
        from app.services.summarisation import call_claude_api

        mock_client = Mock()
        mock_message = Mock()
        mock_message.content = [Mock(text="Not valid JSON")]
        mock_client.messages.create.return_value = mock_message

        with patch("app.services.summarisation.get_anthropic_client") as mock_get_client:
            mock_get_client.return_value = mock_client

            with pytest.raises(ValueError, match="Invalid JSON"):
                call_claude_api("test transcript")


class TestTranscriptFormatting:
    """Tests for formatting transcript segments for Claude."""

    def test_format_segments_for_claude(self):
        """Should format segments as readable text."""
        from app.services.summarisation import format_segments_for_claude

        segments = [
            {"speaker": "John", "start": 0.0, "end": 5.0, "text": "Hello everyone."},
            {"speaker": "Jane", "start": 5.0, "end": 10.0, "text": "Hi John."},
        ]

        formatted = format_segments_for_claude(segments)

        assert "John: Hello everyone." in formatted
        assert "Jane: Hi John." in formatted

    def test_format_segments_handles_unknown_speaker(self):
        """Should handle Unknown speaker label."""
        from app.services.summarisation import format_segments_for_claude

        segments = [
            {"speaker": "Unknown", "start": 0.0, "end": 5.0, "text": "Hello."},
        ]

        formatted = format_segments_for_claude(segments)

        assert "Unknown: Hello." in formatted

    def test_format_segments_handles_empty_list(self):
        """Should return empty string for empty segments."""
        from app.services.summarisation import format_segments_for_claude

        formatted = format_segments_for_claude([])

        assert formatted == ""


class TestSaveSummary:
    """Tests for saving summary to database."""

    def test_save_summary_creates_records(
        self,
        db_session: Session,
        test_meeting: Meeting,
    ):
        """Should create Summary and ActionItem records."""
        from app.services.summarisation import save_summary

        summarisation_result = {
            "summary": "Meeting about project planning.",
            "key_points": ["Discussed timeline", "Assigned tasks"],
            "action_items": [
                {
                    "description": "Create project plan",
                    "owner": "John",
                    "due_date": "2026-03-25"
                },
                {
                    "description": "Review requirements",
                    "owner": "Jane",
                    "due_date": None
                }
            ],
            "follow_ups": ["Schedule follow-up meeting"]
        }

        summary, action_items = save_summary(
            db_session, test_meeting.id, summarisation_result
        )

        assert summary.meeting_id == test_meeting.id
        assert summary.summary_text == "Meeting about project planning."
        assert summary.key_points == ["Discussed timeline", "Assigned tasks"]
        assert summary.follow_ups == ["Schedule follow-up meeting"]

        assert len(action_items) == 2
        assert action_items[0].description == "Create project plan"
        assert action_items[0].owner_name == "John"
        assert action_items[0].due_date == date(2026, 3, 25)
        assert action_items[1].due_date is None

    def test_save_summary_handles_no_action_items(
        self,
        db_session: Session,
        test_meeting: Meeting,
    ):
        """Should handle summaries with no action items."""
        from app.services.summarisation import save_summary

        summarisation_result = {
            "summary": "Informal discussion.",
            "key_points": ["Casual conversation"],
            "action_items": [],
            "follow_ups": []
        }

        summary, action_items = save_summary(
            db_session, test_meeting.id, summarisation_result
        )

        assert summary is not None
        assert len(action_items) == 0


class TestSummarisationPipeline:
    """Tests for the full summarisation pipeline."""

    def test_process_summarisation_completes_pipeline(
        self,
        db_session: Session,
        test_meeting: Meeting,
    ):
        """Pipeline should create Summary and update meeting status."""
        from app.services.summarisation import process_summarisation

        # Create transcript with speaker labels
        transcript = Transcript(
            meeting_id=test_meeting.id,
            full_text="Discussion about budget",
            segments=[
                {"speaker": "Speaker 1", "start": 0.0, "end": 5.0, "text": "Let's review the budget."},
                {"speaker": "Speaker 2", "start": 5.0, "end": 10.0, "text": "I'll prepare the report."},
            ],
        )
        db_session.add(transcript)
        db_session.commit()

        mock_claude_response = {
            "summary": "Budget review discussion.",
            "key_points": ["Budget review scheduled"],
            "action_items": [
                {"description": "Prepare budget report", "owner": "Speaker 2", "due_date": None}
            ],
            "follow_ups": []
        }

        with patch("app.services.summarisation.call_claude_api") as mock_claude:
            mock_claude.return_value = mock_claude_response

            summary, action_items = process_summarisation(db_session, test_meeting.id)

        assert summary.summary_text == "Budget review discussion."
        assert len(action_items) == 1

        db_session.refresh(test_meeting)
        assert test_meeting.status == MeetingStatus.COMPLETE

    def test_process_summarisation_fails_without_transcript(
        self,
        db_session: Session,
        test_meeting: Meeting,
    ):
        """Should raise error if transcript doesn't exist."""
        from app.services.summarisation import process_summarisation

        with pytest.raises(ValueError, match="Transcript not found"):
            process_summarisation(db_session, test_meeting.id)

    def test_process_summarisation_sets_failed_on_error(
        self,
        db_session: Session,
        test_meeting: Meeting,
    ):
        """Should set meeting status to FAILED on errors."""
        from app.services.summarisation import process_summarisation

        # Create transcript
        transcript = Transcript(
            meeting_id=test_meeting.id,
            full_text="Test",
            segments=[{"speaker": "Speaker 1", "start": 0.0, "end": 5.0, "text": "Test"}],
        )
        db_session.add(transcript)
        db_session.commit()

        with patch("app.services.summarisation.call_claude_api") as mock_claude:
            mock_claude.side_effect = Exception("Claude API failed")

            with pytest.raises(Exception):
                process_summarisation(db_session, test_meeting.id)

        db_session.refresh(test_meeting)
        assert test_meeting.status == MeetingStatus.FAILED


class TestSummarisationCeleryTask:
    """Tests for the Celery summarisation task."""

    def test_summarise_meeting_task_returns_counts(
        self,
        db_session: Session,
        test_meeting: Meeting,
    ):
        """Celery task should return summary and action item counts."""
        from app.services.pipeline import summarise_meeting

        # Create transcript
        transcript = Transcript(
            meeting_id=test_meeting.id,
            full_text="Test",
            segments=[{"speaker": "Speaker 1", "start": 0.0, "end": 5.0, "text": "Test"}],
        )
        db_session.add(transcript)
        db_session.commit()

        mock_claude_response = {
            "summary": "Test summary.",
            "key_points": ["Point 1", "Point 2"],
            "action_items": [
                {"description": "Task 1", "owner": "Speaker 1", "due_date": None}
            ],
            "follow_ups": ["Follow up 1"]
        }

        with patch("app.services.summarisation.call_claude_api") as mock_claude, \
             patch("app.services.pipeline.SyncSessionLocal") as mock_session:
            mock_claude.return_value = mock_claude_response
            mock_session.return_value.__enter__ = Mock(return_value=db_session)
            mock_session.return_value.__exit__ = Mock(return_value=None)

            result = summarise_meeting(test_meeting.id)

        assert result["meeting_id"] == test_meeting.id
        assert result["status"] == "summarised"
        assert result["action_items_count"] == 1
