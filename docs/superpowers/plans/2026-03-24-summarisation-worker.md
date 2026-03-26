# Summarisation Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Claude API summarisation service that takes speaker-labelled transcripts, extracts summaries/key points/action items, and saves them to the database — completing the processing pipeline.

**Architecture:** A service module (`summarisation.py`) calls the Anthropic Claude API with a system prompt that outputs structured JSON. The service formats transcript segments, sends them to Claude, parses the response, and persists Summary + ActionItem records. A Celery task (`summarise_meeting`) in `pipeline.py` wraps the service and is chained after diarisation in the main pipeline.

**Tech Stack:** Python 3.11+, Anthropic SDK (`anthropic==0.18.1`), SQLAlchemy (sync sessions), Celery, PostgreSQL (JSONB columns)

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `backend/app/services/summarisation.py` | Claude API client, transcript formatting, summary persistence |
| Modify | `backend/app/services/pipeline.py:81-82` | Add `summarise_meeting` Celery task, wire it into `process_meeting` |
| Exists | `backend/tests/test_summarisation.py` | 14 pre-written tests defining the full interface contract |

---

### Task 1: Create `summarisation.py` — Claude API client functions

**Files:**
- Create: `backend/app/services/summarisation.py`
- Test: `backend/tests/test_summarisation.py` (already exists — `TestClaudeSummarisation` class)

- [ ] **Step 1: Run the existing tests to confirm they fail**

```bash
cd backend
python -m pytest tests/test_summarisation.py::TestClaudeSummarisation -v 2>&1 | head -30
```

Expected: All tests FAIL with `ModuleNotFoundError: No module named 'app.services.summarisation'`

- [ ] **Step 2: Create `summarisation.py` with `get_anthropic_client`, `call_claude_api`, and `summarise_transcript`**

Create `backend/app/services/summarisation.py`:

```python
"""Summarisation service using Anthropic Claude API.

Handles:
1. Formatting speaker-labelled transcript segments for Claude
2. Calling Claude API with structured JSON output prompt
3. Parsing and validating the response
4. Saving Summary and ActionItem records to database
5. Updating meeting status

OWASP: No sensitive data logged, fail-closed on errors.
"""
import json
import logging
from datetime import date
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import (
    ActionItem,
    Meeting,
    MeetingStatus,
    Summary,
    Transcript,
)

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
    """Create and return an Anthropic client.

    Returns:
        anthropic.Anthropic: Configured API client.
    """
    import anthropic

    return anthropic.Anthropic(api_key=settings.anthropic_api_key)


def call_claude_api(transcript_text: str) -> Dict[str, Any]:
    """Send transcript to Claude API and return structured summary.

    Args:
        transcript_text: Speaker-labelled transcript text.

    Returns:
        Dictionary with summary, key_points, action_items, follow_ups.

    Raises:
        ValueError: If Claude returns invalid JSON.
        Exception: On API communication errors.
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
    """Summarise a transcript using Claude API.

    Public-facing wrapper around call_claude_api.

    Args:
        transcript_text: Speaker-labelled transcript text.

    Returns:
        Dictionary with summary, key_points, action_items, follow_ups.
    """
    return call_claude_api(transcript_text)
```

- [ ] **Step 3: Run the Claude API tests to verify they pass**

```bash
cd backend
python -m pytest tests/test_summarisation.py::TestClaudeSummarisation -v
```

Expected: All 5 tests in `TestClaudeSummarisation` PASS

- [ ] **Step 4: Commit**

```bash
cd backend
git add app/services/summarisation.py
git commit -m "feat(summarisation): add Claude API client functions

Implements get_anthropic_client() and call_claude_api() with
structured JSON parsing. Uses claude-sonnet-4-20250514 model
with firm-specific system prompt."
```

---

### Task 2: Add transcript formatting function

**Files:**
- Modify: `backend/app/services/summarisation.py`
- Test: `backend/tests/test_summarisation.py` (already exists — `TestTranscriptFormatting` class)

- [ ] **Step 1: Run the formatting tests to confirm they fail**

```bash
cd backend
python -m pytest tests/test_summarisation.py::TestTranscriptFormatting -v
```

