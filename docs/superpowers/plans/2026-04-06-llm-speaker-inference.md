# LLM Speaker Inference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve transcript speaker labeling by using an LLM to infer which generic speaker labels (Speaker 1, Speaker 2) correspond to real meeting participants, based on conversational cues in the transcript.

**Architecture:** After AssemblyAI transcribes and diarises audio, and after generic speaker renaming (A→Speaker 1), a new LLM inference step sends the transcript plus the candidate pool (attendees, organizer, recorder) to OpenAI. The LLM returns a confidence-scored mapping of speakers to real names. Only confident matches (≥0.7) replace generic labels. The summarisation step then consumes real names where available, producing better action-item ownership. The inference is best-effort — failures fall back to generic labels without breaking the pipeline.

**Tech Stack:** Python 3.11+, FastAPI, SQLAlchemy, OpenAI API (GPT-4o), pytest

---

## File Structure

**Create**
- `backend/app/services/speaker_inference.py` — LLM-based speaker-to-participant matching logic (prompt, API call, confidence gating)
- `backend/tests/test_speaker_inference.py` — unit tests for inference prompt building, response parsing, confidence gating, and error handling

**Modify**
- `backend/app/models.py` — add `identity_hints` JSON column to Meeting, add `is_organizer` boolean to Participant
- `backend/app/schemas.py` — accept `organizer` and `source_event_id` in upload metadata, add `raw_speaker` to transcript segment response
- `backend/app/routers/meetings.py` — persist identity hints and organizer flag during upload
- `backend/app/services/diarisation.py` — integrate speaker inference after generic renaming
- `backend/app/services/transcription.py` — enrich AssemblyAI name pool with organizer and current user names
- `backend/tests/conftest.py` — add `test_meeting_with_participants` fixture
- `backend/tests/test_diarisation.py` — add tests for LLM-integrated diarisation path
- `backend/tests/test_transcription.py` — add test for enriched name pool

---

## Task 1: Add Identity Hints Column and Organizer Flag to Models

**Files:**
- Modify: `backend/app/models.py:56-74` (Meeting class), `backend/app/models.py:77-85` (Participant class)
- Test: `backend/tests/test_diarisation.py` (existing tests must still pass)

- [ ] **Step 1: Add `identity_hints` to Meeting and `is_organizer` to Participant**

```python
# models.py — Meeting class, add after audio_blob_url (line 66):
    identity_hints = Column(JSONType, nullable=True)  # {current_user, organizer, source_event_id}

# models.py — Participant class, add after email (line 84):
    is_organizer = Column(Boolean, default=False, nullable=False)
```

- [ ] **Step 2: Run existing tests to verify no regressions**

Run: `cd backend && python -m pytest tests/test_diarisation.py::TestSpeakerNaming tests/test_diarisation.py::TestDiarisationPipeline tests/test_summarisation.py -v`
Expected: All existing tests PASS (SQLite auto-creates columns from model changes)
Note: Exclude `TestDiarisationCeleryTask` and `TestCeleryTask` — they reference `diarize_meeting`/`transcribe_meeting` functions that were removed when the pipeline was simplified from Celery to background threads.

- [ ] **Step 3: Commit**

```bash
git add backend/app/models.py
git commit -m "feat: add identity_hints to Meeting and is_organizer to Participant"
```

---

## Task 2: Accept Organizer and Source Event ID in Upload Metadata

**Files:**
- Modify: `backend/app/schemas.py:50-55` (MeetingUploadMetadata)
- Modify: `backend/app/schemas.py:92-104` (TranscriptSegment, TranscriptResponse)
- Modify: `backend/app/routers/meetings.py:186-213` (upload_meeting)
- Test: `backend/tests/test_read_endpoints.py`

- [ ] **Step 1: Extend `MeetingUploadMetadata` schema to accept organizer and source_event_id**

```python
# schemas.py — MeetingUploadMetadata (replace existing class at line 50):
class MeetingUploadMetadata(BaseModel):
    """Metadata sent with audio upload."""
    meeting_title: str
    attendees: List[ParticipantBase] = Field(..., min_length=1)
    scheduled_time: Optional[datetime] = None
    organizer: Optional[ParticipantBase] = None
    source_event_id: Optional[str] = None
```

