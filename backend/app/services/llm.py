"""Provider-agnostic LLM interface (decision #4).

The backend talks to this protocol only; OpenAI and Azure OpenAI are both
supported through a provider-agnostic interface. A stub keeps the pipeline
runnable without either.
"""

from datetime import date, timedelta
from typing import Protocol
from uuid import UUID, uuid4

from app.config import get_settings
from app.schemas import ActionItem, ActionItemStatus, Priority, TranscriptSegment


class SummaryProvider(Protocol):
    async def summarize(self, segments: list[TranscriptSegment]) -> str:
        """Generate a concise meeting summary from a labelled transcript."""
        ...

    async def extract_action_items(
        self, meeting_id: UUID, segments: list[TranscriptSegment]
    ) -> list[ActionItem]:
        """Extract structured action items (owner, deadline, priority, status)."""
        ...


class StubLLMProvider:
    """Deterministic placeholder output shaped like the real thing."""

    async def summarize(self, segments: list[TranscriptSegment]) -> str:
        speakers = sorted({s.speaker for s in segments})
        return (
            "The group reviewed current status and agreed the headline numbers are in. "
            "Two items need decisions before close-off: one is owned with an update due "
            "next week, the other will be confirmed and circulated before Friday. "
            f"Speakers: {', '.join(speakers)}. "
            "(Placeholder summary — Azure OpenAI not configured.)"
        )

    async def extract_action_items(
        self, meeting_id: UUID, segments: list[TranscriptSegment]
    ) -> list[ActionItem]:
        first_speaker = segments[0].speaker if segments else None
        today = date.today()
        return [
            ActionItem(
                id=uuid4(),
                meeting_id=meeting_id,
                owner=first_speaker,
                description="Prepare an update on the first open item",
                deadline=today + timedelta(days=7),
                priority=Priority.medium,
                status=ActionItemStatus.open,
            ),
            ActionItem(
                id=uuid4(),
                meeting_id=meeting_id,
                owner=segments[1].speaker if len(segments) > 1 else None,
                description="Confirm details of the second item and circulate",
                deadline=today + timedelta(days=3),
                priority=Priority.high,
                status=ActionItemStatus.open,
            ),
        ]


class OpenAIProvider:
    """Direct OpenAI API provider (api.openai.com)."""

    def __init__(self, api_key: str, model: str = "gpt-4o"):
        self._api_key = api_key
        self._model = model

    async def summarize(self, segments: list[TranscriptSegment]) -> str:
        import json
        import urllib.request

        speaker_lines = "\n".join(
            f"[{s.speaker}]: {s.text}" for s in segments
        )
        if len(speaker_lines) < 80:
            return (
                "The recording was too short to produce a meaningful summary. "
                "Ensure system audio is being captured and try a longer recording."
            )
        payload = {
            "model": self._model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are a meeting notetaker for an accounting firm. "
                        "Write a concise summary of the following meeting transcript "
                        "in 2-3 paragraphs. Focus on decisions made, action items, "
                        "and key discussion points. Use plain business English."
                    ),
                },
                {"role": "user", "content": speaker_lines},
            ],
            "temperature": 0.3,
            "max_tokens": 600,
        }
        req = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions",
            data=json.dumps(payload).encode(),
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read().decode())
        return body["choices"][0]["message"]["content"].strip()

    async def extract_action_items(
        self, meeting_id: UUID, segments: list[TranscriptSegment]
    ) -> list[ActionItem]:
        import json
        import urllib.request
        from datetime import date as date_type

        speaker_lines = "\n".join(
            f"[{s.speaker}]: {s.text}" for s in segments
        )
        if len(speaker_lines) < 80:
            return []
        today_str = date_type.today().isoformat()
        payload = {
            "model": self._model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You extract structured action items from meeting transcripts "
                        "for an accounting firm. Respond ONLY with a JSON array of objects, "
                        "each with: description (string), owner (string or null), "
                        "deadline (ISO date string or null), priority (high|medium|low), "
                        f"status (open). Today is {today_str}. "
                        "If no owner is clearly stated, use null. "
                        "If no deadline is stated, use null. "
                        "Include at most 5 items. Return [] if none."
                    ),
                },
                {"role": "user", "content": speaker_lines},
            ],
            "temperature": 0.2,
            "max_tokens": 800,
        }
        req = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions",
            data=json.dumps(payload).encode(),
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read().decode())
        raw = body["choices"][0]["message"]["content"].strip()

        # Strip markdown code fences if present
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[-1]
            if raw.endswith("```"):
                raw = raw[:-3]

        try:
            items_data = json.loads(raw)
        except json.JSONDecodeError:
            return []

        today = date_type.today()
        result: list[ActionItem] = []
        for item in items_data:
            try:
                deadline_str = item.get("deadline")
                deadline = (
                    date_type.fromisoformat(deadline_str) if deadline_str else None
                )
                priority_str = item.get("priority", "medium").lower()
                priority = Priority(
                    priority_str if priority_str in {"high", "medium", "low"} else "medium"
                )
                result.append(
                    ActionItem(
                        id=uuid4(),
                        meeting_id=meeting_id,
                        owner=item.get("owner"),
                        description=str(item.get("description", "")),
                        deadline=deadline,
                        priority=priority,
                        status=ActionItemStatus.open,
                    )
                )
            except Exception:
                continue
        return result


class AzureOpenAIProvider:
    """Default provider once the Azure OpenAI deployment exists."""

    async def summarize(self, segments: list[TranscriptSegment]) -> str:
        raise NotImplementedError("Azure OpenAI wiring requires a provisioned deployment")

    async def extract_action_items(
        self, meeting_id: UUID, segments: list[TranscriptSegment]
    ) -> list[ActionItem]:
        raise NotImplementedError("Azure OpenAI wiring requires a provisioned deployment")


def get_llm_provider() -> SummaryProvider:
    settings = get_settings()
    if settings.openai_endpoint and settings.openai_deployment:
        return AzureOpenAIProvider()
    if settings.openai_api_key:
        return OpenAIProvider(settings.openai_api_key)
    return StubLLMProvider()
