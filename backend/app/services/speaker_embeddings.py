"""Speaker embedding provider (decision #2: pyannote for voiceprint matching).

Extracts embeddings from audio clips for enrollment and from diarized speaker
segments for matching. The provider is behind an interface so the real
pyannote client and the stub are interchangeable.
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


class StubSpeakerEmbeddingProvider:
    """Returns a deterministic pseudo-embedding so speaker matching logic can
    be exercised without pyannote or a HuggingFace token."""

    def __init__(self, dim: int = 192) -> None:
        self._dim = dim

    async def extract_embedding(self, audio: bytes) -> list[float]:
        # Deterministic: use the first N bytes of the audio as seed for a
        # reproducible vector. This lets tests distinguish different speakers
        # from different audio clips.
        seed = sum(audio[:64]) if audio else 0
        return [(seed * (i + 1) % 1000) / 1000.0 for i in range(self._dim)]

    @property
    def embedding_dim(self) -> int:
        return self._dim


class PyannoteEmbeddingProvider:
    """Real pyannote embedding extraction. Requires HF_TOKEN and the model
    name configured in settings."""

    def __init__(self, model_name: str, hf_token: str) -> None:
        self._model_name = model_name
        self._hf_token = hf_token

    async def extract_embedding(self, audio: bytes) -> list[float]:
        raise NotImplementedError(
            "Pyannote embedding extraction requires a provisioned HF token "
            "and the model to be installed. Wire when credentials exist."
        )

    @property
    def embedding_dim(self) -> int:
        return 192  # pyannote/embedding default


def get_embedding_provider() -> SpeakerEmbeddingProvider:
    from app.config import get_settings
    settings = get_settings()
    if settings.pyannote_hf_token:
        return PyannoteEmbeddingProvider(
            model_name=settings.pyannote_model_version,
            hf_token=settings.pyannote_hf_token,
        )
    return StubSpeakerEmbeddingProvider()
