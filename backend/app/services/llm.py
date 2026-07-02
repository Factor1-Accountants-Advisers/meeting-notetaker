"""Provider-agnostic LLM interface (decision #4).

The backend talks to this protocol only; OpenAI and Azure OpenAI are both
supported through a provider-agnostic interface. A stub keeps the pipeline
runnable without either.
"""

from __future__ import annotations

import asyncio
import json
import urllib.request
from datetime import date
from typing import Any, Protocol
from uuid import UUID, uuid4

from app.config import get_settings
from app.schemas import ActionItem, ActionItemStatus, Priority, TranscriptSegment

CHUNK_WINDOW_MS = 15 * 60 * 1000
MAX_CHUNK_CONCURRENCY = 3


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
    """Explicit unavailable-provider response when OpenAI is not configured."""

    async def summarize(self, segments: list[TranscriptSegment]) -> str:
        return "Summary unavailable — configure MN_OPENAI_API_KEY."

    async def extract_action_items(
        self, meeting_id: UUID, segments: list[TranscriptSegment]
    ) -> list[ActionItem]:
        return []


def _format_ms(ms: int) -> str:
    total_seconds = max(0, ms // 1000)
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def _segments_to_labelled_transcript(segments: list[TranscriptSegment]) -> str:
    return "\n".join(
        f"[{_format_ms(s.start_ms)}-{_format_ms(s.end_ms)}] {s.speaker}: {s.text}"
        for s in segments
    )


def _chunk_segments_by_window_ms(
    segments: list[TranscriptSegment], *, window_ms: int = CHUNK_WINDOW_MS
) -> list[list[TranscriptSegment]]:
    if not segments:
        return []
    ordered = sorted(segments, key=lambda item: (item.start_ms, item.end_ms))
    chunks: list[list[TranscriptSegment]] = []
    current: list[TranscriptSegment] = []
    window_start = ordered[0].start_ms

    for item in ordered:
        if current and item.start_ms - window_start >= window_ms:
            chunks.append(current)
            current = []
            window_start = item.start_ms
        current.append(item)
    if current:
        chunks.append(current)
    return chunks


def _fingerprint_segments(segments: list[TranscriptSegment]) -> tuple[tuple[str, int, int, str], ...]:
    return tuple((s.speaker, s.start_ms, s.end_ms, s.text) for s in segments)


def _coerce_priority(value: Any) -> Priority:
    text = str(value or "medium").lower()
    return Priority(text if text in {"high", "medium", "low"} else "medium")


class OpenAIProvider:
    """Direct OpenAI API provider (api.openai.com).

    Long transcripts are handled with map-reduce: chunk-level structured JSON
    extraction over 15-minute windows, followed by a compact reduce pass. This
    avoids sending 1-3 hour transcripts as one huge prompt and gives deterministic
    action-item parsing.
    """

    def __init__(self, api_key: str, model: str = "gpt-4o"):
        self._api_key = api_key
        self._model = model
        self._insights_cache: dict[tuple[tuple[str, int, int, str], ...], dict[str, Any]] = {}

    async def summarize(self, segments: list[TranscriptSegment]) -> str:
        if len(_segments_to_labelled_transcript(segments)) < 80:
            return (
                "The recording was too short to produce a meaningful summary. "
                "Ensure system audio is being captured and try a longer recording."
            )
        insights = await self._meeting_insights(segments)
        return str(insights.get("summary") or "No summary was generated.").strip()

    async def extract_action_items(
        self, meeting_id: UUID, segments: list[TranscriptSegment]
    ) -> list[ActionItem]:
        if len(_segments_to_labelled_transcript(segments)) < 80:
            return []
        insights = await self._meeting_insights(segments)
        items_data = insights.get("action_items")
        if not isinstance(items_data, list):
            return []

        result: list[ActionItem] = []
        for item in items_data[:10]:
            if not isinstance(item, dict):
                continue
            description = str(item.get("description") or "").strip()
            if not description:
                continue
            try:
                deadline_raw = item.get("deadline")
                deadline = date.fromisoformat(str(deadline_raw)) if deadline_raw else None
            except ValueError:
                deadline = None
            result.append(
                ActionItem(
                    id=uuid4(),
                    meeting_id=meeting_id,
                    owner=item.get("owner") if item.get("owner") else None,
                    description=description,
                    deadline=deadline,
                    priority=_coerce_priority(item.get("priority")),
                    status=ActionItemStatus.open,
                )
            )
        return result

    async def _meeting_insights(self, segments: list[TranscriptSegment]) -> dict[str, Any]:
        key = _fingerprint_segments(segments)
        if key in self._insights_cache:
            return self._insights_cache[key]

        chunks = _chunk_segments_by_window_ms(segments)
        semaphore = asyncio.Semaphore(MAX_CHUNK_CONCURRENCY)

        async def run_chunk(index: int, chunk: list[TranscriptSegment]) -> dict[str, Any]:
            async with semaphore:
                return await self._extract_chunk_insights(index, len(chunks), chunk)

        chunk_results = await asyncio.gather(
            *(run_chunk(index, chunk) for index, chunk in enumerate(chunks, start=1))
        )
        reduced = await self._reduce_chunk_insights(chunk_results)
        self._insights_cache[key] = reduced
        return reduced

    async def _extract_chunk_insights(
        self, chunk_index: int, total_chunks: int, segments: list[TranscriptSegment]
    ) -> dict[str, Any]:
        payload = {
            "task": "chunk_insights",
            "chunk_index": chunk_index,
            "total_chunks": total_chunks,
            "transcript": _segments_to_labelled_transcript(segments),
            "schema": {
                "summary_bullets": ["string"],
                "decisions": ["string"],
                "risks": ["string"],
                "questions": ["string"],
                "action_items": [
                    {
                        "description": "string",
                        "owner": "string|null",
                        "deadline": "YYYY-MM-DD|null",
                        "priority": "high|medium|low",
                    }
                ],
            },
        }
        return await self._complete_json(
            "Extract structured meeting insights from this transcript chunk. "
            "Use only evidence in the chunk, preserve exact speaker display names for owners, and return valid JSON only.",
            payload,
            max_tokens=1200,
        )

    async def _reduce_chunk_insights(self, chunk_results: list[dict[str, Any]]) -> dict[str, Any]:
        payload = {
            "task": "reduce_insights",
            "today": date.today().isoformat(),
            "chunks": chunk_results,
            "schema": {
                "summary": "string",
                "action_items": [
                    {
                        "description": "string",
                        "owner": "string|null",
                        "deadline": "YYYY-MM-DD|null",
                        "priority": "high|medium|low",
                    }
                ],
            },
        }
        return await self._complete_json(
            "Consolidate chunk-level meeting insights into final notes. "
            "Deduplicate action items, preserve explicit owners only, use exact speaker display names when owner names appear in the chunks, and return valid JSON only.",
            payload,
            max_tokens=1600,
        )

    async def _complete_json(self, system_prompt: str, user_payload: dict, *, max_tokens: int) -> dict:
        def request_json() -> dict:
            payload = {
                "model": self._model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
                ],
                "temperature": 0.2,
                "max_tokens": max_tokens,
                "response_format": {"type": "json_object"},
            }
            req = urllib.request.Request(
                "https://api.openai.com/v1/chat/completions",
                data=json.dumps(payload).encode(),
                headers={
                    "Authorization": f"Bearer {self._api_key}",
                    "Content-Type": "application/json",
                },
            )
            with urllib.request.urlopen(req, timeout=90) as resp:
                body = json.loads(resp.read().decode())
            content = body["choices"][0]["message"]["content"].strip()
            return json.loads(content)

        return await asyncio.to_thread(request_json)


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