- [ ] **Step 2: Add `raw_speaker` to `TranscriptSegment` response schema**

```python
# schemas.py — TranscriptSegment (replace existing class at line 92):
class TranscriptSegment(BaseModel):
    """Single transcript segment with speaker and timestamp."""
    speaker: str
    start: float
    end: float
    text: str
    raw_speaker: Optional[str] = None
    matched_email: Optional[str] = None
    match_confidence: Optional[float] = None
```

- [ ] **Step 3: Persist identity hints and organizer flag during upload**

```python
# routers/meetings.py — in upload_meeting(), replace the meeting creation block (lines 188-205):

        # Build identity hints — always include current_user (the recorder)
        identity_hints = {
            "source_event_id": meeting_metadata.source_event_id,
            "current_user": {
                "name": current_user.name,
                "email": current_user.email,
                "azure_ad_id": current_user.azure_ad_id,
                "is_current_user": True,
            },
            "organizer": (
                {
                    "name": meeting_metadata.organizer.name,
                    "email": meeting_metadata.organizer.email,
                    "is_organizer": True,
                }
                if meeting_metadata.organizer else None
            ),
        }

        # Create meeting record
        meeting = Meeting(
            title=meeting_metadata.meeting_title,
            scheduled_time=normalize_scheduled_time(meeting_metadata.scheduled_time),
            status=MeetingStatus.PROCESSING,
            audio_blob_url=blob_path,
            user_id=current_user.id,
            identity_hints=identity_hints,
        )
        db.add(meeting)
        await db.flush()

        # Create participant records
        for attendee in meeting_metadata.attendees:
            is_org = (
                meeting_metadata.organizer is not None
                and attendee.email is not None
                and meeting_metadata.organizer.email is not None
                and attendee.email.lower() == meeting_metadata.organizer.email.lower()
            )
            participant = Participant(
                meeting_id=meeting.id,
                name=attendee.name,
                email=attendee.email,
                is_organizer=is_org,
            )
            db.add(participant)
```

- [ ] **Step 4: Run existing endpoint tests to verify no regressions**

Run: `cd backend && python -m pytest tests/test_read_endpoints.py -v`
Expected: All existing tests PASS (new fields are optional, backward compatible)

- [ ] **Step 5: Commit**

```bash
git add backend/app/schemas.py backend/app/routers/meetings.py
git commit -m "feat: accept organizer and source_event_id in upload metadata"
```

---

## Task 3: Create Speaker Inference Service

**Files:**
- Create: `backend/app/services/speaker_inference.py`
- Create: `backend/tests/test_speaker_inference.py`

- [ ] **Step 1: Write failing tests for candidate pool building**

