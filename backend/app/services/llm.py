"""Provider-agnostic LLM interface (decision #4).

The backend talks to this protocol only; OpenAI and Azure OpenAI are both
supported through a provider-agnostic interface. A stub keeps the pipeline
runnable without either.
"""

from __future__ import annotations

import asyncio
import html
import json
import urllib.request
from datetime import date
from typing import Any, Protocol
from uuid import UUID, uuid4

from app.config import get_settings
from app.schemas import ActionItem, ActionItemStatus, Priority, TranscriptSegment

CHUNK_WINDOW_MS = 15 * 60 * 1000
MAX_CHUNK_CONCURRENCY = 3

# Section headers shared by the plain-text and HTML summary renderers. Keeping
# them in one place means the minutes parsers in the meetings router can rely on
# the exact wording.
SUMMARY_SECTIONS: tuple[tuple[str, str], ...] = (
    ("key_points", "Key discussion"),
    ("decisions", "Decisions"),
    ("open_questions", "Open questions"),
    ("next_meeting", "Next meeting"),
)

# System prompts implementing the IN-106 "AI Summary Instructions" behavioral
# rules (no invented content, explicit owners only, Australian spelling,
# verb-led actions, disagreements recorded as unresolved). Module-level so
# tests can pin the agreed rules against regressions.
_CHUNK_SYSTEM_PROMPT = (
    "Extract structured meeting insights from this transcript chunk. "
    "Use only evidence in the chunk. Do not infer or invent decisions, commitments, or action items "
    "that are not present, and do not speculate based on the meeting topic. "
    "Preserve exact speaker display names for owners; never assign an owner who is not explicitly "
    "associated with the action. "
    "Record unresolved disagreements between speakers in 'questions' as "
    "'Unresolved: [name] and [name] had differing views on [topic]. To be confirmed.' "
    "Capture any statements about when the next meeting will happen or items flagged for its agenda "
    "in 'next_meeting' verbatim. Return valid JSON only."
)
_REDUCE_SYSTEM_PROMPT = (
    "Consolidate chunk-level meeting insights into final, client-ready meeting notes. "
    "Write in formal professional English with Australian spelling. "
    "Write 'overview' as a concise 2-4 sentence paragraph in a professional tone. "
    "Populate 'key_points', 'decisions', and 'open_questions' as short, deduplicated bullet strings "
    "(omit or leave empty when a section has nothing substantive). "
    "Keep decisions distinct from actions: a decision is something resolved; an action is something "
    "still to be done. Record unresolved disagreements in 'open_questions' as "
    "'Unresolved: [name] and [name] had differing views on [topic]. To be confirmed.' "
    "Populate 'next_meeting' only from explicit statements: the agreed date/time as a bullet "
    "formatted 'Date: ...', plus each agenda item flagged for the next meeting as its own bullet "
    "(leave empty when nothing was stated). "
    "Start every action item description with a verb (e.g. 'Submit', 'Review', 'Schedule'). "
    "Deduplicate action items, preserve explicit owners only, use exact speaker display names when "
    "owner names appear in the chunks. Return plain text in every field (no markdown or HTML) and valid JSON only."
)


class SummaryProvider(Protocol):
    async def summarize(self, segments: list[TranscriptSegment]) -> str:
        """Generate a concise plain-text meeting summary from a transcript."""
        ...

    async def summarize_html(self, segments: list[TranscriptSegment]) -> str | None:
        """Return a rich-text (HTML) summary fragment, or None if unsupported."""
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

    async def summarize_html(self, segments: list[TranscriptSegment]) -> str | None:
        return None

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


def _string_list(value: Any) -> list[str]:
    """Coerce a model-supplied field into a clean list of non-empty strings."""
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _overview_text(insights: dict[str, Any]) -> str:
    # `summary` kept as a fallback key for older cached/reduced payloads.
    return str(insights.get("overview") or insights.get("summary") or "").strip()


def _compose_plain_summary(insights: dict[str, Any]) -> str:
    """Render structured insights into a plain-text summary.

    Used for the in-app summary, search index, and the transcript attachment.
    The section headers match SUMMARY_SECTIONS so the minutes parsers can read
    decisions and open questions back out.
    """
    overview = _overview_text(insights)
    lines: list[str] = [overview] if overview else []
    for key, title in SUMMARY_SECTIONS:
        items = _string_list(insights.get(key))
        if not items:
            continue
        lines.extend(["", title])
        lines.extend(f"- {item}" for item in items)
    return "\n".join(lines).strip() or "No summary was generated."


# Inline styling only — email clients (notably Outlook) strip <style> blocks.
_HTML_FONT = "Segoe UI, Arial, sans-serif"
_HTML_TEXT = "#1f2937"
_HTML_MUTED = "#4b5563"
_HTML_HEADING = "#111827"


def _render_summary_html(insights: dict[str, Any]) -> str:
    """Render structured insights into an escaped HTML fragment for email.

    HTML is generated deterministically here (never taken from the model) so the
    output is consistent and injection-safe.
    """
    parts: list[str] = []
    overview = _overview_text(insights)
    if overview:
        parts.append(
            f'<p style="margin:0 0 16px;font-family:{_HTML_FONT};font-size:14px;'
            f'line-height:1.6;color:{_HTML_TEXT};">{html.escape(overview)}</p>'
        )
    for key, title in SUMMARY_SECTIONS:
        items = _string_list(insights.get(key))
        if not items:
            continue
        rows = "".join(f'<li style="margin:0 0 6px;">{html.escape(item)}</li>' for item in items)
        parts.append(
            f'<h3 style="margin:20px 0 8px;font-family:{_HTML_FONT};font-size:15px;'
            f'font-weight:600;color:{_HTML_HEADING};">{html.escape(title)}</h3>'
            f'<ul style="margin:0 0 16px;padding-left:20px;font-family:{_HTML_FONT};'
            f'font-size:14px;line-height:1.5;color:{_HTML_MUTED};">{rows}</ul>'
        )
    return "".join(parts)


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
        return _compose_plain_summary(insights)

    async def summarize_html(self, segments: list[TranscriptSegment]) -> str | None:
        if len(_segments_to_labelled_transcript(segments)) < 80:
            return None
        insights = await self._meeting_insights(segments)
        return _render_summary_html(insights) or None

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
                "next_meeting": ["string"],
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
            _CHUNK_SYSTEM_PROMPT,
            payload,
            max_tokens=1200,
        )

    async def _reduce_chunk_insights(self, chunk_results: list[dict[str, Any]]) -> dict[str, Any]:
        payload = {
            "task": "reduce_insights",
            "today": date.today().isoformat(),
            "chunks": chunk_results,
            "schema": {
                "overview": "string",
                "key_points": ["string"],
                "decisions": ["string"],
                "open_questions": ["string"],
                "next_meeting": ["string"],
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
            _REDUCE_SYSTEM_PROMPT,
            payload,
            max_tokens=1800,
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

    async def summarize_html(self, segments: list[TranscriptSegment]) -> str | None:
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
