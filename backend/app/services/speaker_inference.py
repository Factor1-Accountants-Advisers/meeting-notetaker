"""LLM-based speaker inference service.

Uses OpenAI to infer which generic speaker labels (Speaker 1, Speaker 2)
correspond to real meeting participants, based on conversational cues.

Only applied when identity hints (attendees, organizer, recorder) are
available. Falls back to generic labels when confidence is low or
inference fails.
"""
import json
import logging
from typing import Any

from app.core.config import settings

logger = logging.getLogger(__name__)

CONFIDENCE_THRESHOLD = 0.7


def build_candidate_pool(
    participants: list,
    identity_hints: dict | None,
) -> list[dict[str, Any]]:
    """Build the candidate identity pool from participants + hints.

    Deduplicates by email. Marks the current user as 'recorder' and
    the organizer as 'organizer' for the LLM prompt.
    """
    candidates = []
    seen_emails: set[str] = set()

    for p in participants:
        entry = {
            "display_name": p.name,
            "email": p.email,
            "is_organizer": getattr(p, "is_organizer", False),
            "is_recorder": False,
        }
        candidates.append(entry)
        if p.email:
            seen_emails.add(p.email.lower())

    hints = identity_hints or {}

    # Current user (recorder) — add or mark existing
    current_user = hints.get("current_user")
    if current_user and current_user.get("name"):
        email = (current_user.get("email") or "").lower()
        if email and email in seen_emails:
            for c in candidates:
                if (c.get("email") or "").lower() == email:
                    c["is_recorder"] = True
        elif email:
            candidates.append({
                "display_name": current_user["name"],
                "email": current_user.get("email"),
                "is_organizer": False,
                "is_recorder": True,
            })
            seen_emails.add(email)

    # Organizer — add if missing
    organizer = hints.get("organizer")
    if organizer and organizer.get("name"):
        email = (organizer.get("email") or "").lower()
        if email and email not in seen_emails:
            candidates.append({
                "display_name": organizer["name"],
                "email": organizer.get("email"),
                "is_organizer": True,
                "is_recorder": False,
            })

    return candidates


SPEAKER_INFERENCE_PROMPT = """\
You are a speaker identification assistant. Given a meeting transcript with \
generic speaker labels and a list of known meeting participants, determine \
which speaker label corresponds to which real person.

Use conversational cues to make your determination:
- Direct address: "Thanks Joseph" means the person addressed is likely Joseph
- Self-identification: "I'll send that from my end" plus context about roles
- Role references: "As the accountant..." or "from the audit team..."
- Response patterns: who responds to whom, who is asked questions
- The RECORDER is the person who started the recording. Their voice is \
typically clearest and most present on the microphone channel.

Only assign a real name when you have strong evidence from the conversation. \
If a speaker cannot be confidently identified, leave them as their generic \
label. A wrong assignment is worse than no assignment.

Return a JSON object with exactly this structure:
{
  "mappings": [
    {
      "speaker_label": "Speaker 1",
      "assigned_name": "Real Name" or null,
      "assigned_email": "email@example.com" or null,
      "confidence": 0.0 to 1.0,
      "reasoning": "Brief explanation of why this mapping was made"
    }
  ]
}

Set confidence to:
- 0.9+ direct evidence (addressed by name, self-identifies)
- 0.7-0.9 strong contextual evidence (role matches, consistent pattern)
- below 0.7 circumstantial or ambiguous
- 0.0 no evidence (set assigned_name to null)\
"""


def _format_transcript_for_inference(segments: list[dict]) -> str:
    """Format segments into readable text for the LLM."""
    lines = []
    for seg in segments:
        speaker = seg.get("speaker", "Unknown")
        text = seg.get("text", "").strip()
        if text:
            lines.append(f"{speaker}: {text}")
    return "\n".join(lines)


def _format_candidates_for_prompt(candidates: list[dict[str, Any]]) -> str:
    """Format candidates into a list for the LLM prompt."""
    lines = []
    for c in candidates:
        tags = []
        if c.get("is_organizer"):
            tags.append("ORGANIZER")
        if c.get("is_recorder"):
            tags.append("RECORDER")
        tag_str = f" [{', '.join(tags)}]" if tags else ""
        lines.append(f"- {c['display_name']} ({c.get('email', 'no email')}){tag_str}")
    return "\n".join(lines)


def get_openai_client():
    """Get an OpenAI API client (lazy import)."""
    from openai import OpenAI
    return OpenAI(api_key=settings.openai_api_key)


def infer_speaker_identities(
    segments: list[dict[str, Any]],
    candidates: list[dict[str, Any]],
    confidence_threshold: float = CONFIDENCE_THRESHOLD,
) -> dict[str, dict[str, Any]]:
    """Use LLM to infer which speakers map to which candidates.

    Returns a mapping of speaker_label -> {display_name, email, confidence, reasoning}.
    Only includes entries where confidence >= threshold.
    Returns empty dict on any error (best-effort, never breaks pipeline).
    """
    if not segments or not candidates:
        return {}

    transcript_text = _format_transcript_for_inference(segments)
    candidate_text = _format_candidates_for_prompt(candidates)

    user_message = (
        f"## Meeting participants\n{candidate_text}\n\n"
        f"## Transcript\n{transcript_text}"
    )

    try:
        client = get_openai_client()
        response = client.chat.completions.create(
            model=settings.openai_model,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": SPEAKER_INFERENCE_PROMPT},
                {"role": "user", "content": user_message},
            ],
        )

        result = json.loads(response.choices[0].message.content)

        mapping = {}
        for entry in result.get("mappings", []):
            label = entry.get("speaker_label")
            name = entry.get("assigned_name")
            confidence = entry.get("confidence", 0.0)

            if label and name and confidence >= confidence_threshold:
                mapping[label] = {
                    "display_name": name,
                    "email": entry.get("assigned_email"),
                    "confidence": confidence,
                    "reasoning": entry.get("reasoning", ""),
                }
            else:
                logger.info(
                    f"Speaker '{label}' not mapped: confidence={confidence}, name={name}"
                )

        return mapping
    except Exception as e:
        logger.warning(f"Speaker inference failed: {e}")
        return {}