```python
# tests/test_speaker_inference.py
"""Tests for LLM-based speaker inference service."""
import json
import pytest
from types import SimpleNamespace
from unittest.mock import Mock, patch, MagicMock


class TestBuildCandidatePool:
    """Tests for building the candidate identity pool."""

    def test_builds_pool_from_participants(self):
        from app.services.speaker_inference import build_candidate_pool

        participants = [
            SimpleNamespace(name="Alice Smith", email="alice@example.com", is_organizer=False),
            SimpleNamespace(name="Bob Jones", email="bob@example.com", is_organizer=True),
        ]

        pool = build_candidate_pool(participants, identity_hints=None)

        assert len(pool) == 2
        assert pool[0]["display_name"] == "Alice Smith"
        assert pool[1]["is_organizer"] is True

    def test_adds_current_user_from_hints(self):
        from app.services.speaker_inference import build_candidate_pool

        participants = [
            SimpleNamespace(name="Alice Smith", email="alice@example.com", is_organizer=False),
        ]
        hints = {
            "current_user": {
                "name": "Joseph Guerrero",
                "email": "joseph@example.com",
                "is_current_user": True,
            },
        }

        pool = build_candidate_pool(participants, identity_hints=hints)

        assert len(pool) == 2
        recorder = [c for c in pool if c.get("is_recorder")]
        assert len(recorder) == 1
        assert recorder[0]["display_name"] == "Joseph Guerrero"

    def test_marks_existing_participant_as_recorder(self):
        from app.services.speaker_inference import build_candidate_pool

        participants = [
            SimpleNamespace(name="Joseph Guerrero", email="joseph@example.com", is_organizer=False),
        ]
        hints = {
            "current_user": {
                "name": "Joseph Guerrero",
                "email": "joseph@example.com",
                "is_current_user": True,
            },
        }

        pool = build_candidate_pool(participants, identity_hints=hints)

        assert len(pool) == 1
        assert pool[0]["is_recorder"] is True

    def test_adds_organizer_from_hints_if_missing(self):
        from app.services.speaker_inference import build_candidate_pool

        participants = [
            SimpleNamespace(name="Alice Smith", email="alice@example.com", is_organizer=False),
        ]
        hints = {
            "organizer": {
                "name": "Melissa Hall",
                "email": "melissa@example.com",
                "is_organizer": True,
            },
        }

        pool = build_candidate_pool(participants, identity_hints=hints)

        assert len(pool) == 2
        org = [c for c in pool if c.get("is_organizer")]
        assert org[0]["display_name"] == "Melissa Hall"

    def test_returns_empty_pool_for_empty_inputs(self):
        from app.services.speaker_inference import build_candidate_pool

        pool = build_candidate_pool(participants=[], identity_hints=None)

        assert pool == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_speaker_inference.py::TestBuildCandidatePool -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.speaker_inference'`

- [ ] **Step 3: Implement `build_candidate_pool`**

```python
# app/services/speaker_inference.py
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_speaker_inference.py::TestBuildCandidatePool -v`
Expected: PASS

- [ ] **Step 5: Write failing tests for LLM inference and confidence gating**

