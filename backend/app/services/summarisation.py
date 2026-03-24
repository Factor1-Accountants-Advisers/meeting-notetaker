"""Summarisation service using Claude API.

Handles:
1. Calling the Claude API with meeting transcripts
2. Parsing structured JSON responses
3. Saving summaries and action items to the database
"""
import json
import logging
from typing import Any, Dict

from app.core.config import settings

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
