"""Speaker embedding provider boundary.

Jira IN-64/IN-69 require pyannoteAI for voiceprint speaker identification.
The final provider should use pyannoteAI voiceprint/identify jobs, not local
pseudo-embeddings. Until that provider is wired, enrollment must fail clearly
instead of creating fake voiceprints.
"""

from typing import Protocol


class SpeakerEmbeddingProvider(Protocol):
    """Extract a fixed-length embedding vector from raw audio."""

    async def extract_embedding(self, audio: bytes) -> list[float]:
        ...

    @property
    def embedding_dim(self) -> int:
        """Dimensionality of the embeddings this provider produces."""
        ...


class UnavailableSpeakerEmbeddingProvider:
    """Explicit failure provider used until pyannoteAI voiceprints are wired."""

    @property
    def embedding_dim(self) -> int:
        return 0

    async def extract_embedding(self, audio: bytes) -> list[float]:
        raise RuntimeError(
            "Voiceprint enrollment requires pyannoteAI voiceprint API wiring; "
            "fake local embeddings are disabled."
        )


def get_embedding_provider() -> SpeakerEmbeddingProvider:
    return UnavailableSpeakerEmbeddingProvider()