```python
# tests/test_speaker_inference.py — add to the file:

class TestInferSpeakerIdentities:
    """Tests for the LLM speaker inference call."""

    def test_returns_mapping_for_confident_matches(self):
        from app.services.speaker_inference import infer_speaker_identities

        segments = [
            {"speaker": "Speaker 1", "start": 0.0, "end": 5.0, "text": "Thanks Melissa, I agree."},
            {"speaker": "Speaker 2", "start": 5.0, "end": 10.0, "text": "No worries Joseph."},
        ]
        candidates = [
            {"display_name": "Joseph Guerrero", "email": "joseph@example.com", "is_organizer": False, "is_recorder": True},
            {"display_name": "Melissa Hall", "email": "melissa@example.com", "is_organizer": True, "is_recorder": False},
        ]

        mock_response_content = json.dumps({
            "mappings": [
                {"speaker_label": "Speaker 1", "assigned_name": "Joseph Guerrero", "assigned_email": "joseph@example.com", "confidence": 0.95, "reasoning": "Speaker 2 addresses them as Joseph"},
                {"speaker_label": "Speaker 2", "assigned_name": "Melissa Hall", "assigned_email": "melissa@example.com", "confidence": 0.9, "reasoning": "Speaker 1 addresses them as Melissa"},
            ]
        })

        mock_client = Mock()
        mock_choice = Mock()
        mock_choice.message.content = mock_response_content
        mock_client.chat.completions.create.return_value = Mock(choices=[mock_choice])

        with patch("app.services.speaker_inference.get_openai_client", return_value=mock_client):
            mapping = infer_speaker_identities(segments, candidates)

        assert "Speaker 1" in mapping
        assert mapping["Speaker 1"]["display_name"] == "Joseph Guerrero"
        assert "Speaker 2" in mapping
        assert mapping["Speaker 2"]["display_name"] == "Melissa Hall"

    def test_excludes_low_confidence_matches(self):
        from app.services.speaker_inference import infer_speaker_identities

        segments = [
            {"speaker": "Speaker 1", "start": 0.0, "end": 5.0, "text": "Let's begin."},
            {"speaker": "Speaker 2", "start": 5.0, "end": 10.0, "text": "Sure."},
        ]
        candidates = [
            {"display_name": "Alice", "email": "alice@example.com", "is_organizer": False, "is_recorder": False},
            {"display_name": "Bob", "email": "bob@example.com", "is_organizer": False, "is_recorder": False},
        ]

        mock_response_content = json.dumps({
            "mappings": [
                {"speaker_label": "Speaker 1", "assigned_name": "Alice", "assigned_email": "alice@example.com", "confidence": 0.4, "reasoning": "Weak guess"},
                {"speaker_label": "Speaker 2", "assigned_name": None, "assigned_email": None, "confidence": 0.0, "reasoning": "No evidence"},
            ]
        })

        mock_client = Mock()
        mock_choice = Mock()
        mock_choice.message.content = mock_response_content
        mock_client.chat.completions.create.return_value = Mock(choices=[mock_choice])

        with patch("app.services.speaker_inference.get_openai_client", return_value=mock_client):
            mapping = infer_speaker_identities(segments, candidates)

        assert len(mapping) == 0

    def test_returns_empty_mapping_on_empty_inputs(self):
        from app.services.speaker_inference import infer_speaker_identities

        assert infer_speaker_identities([], []) == {}
        assert infer_speaker_identities([{"speaker": "A", "text": "Hi"}], []) == {}

    def test_returns_empty_mapping_on_api_error(self):
        from app.services.speaker_inference import infer_speaker_identities

        segments = [{"speaker": "Speaker 1", "start": 0.0, "end": 1.0, "text": "Hello"}]
        candidates = [{"display_name": "Alice", "email": "a@b.com", "is_organizer": False, "is_recorder": False}]

        with patch("app.services.speaker_inference.get_openai_client") as mock_get:
            mock_get.return_value.chat.completions.create.side_effect = Exception("API down")

            mapping = infer_speaker_identities(segments, candidates)

        assert mapping == {}

    def test_returns_empty_mapping_on_invalid_json(self):
        from app.services.speaker_inference import infer_speaker_identities

        segments = [{"speaker": "Speaker 1", "start": 0.0, "end": 1.0, "text": "Hello"}]
        candidates = [{"display_name": "Alice", "email": "a@b.com", "is_organizer": False, "is_recorder": False}]

        mock_client = Mock()
        mock_choice = Mock()
        mock_choice.message.content = "not json"
        mock_client.chat.completions.create.return_value = Mock(choices=[mock_choice])

        with patch("app.services.speaker_inference.get_openai_client", return_value=mock_client):
            mapping = infer_speaker_identities(segments, candidates)

        assert mapping == {}
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_speaker_inference.py::TestInferSpeakerIdentities -v`
Expected: FAIL — `ImportError: cannot import name 'infer_speaker_identities'`

- [ ] **Step 7: Implement the LLM inference function**

```python
# app/services/speaker_inference.py — add after build_candidate_pool:

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
    except Exception as e:
        logger.warning(f"Speaker inference LLM call failed: {e}")
        return {}

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
                f"Speaker '{label}' not mapped: confidence={confidence:.2f}, name={name}"
            )

    return mapping
```

- [ ] **Step 8: Run all speaker inference tests**

Run: `cd backend && python -m pytest tests/test_speaker_inference.py -v`
Expected: All PASS

- [ ] **Step 9: Commit**

```bash
git add backend/app/services/speaker_inference.py backend/tests/test_speaker_inference.py
git commit -m "feat: add LLM-based speaker inference service"
```

---

## Task 4: Integrate Speaker Inference into the Diarisation Pipeline

**Files:**
- Modify: `backend/app/services/diarisation.py:1-131`
- Modify: `backend/tests/test_diarisation.py`
- Modify: `backend/tests/conftest.py`

- [ ] **Step 1: Add `test_meeting_with_participants` fixture to conftest**