Expected: FAIL with `ImportError` (function doesn't exist yet)

- [ ] **Step 2: Add `format_segments_for_claude` to `summarisation.py`**

Append after `call_claude_api`:

```python
def format_segments_for_claude(segments: List[Dict[str, Any]]) -> str:
    """Format transcript segments into readable text for Claude.

    Args:
        segments: List of dicts with speaker, start, end, text keys.

    Returns:
        Formatted transcript string with "Speaker: text" lines.
    """
    if not segments:
        return ""

    lines = []
    for seg in segments:
        speaker = seg.get("speaker", "Unknown")
        text = seg.get("text", "").strip()
        lines.append(f"{speaker}: {text}")

    return "\n".join(lines)
```

- [ ] **Step 3: Run the formatting tests to verify they pass**

```bash
cd backend
python -m pytest tests/test_summarisation.py::TestTranscriptFormatting -v
```

Expected: All 3 tests PASS

- [ ] **Step 4: Commit**

```bash
cd backend
git add app/services/summarisation.py
git commit -m "feat(summarisation): add transcript segment formatter

Converts speaker-labelled segments into readable text for the
Claude API prompt."
```

---

### Task 3: Add database persistence functions

**Files:**
- Modify: `backend/app/services/summarisation.py`
- Test: `backend/tests/test_summarisation.py` (already exists — `TestSaveSummary` class)

- [ ] **Step 1: Run the save tests to confirm they fail**

```bash
cd backend
python -m pytest tests/test_summarisation.py::TestSaveSummary -v
```

Expected: FAIL with `ImportError`

- [ ] **Step 2: Add `save_summary` to `summarisation.py`**

Append after `format_segments_for_claude`:

```python
def save_summary(
    db: Session,
    meeting_id: int,
    summarisation_result: Dict[str, Any],
) -> Tuple[Summary, List[ActionItem]]:
    """Save summarisation results to database.

    Creates a Summary record and ActionItem records from the Claude response.

    Args:
        db: Database session.
        meeting_id: Meeting ID to associate records with.
        summarisation_result: Dict with summary, key_points, action_items, follow_ups.

    Returns:
        Tuple of (Summary, list of ActionItems).
    """
    summary = Summary(
        meeting_id=meeting_id,
        summary_text=summarisation_result["summary"],
        key_points=summarisation_result.get("key_points", []),
        follow_ups=summarisation_result.get("follow_ups", []),
    )
    db.add(summary)

    action_items = []
    for item in summarisation_result.get("action_items", []):
        due = item.get("due_date")
        due_date = date.fromisoformat(due) if due else None

        action_item = ActionItem(
            meeting_id=meeting_id,
            description=item["description"],
            owner_name=item.get("owner"),
            due_date=due_date,
        )
        db.add(action_item)
        action_items.append(action_item)

    db.commit()
    db.refresh(summary)
    for ai in action_items:
        db.refresh(ai)

    return summary, action_items
```

- [ ] **Step 3: Run the save tests to verify they pass**

```bash
cd backend
python -m pytest tests/test_summarisation.py::TestSaveSummary -v
```

Expected: Both tests PASS

- [ ] **Step 4: Commit**

```bash
cd backend
git add app/services/summarisation.py
git commit -m "feat(summarisation): add database persistence for summaries

Creates Summary and ActionItem records from Claude API response.
Handles optional due_date parsing and empty action item lists."
```

---

### Task 4: Add pipeline orchestration function

**Files:**
- Modify: `backend/app/services/summarisation.py`
- Test: `backend/tests/test_summarisation.py` (already exists — `TestSummarisationPipeline` class)

- [ ] **Step 1: Run the pipeline tests to confirm they fail**

```bash
cd backend
python -m pytest tests/test_summarisation.py::TestSummarisationPipeline -v
```

Expected: FAIL with `ImportError`

- [ ] **Step 2: Add `process_summarisation` to `summarisation.py`**

Append after `save_summary`:

```python
def process_summarisation(
    db: Session,
    meeting_id: int,
) -> Tuple[Summary, List[ActionItem]]:
    """Run the full summarisation pipeline for a meeting.

    1. Loads transcript from DB
    2. Formats segments for Claude
    3. Calls Claude API
    4. Saves Summary + ActionItems
    5. Updates meeting status to COMPLETE

    Args:
        db: Database session.
        meeting_id: Meeting ID to summarise.

    Returns:
        Tuple of (Summary, list of ActionItems).

    Raises:
        ValueError: If transcript not found for meeting.
    """
    # Load transcript
    transcript = (
        db.query(Transcript)
        .filter(Transcript.meeting_id == meeting_id)
        .first()
    )
    if not transcript:
        raise ValueError(f"Transcript not found for meeting {meeting_id}")

    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()

    try:
        # Update status
        meeting.status = MeetingStatus.SUMMARISING
        db.commit()

        # Format segments and call Claude
        formatted_text = format_segments_for_claude(transcript.segments or [])
        if not formatted_text and transcript.full_text:
            formatted_text = transcript.full_text

        result = call_claude_api(formatted_text)

        # Save to database
        summary, action_items = save_summary(db, meeting_id, result)

        # Mark complete
        meeting.status = MeetingStatus.COMPLETE
        db.commit()

        logger.info(
            f"Summarisation complete for meeting {meeting_id}: "
            f"{len(action_items)} action items"
        )

        return summary, action_items

    except Exception:
        meeting.status = MeetingStatus.FAILED
        db.commit()
        raise
```

- [ ] **Step 3: Run the pipeline tests to verify they pass**

```bash
cd backend
python -m pytest tests/test_summarisation.py::TestSummarisationPipeline -v
```

Expected: All 3 tests PASS

- [ ] **Step 4: Commit**

```bash
cd backend
git add app/services/summarisation.py
git commit -m "feat(summarisation): add pipeline orchestration function

process_summarisation loads transcript, calls Claude, saves
results, and manages meeting status transitions."
```

---

### Task 5: Add Celery task and wire into pipeline

**Files:**
- Modify: `backend/app/services/pipeline.py:81-82` (replace TODO with `summarise_meeting` call)
- Modify: `backend/app/services/pipeline.py` (add `summarise_meeting` task at end)
- Test: `backend/tests/test_summarisation.py` (already exists — `TestSummarisationCeleryTask` class)

- [ ] **Step 1: Run the Celery task test to confirm it fails**

```bash
cd backend
python -m pytest tests/test_summarisation.py::TestSummarisationCeleryTask -v
```

Expected: FAIL with `ImportError: cannot import name 'summarise_meeting' from 'app.services.pipeline'`

- [ ] **Step 2: Add `summarise_meeting` Celery task to `pipeline.py`**

Add this task after the `diarize_meeting` task (before `cleanup_temp_files`):

```python
@shared_task(bind=True, max_retries=3)
def summarise_meeting(self, meeting_id: int) -> dict:
    """Celery task to summarise a meeting transcript with Claude.

    Loads the speaker-labelled transcript, calls Claude API,
    and saves Summary + ActionItem records.

    Args:
        meeting_id: ID of the meeting to summarise

    Returns:
        Dictionary with summarisation results
    """
    from app.services.summarisation import process_summarisation

    logger.info(f"Starting summarisation task for meeting {meeting_id}")

    with SyncSessionLocal() as session:
        try:
            summary, action_items = process_summarisation(session, meeting_id)

            return {
                "meeting_id": meeting_id,
                "status": "summarised",
                "action_items_count": len(action_items),
            }

        except Exception as e:
            logger.error(f"Summarisation task failed for meeting {meeting_id}: {e}")
            raise
```

- [ ] **Step 3: Wire `summarise_meeting` into `process_meeting`**

In `pipeline.py`, replace lines 81-82:

```python
        # TODO: Step 6 - Summarize with Claude
        # summarize_meeting(meeting_id)
```

With:

```python
        # Step 6: Summarise with Claude
        summarise_meeting(meeting_id)
```

- [ ] **Step 4: Run the Celery task test to verify it passes**

```bash
cd backend
python -m pytest tests/test_summarisation.py::TestSummarisationCeleryTask -v
```

Expected: PASS

- [ ] **Step 5: Run ALL summarisation tests to verify nothing is broken**

```bash
cd backend
python -m pytest tests/test_summarisation.py -v
```

Expected: All 14 tests PASS

- [ ] **Step 6: Run the full test suite**

```bash
cd backend
python -m pytest tests/ -v
```

Expected: All tests PASS (transcription + diarisation + summarisation)

- [ ] **Step 7: Commit**

```bash
cd backend
git add app/services/summarisation.py app/services/pipeline.py
git commit -m "feat(pipeline): add summarisation Celery task and wire into pipeline

Adds summarise_meeting task that calls Claude API via
process_summarisation. Pipeline now runs: transcribe →
diarise → summarise → complete."
```

---

## Verification Checklist

After all tasks, confirm:

- [ ] `backend/app/services/summarisation.py` exists with 6 functions: `get_anthropic_client`, `call_claude_api`, `format_segments_for_claude`, `summarise_transcript`, `save_summary`, `process_summarisation`
- [ ] `backend/app/services/pipeline.py` has `summarise_meeting` task and the TODO comment is replaced
- [ ] All 14 tests in `test_summarisation.py` pass
- [ ] All other tests (transcription, diarisation) still pass
- [ ] No hardcoded API keys — `settings.anthropic_api_key` is used via env var

## Notes for the Implementer

- **anthropic SDK version**: `0.18.1` is pinned in `requirements.txt`. The `client.messages.create()` API is stable at this version. Do NOT upgrade without checking for breaking changes.
- **SQLite in tests**: Tests use in-memory SQLite via `conftest.py`. JSONB columns work because SQLAlchemy falls back to JSON type for SQLite. No Postgres needed for tests.
- **Model choice**: The spec says `claude-sonnet-4-20250514`. This is configured directly in `call_claude_api`. If the team wants to make this configurable, add a `claude_model` field to `Settings` later — not now (YAGNI).
- **`summarise_transcript` function**: The tests call `summarise_transcript(text)` which is a thin wrapper around `call_claude_api`. Look at `test_summarise_transcript_returns_structured_response` — it patches `call_claude_api` and calls `summarise_transcript`. This means `summarise_transcript` just delegates to `call_claude_api`. Add it as a simple wrapper.
