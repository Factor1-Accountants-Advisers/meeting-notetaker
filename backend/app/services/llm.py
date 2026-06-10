"""Provider-agnostic LLM interface (decision #4).

The backend talks to this protocol only; Azure OpenAI is the default
implementation and other providers can be swapped in without touching callers.
Real Azure wiring lands with the pipeline work.
"""

from typing import Protocol

from app.schemas import ActionItem, TranscriptSegment


class SummaryProvider(Protocol):
    async def summarize(self, segments: list[TranscriptSegment]) -> str:
        """Generate a concise meeting summary from a labelled transcript."""
        ...

    async def extract_action_items(
        self, segments: list[TranscriptSegment]
    ) -> list[ActionItem]:
        """Extract structured action items (owner, deadline, priority, status)."""
        ...


class AzureOpenAIProvider:
    """Default provider. Stub until Azure OpenAI is provisioned."""

    async def summarize(self, segments: list[TranscriptSegment]) -> str:
        raise NotImplementedError("Azure OpenAI wiring lands with the pipeline work")

    async def extract_action_items(
        self, segments: list[TranscriptSegment]
    ) -> list[ActionItem]:
        raise NotImplementedError("Azure OpenAI wiring lands with the pipeline work")


def get_llm_provider() -> SummaryProvider:
    return AzureOpenAIProvider()