```python
# tests/conftest.py — add after the test_meeting fixture (after line 85):

@pytest.fixture
def test_meeting_with_participants(db_session: Session, test_user: User) -> Meeting:
    """Create a test meeting with participants and identity hints."""
    from app.models import Participant

    meeting = Meeting(
        title="Scheduled Team Meeting",
        scheduled_time=datetime.utcnow(),
        status=MeetingStatus.PROCESSING,
        audio_blob_url="audio/2026/04/06/test_audio.wav",
        user_id=test_user.id,
        identity_hints={
            "current_user": {
                "name": "Test User",
                "email": "test@example.com",
                "azure_ad_id": "test-azure-id-123",
                "is_current_user": True,
            },
            "organizer": {
                "name": "Melissa Hall",
                "email": "melissa@example.com",
                "is_organizer": True,
            },
            "source_event_id": "evt-123",
        },
    )
    db_session.add(meeting)
    db_session.flush()

    p1 = Participant(
        meeting_id=meeting.id,
        name="Test User",
        email="test@example.com",
        is_organizer=False,
    )
    p2 = Participant(
        meeting_id=meeting.id,
        name="Melissa Hall",
        email="melissa@example.com",
        is_organizer=True,
    )
    db_session.add_all([p1, p2])
    db_session.commit()
    db_session.refresh(meeting)
    return meeting
```

- [ ] **Step 2: Write failing tests for LLM-integrated diarisation**

```python
# tests/test_diarisation.py — add new test class at the end:

class TestDiarisationWithSpeakerInference:
    """Tests for diarisation with LLM speaker inference."""

    def test_applies_llm_mapping_when_confident(
        self,
        db_session: Session,
        test_meeting_with_participants: Meeting,
    ):
        """Should replace Speaker N with real names when LLM is confident."""
        from app.services.diarisation import process_diarisation

        transcript = Transcript(
            meeting_id=test_meeting_with_participants.id,
            full_text="Thanks Melissa. No worries.",
            segments=[
                {"speaker": "A", "start": 0.0, "end": 3.0, "text": "Thanks Melissa, I agree with the plan."},
                {"speaker": "B", "start": 3.0, "end": 6.0, "text": "No worries, happy to help."},
            ],
        )
        db_session.add(transcript)
        db_session.commit()

        mock_mapping = {
            "Speaker 1": {
                "display_name": "Test User",
                "email": "test@example.com",
                "confidence": 0.95,
                "reasoning": "Speaker 2 is addressed as Melissa, so Speaker 1 is the other participant",
            },
            "Speaker 2": {
                "display_name": "Melissa Hall",
                "email": "melissa@example.com",
                "confidence": 0.9,
                "reasoning": "Addressed as Melissa by Speaker 1",
            },
        }

        with patch("app.services.diarisation.infer_speaker_identities", return_value=mock_mapping):
            updated = process_diarisation(db_session, test_meeting_with_participants.id)

        assert updated.segments[0]["speaker"] == "Test User"
        assert updated.segments[1]["speaker"] == "Melissa Hall"
        assert updated.segments[0]["raw_speaker"] == "A"
        assert updated.segments[1]["raw_speaker"] == "B"

    def test_keeps_generic_labels_when_inference_fails(
        self,
        db_session: Session,
        test_meeting_with_participants: Meeting,
    ):
        """Should keep Speaker N labels when LLM inference fails."""
        from app.services.diarisation import process_diarisation

        transcript = Transcript(
            meeting_id=test_meeting_with_participants.id,
            full_text="Hello. Hi.",
            segments=[
                {"speaker": "A", "start": 0.0, "end": 3.0, "text": "Hello."},
                {"speaker": "B", "start": 3.0, "end": 6.0, "text": "Hi."},
            ],
        )
        db_session.add(transcript)
        db_session.commit()

        with patch("app.services.diarisation.infer_speaker_identities", side_effect=Exception("API down")):
            updated = process_diarisation(db_session, test_meeting_with_participants.id)

        assert updated.segments[0]["speaker"] == "Speaker 1"
        assert updated.segments[1]["speaker"] == "Speaker 2"

    def test_keeps_generic_labels_when_no_candidates(
        self,
        db_session: Session,
        test_meeting: Meeting,
    ):
        """Should keep Speaker N labels when no identity hints exist."""
        from app.services.diarisation import process_diarisation

        transcript = Transcript(
            meeting_id=test_meeting.id,
            full_text="Hello. Hi.",
            segments=[
                {"speaker": "A", "start": 0.0, "end": 3.0, "text": "Hello."},
                {"speaker": "B", "start": 3.0, "end": 6.0, "text": "Hi."},
            ],
        )
        db_session.add(transcript)
        db_session.commit()

        updated = process_diarisation(db_session, test_meeting.id)

        assert updated.segments[0]["speaker"] == "Speaker 1"
        assert updated.segments[1]["speaker"] == "Speaker 2"

    def test_preserves_raw_speaker_on_all_segments(
        self,
        db_session: Session,
        test_meeting_with_participants: Meeting,
    ):
        """Every segment should have raw_speaker after diarisation."""
        from app.services.diarisation import process_diarisation

        transcript = Transcript(
            meeting_id=test_meeting_with_participants.id,
            full_text="Hello. Hi.",
            segments=[
                {"speaker": "A", "start": 0.0, "end": 3.0, "text": "Hello."},
                {"speaker": "B", "start": 3.0, "end": 6.0, "text": "Hi."},
            ],
        )
        db_session.add(transcript)
        db_session.commit()

        with patch("app.services.diarisation.infer_speaker_identities", return_value={}):
            updated = process_diarisation(db_session, test_meeting_with_participants.id)

        for seg in updated.segments:
            assert "raw_speaker" in seg
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_diarisation.py::TestDiarisationWithSpeakerInference -v`
Expected: FAIL — `infer_speaker_identities` not imported / segments lack `raw_speaker`

