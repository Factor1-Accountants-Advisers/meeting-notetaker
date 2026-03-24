"""Summarisation service using Claude API.

Handles:
1. Calling the Claude API with meeting transcripts
2. Parsing structured JSON responses
3. Saving summaries and action items to the database
"""
import json
import logging
from datetime import date
from typing import Any, Dict, List, Tuple

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import ActionItem, Meeting, MeetingStatus, Summary, Transcript

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are a meeting summariser for an Australian accounting firm. Given a meeting transcript with speaker labels, produce a JSON response with exactly this structure:
{
  "summary": "A 3-5 sentence overview of the meeting",
  "key_points": ["Point 1", "Point 2", ...],
  "action_items": [
    {
      "description": "What needs to be done",
      "owner": "Speaker name or 'Unassigned'",
      "due_date": "YYYY-MM-DD or null if not mentioned"
    }
  ],
  "follow_ups": ["Any unresolved questions or topics to revisit"]
}
Be specific about action items. Extract real deadlines mentioned in the conversation. If a speaker volunteers to do something, they are the owner."""


def get_anthropic_client():
    """Get an Anthropic API client.

    Lazy import to avoid loading anthropic on module import.

    Returns:
        anthropic.Anthropic client instance
    """
    import anthropic
    return anthropic.Anthropic(api_key=settings.anthropic_api_key)


def call_claude_api(transcript_text: str) -> Dict[str, Any]:
    """Call Claude API to summarise a meeting transcript.

    Args:
        transcript_text: The meeting transcript text with speaker labels

    Returns:
        Parsed JSON response dict with summary, key_points, action_items, follow_ups

    Raises:
        ValueError: If Claude returns invalid JSON
        Exception: On API errors (propagated as-is)
    """
    client = get_anthropic_client()

    message = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=4096,
        system=SYSTEM_PROMPT,
        messages=[
            {
                "role": "user",
                "content": f"Please summarise this meeting transcript:\n\n{transcript_text}",
            }
        ],
    )

    response_text = message.content[0].text

    try:
        return json.loads(response_text)
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON response from Claude: {e}")


def summarise_transcript(transcript_text: str) -> Dict[str, Any]:
    """Summarise a meeting transcript using Claude.

    Args:
        transcript_text: The meeting transcript text with speaker labels

    Returns:
        Parsed JSON response dict with summary, key_points, action_items, follow_ups
    """
    return call_claude_api(transcript_text)


def format_segments_for_claude(segments: List[Dict[str, Any]]) -> str:
    """Format transcript segments into readable text for Claude.

    Args:
        segments: List of segment dicts with keys: speaker, start, end, text

    Returns:
        Formatted string with "Speaker: text" lines joined by newlines.
        Returns empty string if segments is empty.
    """
    if not segments:
        return ""

    lines = []
    for segment in segments:
        speaker = segment.get("speaker", "Unknown")
        text = segment.get("text", "").strip()
        if text:  # Only include segments with non-empty text
            lines.append(f"{speaker}: {text}")

    return "\n".join(lines)


def save_summary(
    db: Session, meeting_id: int, summarisation_result: Dict[str, Any]
) -> Tuple[Summary, List[ActionItem]]:
    """Save summarisation results to the database.

    Args:
        db: SQLAlchemy session
        meeting_id: The meeting ID to associate with the summary
        summarisation_result: Dict with keys: summary, key_points, action_items, follow_ups

    Returns:
        Tuple of (Summary record, list of ActionItem records)
    """
    # Create Summary record
    summary = Summary(
        meeting_id=meeting_id,
        summary_text=summarisation_result["summary"],
        key_points=summarisation_result.get("key_points", []),
        follow_ups=summarisation_result.get("follow_ups", []),
    )
    db.add(summary)

    # Create ActionItem records
    action_items = []
    for item in summarisation_result.get("action_items", []):
        # Parse due_date: if truthy string, use date.fromisoformat, else None
        due = item.get("due_date")
        due_date = None
        if due:
            due_date = date.fromisoformat(due)

        action_item = ActionItem(
            meeting_id=meeting_id,
            description=item["description"],
            owner_name=item.get("owner"),
            due_date=due_date,
        )
        db.add(action_item)
        action_items.append(action_item)

    # Commit all changes
    db.commit()

    # Refresh objects from database
    db.refresh(summary)
    for action_item in action_items:
        db.refresh(action_item)

    return summary, action_items


def process_summarisation(db: Session, meeting_id: int) -> Tuple[Summary, List[ActionItem]]:
    """Orchestrate the full summarisation pipeline for a meeting.

    Fetches transcript, calls Claude API, saves results, and updates meeting status.

    Args:
        db: SQLAlchemy session
        meeting_id: The meeting ID to summarise

    Returns:
        Tuple of (Summary record, list of ActionItem records)

    Raises:
        ValueError: If transcript not found
        Exception: On API or database errors (meeting status set to FAILED)
    """
    # Query transcript
    transcript = db.query(Transcript).filter(Transcript.meeting_id == meeting_id).first()
    if not transcript:
        raise ValueError(f"Transcript not found for meeting {meeting_id}")

    # Query meeting
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()

    # Set status to SUMMARISING
    meeting.status = MeetingStatus.SUMMARISING
    db.commit()

    try:
        # Format transcript text for Claude
        formatted_text = format_segments_for_claude(transcript.segments or [])

        # Fallback to full_text if segments are empty
        if not formatted_text and transcript.full_text:
            formatted_text = transcript.full_text

        # Call Claude API
        result = call_claude_api(formatted_text)

        # Save summary and action items
        summary, action_items = save_summary(db, meeting_id, result)

        # Update meeting status to COMPLETE
        meeting.status = MeetingStatus.COMPLETE
        db.commit()

        return summary, action_items

    except Exception:
        # Set status to FAILED on any error
        meeting.status = MeetingStatus.FAILED
        db.commit()
        raise
