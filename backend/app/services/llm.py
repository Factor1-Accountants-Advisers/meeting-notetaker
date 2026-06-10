"""Provider-agnostic LLM interface (decision #4).

The backend talks to this protocol only; Azure OpenAI is the default
implementation once provisioned, and other providers can be swapped in
without touching callers. A stub keeps the pipeline runnable without Azure.
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
    return StubLLMProvider()