- [ ] **Step 4: Rewrite `process_diarisation` to integrate speaker inference**

```python
# app/services/diarisation.py — replace the entire file:

"""Speaker diarisation service — speaker label post-processing.

AssemblyAI handles the actual diarisation during transcription.
This module handles:
1. Renaming generic speaker labels (A, B, C) to human-readable names
2. LLM-based speaker inference to map generic labels to real participants
3. Preserving raw speaker IDs for auditability
"""
import logging
from typing import Dict, Any, List, Optional

from sqlalchemy.orm import Session

from app.models import Meeting, Participant, Transcript, MeetingStatus
from app.services.speaker_inference import build_candidate_pool, infer_speaker_identities

logger = logging.getLogger(__name__)


def rename_speakers(
    segments: List[Dict[str, Any]],
    speaker_mapping: Optional[Dict[str, str]] = None,
) -> List[Dict[str, Any]]:
    """Rename speaker IDs to human-readable names.

    If speaker_mapping is provided, uses those names.
    Otherwise, converts "A" -> "Speaker 1", "B" -> "Speaker 2", etc.
    """
    if speaker_mapping is None:
        speaker_mapping = {}

    seen_speakers = []
    for seg in segments:
        speaker = seg.get("speaker", "Unknown")
        if speaker not in seen_speakers and speaker != "Unknown":
            seen_speakers.append(speaker)

    auto_mapping = {}
    for i, speaker in enumerate(seen_speakers):
        if speaker not in speaker_mapping:
            auto_mapping[speaker] = f"Speaker {i + 1}"

    full_mapping = {**auto_mapping, **speaker_mapping}

    renamed = []
    for seg in segments:
        new_seg = seg.copy()
        speaker = seg.get("speaker", "Unknown")
        new_seg["raw_speaker"] = speaker  # Preserve original
        if speaker in full_mapping:
            new_seg["speaker"] = full_mapping[speaker]
        renamed.append(new_seg)

    return renamed


def process_diarisation(db: Session, meeting_id: int) -> Transcript:
    """Post-process speaker labels with identity-aware matching.

    Steps:
    1. Rename generic labels (A, B) to Speaker 1, Speaker 2
    2. If identity hints exist, run LLM inference to map speakers to real names
    3. Apply confident mappings; keep Speaker N for uncertain matches
    4. Preserve raw_speaker on every segment
    """
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if not meeting:
        raise ValueError(f"Meeting not found: {meeting_id}")

    transcript = db.query(Transcript).filter(
        Transcript.meeting_id == meeting_id
    ).first()
    if not transcript:
        raise ValueError(f"Transcript not found for meeting: {meeting_id}")

    try:
        meeting.status = MeetingStatus.DIARISING
        db.commit()

        segments = transcript.segments or []

        if transcript.speaker_identified:
            # AssemblyAI already mapped to real names
            logger.info(f"Meeting {meeting_id}: AssemblyAI speaker ID used, skipping rename")
            final_segments = [
                {**seg, "raw_speaker": seg.get("raw_speaker", seg.get("speaker", "Unknown"))}
                for seg in segments
            ]
        else:
            # Step 1: Generic rename (A → Speaker 1, B → Speaker 2)
            final_segments = rename_speakers(segments)

            # Step 2: LLM inference if we have identity context
            participants = db.query(Participant).filter(
                Participant.meeting_id == meeting_id
            ).all()

            candidates = build_candidate_pool(participants, meeting.identity_hints)

            if candidates and final_segments:
                try:
                    speaker_mapping = infer_speaker_identities(final_segments, candidates)

                    if speaker_mapping:
                        logger.info(
                            f"Meeting {meeting_id}: LLM mapped {len(speaker_mapping)} speakers"
                        )
                        for seg in final_segments:
                            match = speaker_mapping.get(seg["speaker"])
                            if match:
                                seg["speaker"] = match["display_name"]
                                seg["matched_email"] = match.get("email")
                                seg["match_confidence"] = match["confidence"]
                except Exception as e:
                    logger.warning(
                        f"Meeting {meeting_id}: speaker inference failed, "
                        f"keeping generic labels: {e}"
                    )

        speakers = {seg.get("speaker") for seg in final_segments}
        logger.info(f"Meeting {meeting_id}: {len(speakers)} speakers: {speakers}")

        transcript.segments = final_segments
        db.commit()
        db.refresh(transcript)

        return transcript

    except Exception as e:
        logger.error(f"Diarisation failed for meeting {meeting_id}: {e}")
        meeting.status = MeetingStatus.FAILED
        db.commit()
        raise
```

- [ ] **Step 5: Run all diarisation tests (old + new)**

Run: `cd backend && python -m pytest tests/test_diarisation.py::TestSpeakerNaming tests/test_diarisation.py::TestDiarisationPipeline tests/test_diarisation.py::TestDiarisationWithSpeakerInference -v`
Expected: All PASS (existing tests still work because `rename_speakers` signature is unchanged and `raw_speaker` is now always set)
Note: Exclude `TestDiarisationCeleryTask` — references removed `diarize_meeting` function.

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/diarisation.py backend/tests/test_diarisation.py backend/tests/conftest.py
git commit -m "feat: integrate LLM speaker inference into diarisation pipeline"
```

---

## Task 5: Enrich AssemblyAI Name Pool with Organizer and Current User

**Files:**
- Modify: `backend/app/services/transcription.py:185-260` (process_transcription)
- Test: `backend/tests/test_transcription.py`

- [ ] **Step 1: Write failing test for enriched name pool**

```python
# tests/test_transcription.py — add to TestTranscriptionPipeline class:

    def test_process_transcription_includes_organizer_and_user_names(
        self, db_session: Session, test_meeting_with_participants: Meeting, sample_audio_file
    ):
        """Should pass organizer and current user names to AssemblyAI."""
        from app.services.transcription import process_transcription

        with patch("app.services.transcription.download_audio") as mock_download:
            mock_download.return_value = sample_audio_file

            with patch("app.services.transcription.transcribe_audio") as mock_transcribe:
                mock_transcribe.return_value = {
                    "text": "Test",
                    "segments": [{"speaker": "A", "start": 0.0, "end": 1.0, "text": "Test"}],
                    "speaker_identified": False,
                }

                process_transcription(db_session, test_meeting_with_participants.id)

                # Verify name pool includes organizer and current user
                names = mock_transcribe.call_args.kwargs.get("participant_names", [])
                assert "Melissa Hall" in names
                assert "Test User" in names
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_transcription.py::TestTranscriptionPipeline::test_process_transcription_includes_organizer_and_user_names -v`
Expected: FAIL — organizer and current user names are not added to the name pool

- [ ] **Step 3: Enrich the name pool in `process_transcription`**

```python
# app/services/transcription.py — in process_transcription(), after
# collecting participant_names (lines 221-226), add:

        # Enrich name pool with organizer and current user from identity hints
        identity_hints = meeting.identity_hints or {}
        organizer_name = (identity_hints.get("organizer") or {}).get("name")
        if organizer_name and organizer_name not in participant_names:
            participant_names.append(organizer_name)

        current_user_name = (identity_hints.get("current_user") or {}).get("name")
        if current_user_name and current_user_name not in participant_names:
            participant_names.append(current_user_name)
```

- [ ] **Step 4: Run all transcription tests**

Run: `cd backend && python -m pytest tests/test_transcription.py::TestTranscriptionService tests/test_transcription.py::TestTranscriptSaving tests/test_transcription.py::TestAudioDownload tests/test_transcription.py::TestTranscriptionPipeline -v`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/transcription.py backend/tests/test_transcription.py
git commit -m "feat: enrich AssemblyAI name pool with organizer and current user"
```

---

## Task 6: Full Test Suite Verification

**Files:** None modified — verification only.

- [ ] **Step 1: Run the complete backend test suite (excluding broken Celery test classes)**

Run: `cd backend && python -m pytest -v --deselect tests/test_diarisation.py::TestDiarisationCeleryTask --deselect tests/test_transcription.py::TestCeleryTask --deselect tests/test_summarisation.py::TestSummarisationCeleryTask`
Expected: All tests PASS
Note: The three Celery test classes reference `diarize_meeting`/`transcribe_meeting`/`summarise_meeting` functions that were removed when the pipeline was simplified from Celery to background threads. They are pre-existing broken tests, not caused by this plan.

- [ ] **Step 2: Verify the diarisation pipeline end-to-end with a mock**

Run: `cd backend && python -m pytest tests/test_diarisation.py::TestSpeakerNaming tests/test_diarisation.py::TestDiarisationPipeline tests/test_diarisation.py::TestDiarisationWithSpeakerInference tests/test_speaker_inference.py tests/test_transcription.py::TestTranscriptionService tests/test_transcription.py::TestTranscriptSaving tests/test_transcription.py::TestAudioDownload tests/test_transcription.py::TestTranscriptionPipeline tests/test_summarisation.py::TestOpenAISummarisation tests/test_summarisation.py::TestTranscriptFormatting tests/test_summarisation.py::TestSaveSummary tests/test_summarisation.py::TestSummarisationPipeline -v`
Expected: All PASS

- [ ] **Step 3: Quick manual smoke test**

Run:
```bash
cd backend
uvicorn app.main:app --reload --port 8000
```

Then upload a test file via the API docs at `http://localhost:8000/docs` and verify:
- Upload accepts `organizer` and `source_event_id` in metadata
- Meeting detail shows `identity_hints` are stored
- Transcript segments contain `raw_speaker` field
- Processing completes without errors in the console

- [ ] **Step 4: Commit any fixes from smoke testing**

```bash
git status --short
```

Expected: No uncommitted identity-matching changes remain.

---

## Self-Review

- **Spec coverage:** The plan covers candidate pool building, LLM inference with confidence gating, integration into the diarisation pipeline, enriched AssemblyAI name pool, schema changes, and full test coverage. No spec sections unassigned.
- **Placeholder scan:** No `TODO` / `TBD` placeholders. All file paths, commands, code, and expected results are explicit.
- **Type consistency:** `identity_hints`, `raw_speaker`, `match_confidence`, `matched_email` used consistently across models, schemas, services, and tests.
- **Backward compatibility:** All new schema fields are optional. Meetings uploaded without organizer/hints continue to work exactly as before (generic Speaker N labels).
- **Failure safety:** LLM inference is wrapped in try/except at both the service level (returns `{}`) and the diarisation level (catches and logs). Pipeline never breaks due to inference failure.
