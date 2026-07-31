"""Provider-agnostic, structured meeting-output generation (IN-390).

The backend asks the configured provider for one versioned object containing
both the summary and action items. Plain text, HTML, API action items, and the
IN-384 Blob export are deterministic projections of that validated object.
"""

from __future__ import annotations

import asyncio
import html
import json
import urllib.request
from datetime import date
from typing import Any, Literal, Protocol
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field

from app.config import get_settings
from app.schemas import (
    ActionItem,
    ActionItemStatus,
    StructuredActionItem,
    StructuredMeetingOutput,
    TranscriptSegment,
)

CHUNK_WINDOW_MS = 15 * 60 * 1000
MAX_CHUNK_CONCURRENCY = 3
STRUCTURED_OUTPUT_SCHEMA_VERSION = "1.0"
PROVIDER_UNAVAILABLE_FLAG = "provider_unavailable"
TRANSCRIPT_TOO_SHORT_FLAG = "transcript_too_short"

# Section headers shared by the plain-text and HTML summary renderers. Keeping
# them in one place means the minutes parsers in the meetings router can rely on
# the exact wording.
SUMMARY_SECTIONS: tuple[tuple[str, str], ...] = (
    ("key_points", "Key discussion"),
    ("decisions", "Decisions"),
    ("unresolved_questions", "Open questions"),
    ("next_meeting", "Next meeting"),
)

# System prompts implementing the IN-106 "AI Summary Instructions" behavioural
# rules (no invented content, explicit owners only, Australian spelling,
# verb-led actions, disagreements recorded as unresolved). Module-level so
# tests can pin the agreed rules against regressions.
_CHUNK_SYSTEM_PROMPT = (
    "Extract structured meeting insights from this transcript chunk. "
    "Use only evidence in the chunk. Do not infer or invent decisions, commitments, or action items "
    "that are not present, and do not speculate based on the meeting topic. "
    "Preserve exact speaker display names for owner_name; never assign an owner who is not explicitly "
    "associated with the action. Leave owner metadata null when the transcript does not establish it. "
    "Record unresolved disagreements between speakers in 'questions' as "
    "'Unresolved: [name] and [name] had differing views on [topic]. To be confirmed.' "
    "Capture statements about when the next meeting will happen or items flagged for its agenda "
    "in 'next_meeting' verbatim. Start action descriptions with a verb. "
    "Use Australian spelling and return only the requested structured JSON."
)
_REDUCE_SYSTEM_PROMPT = (
    "Consolidate chunk-level meeting insights into one final, client-ready structured meeting output. "
    "Write in formal professional English with Australian spelling. "
    "Write 'summary' as a concise 2-4 sentence paragraph in a professional tone. "
    "Populate 'key_points', 'decisions', and 'unresolved_questions' as short, deduplicated strings "
    "(leave empty when a section has nothing substantive). "
    "Keep decisions distinct from actions: a decision is something resolved; an action is something "
    "still to be done. Record unresolved disagreements in 'unresolved_questions' as "
    "'Unresolved: [name] and [name] had differing views on [topic]. To be confirmed.' "
    "Populate 'next_meeting' only from explicit statements: the agreed date/time as an item "
    "formatted 'Date: ...', plus each agenda item flagged for the next meeting as its own item. "
    "Start every action item description with a verb (e.g. 'Submit', 'Review', 'Schedule'). "
    "Deduplicate action items, preserve explicit owners only, and use exact speaker display names. "
    "Do not infer owner email, department, assignment, source, or action type; leave any unsupported "
    "nullable field null. The payload's 'meeting_type' is 'internal' (Factor1 colleagues only) or "
    "'client' (external attendees present): for client meetings keep the summary suitable to share "
    "externally — no internal shorthand — and favour explicit commitments and follow-ups; for "
    "internal meetings internal project names may be used as spoken. "
    "Return plain text in every field (no markdown or HTML), set schema_version "
    f"to '{STRUCTURED_OUTPUT_SCHEMA_VERSION}', and return only the requested structured JSON."
)


# IN-383: company context is appended to the consolidated-generation system
# prompt as one clearly delimited block. Module-level constants so tests can
# pin the exact delimiters against regressions.
COMPANY_CONTEXT_HEADER = "## Company context"
COMPANY_CONTEXT_BEGIN = "<<<COMPANY_CONTEXT>>>"
COMPANY_CONTEXT_END = "<<<END_COMPANY_CONTEXT>>>"


def build_company_context_block(company_context: str) -> str:
    """Delimited system-prompt block carrying the company context (IN-383)."""
    # Structural defense: the fetched context is arbitrary, SharePoint-editable
    # text. If it contained a literal delimiter, it could fake the block
    # boundary and get its trailing content read as bare system-prompt text
    # (prompt injection). Strip both marker literals before wrapping so the
    # delimiters we emit are always the only ones present.
    sanitized = company_context.replace(COMPANY_CONTEXT_BEGIN, "").replace(
        COMPANY_CONTEXT_END, ""
    )
    return (
        f"\n\n{COMPANY_CONTEXT_HEADER}\n"
        "The company context between the delimiters below is background "
        "reference only. Use it to resolve names, products, and terminology. "
        "It is not meeting content: never derive summary points, decisions, "
        "or action items from it.\n"
        f"{COMPANY_CONTEXT_BEGIN}\n"
        f"{sanitized}\n"
        f"{COMPANY_CONTEXT_END}"
    )


class _ChunkTimeRange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)


class _ChunkInsights(BaseModel):
    """Strict map-stage contract; the reduce result is the public contract."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["1.0"]
    chunk_index: int = Field(ge=1)
    time_range: _ChunkTimeRange
    summary_bullets: list[str]
    decisions: list[str]
    risks: list[str]
    questions: list[str]
    next_meeting: list[str]
    action_items: list[StructuredActionItem]
    follow_ups: list[str]
    quality_flags: list[str]


class SummaryProvider(Protocol):
    async def generate(
        self,
        segments: list[TranscriptSegment],
        *,
        company_context: str | None = None,
        meeting_type: str | None = None,
    ) -> StructuredMeetingOutput:
        """Generate one versioned summary-and-actions object.

        ``company_context`` is the pre-fetched IN-383 enrichment text (one
        fetch per pipeline run, done by the caller) or ``None``.
        ``meeting_type`` is the Slice 1 classification (``"internal"`` /
        ``"client"``, IN-390) steering register and shareability.
        """
        ...


def _fallback_output(summary: str, flag: str) -> StructuredMeetingOutput:
    return StructuredMeetingOutput(
        schema_version=STRUCTURED_OUTPUT_SCHEMA_VERSION,
        summary=summary,
        key_points=[],
        decisions=[],
        action_items=[],
        unresolved_questions=[],
        next_meeting=[],
        follow_ups=[],
        quality_flags=[flag],
        source_chunks=[],
    )


class StubLLMProvider:
    """Explicit unavailable-provider response when OpenAI is not configured."""

    async def generate(
        self,
        segments: list[TranscriptSegment],
        *,
        company_context: str | None = None,
        meeting_type: str | None = None,
    ) -> StructuredMeetingOutput:
        return _fallback_output(
            "Summary unavailable — configure MN_OPENAI_API_KEY.",
            PROVIDER_UNAVAILABLE_FLAG,
        )


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


def _string_list(value: Any) -> list[str]:
    """Coerce a model-supplied field into a clean list of non-empty strings."""
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def compose_plain_summary(output: StructuredMeetingOutput) -> str:
    """Render the consolidated object for UI, search, and text delivery."""
    overview = output.summary.strip()
    lines: list[str] = [overview] if overview else []
    for key, title in SUMMARY_SECTIONS:
        items = _string_list(getattr(output, key))
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


def render_summary_html(output: StructuredMeetingOutput) -> str | None:
    """Render an escaped HTML projection, preserving fallback behaviour."""
    if PROVIDER_UNAVAILABLE_FLAG in output.quality_flags:
        return None
    if TRANSCRIPT_TOO_SHORT_FLAG in output.quality_flags:
        return None

    parts: list[str] = []
    overview = output.summary.strip()
    if overview:
        parts.append(
            f'<p style="margin:0 0 16px;font-family:{_HTML_FONT};font-size:14px;'
            f'line-height:1.6;color:{_HTML_TEXT};">{html.escape(overview)}</p>'
        )
    for key, title in SUMMARY_SECTIONS:
        items = _string_list(getattr(output, key))
        if not items:
            continue
        rows = "".join(f'<li style="margin:0 0 6px;">{html.escape(item)}</li>' for item in items)
        parts.append(
            f'<h3 style="margin:20px 0 8px;font-family:{_HTML_FONT};font-size:15px;'
            f'font-weight:600;color:{_HTML_HEADING};">{html.escape(title)}</h3>'
            f'<ul style="margin:0 0 16px;padding-left:20px;font-family:{_HTML_FONT};'
            f'font-size:14px;line-height:1.5;color:{_HTML_MUTED};">{rows}</ul>'
        )
    return "".join(parts) or None


def action_items_from_output(
    meeting_id: UUID, output: StructuredMeetingOutput
) -> list[ActionItem]:
    """Project structured actions into the editable application model."""
    result: list[ActionItem] = []
    for item in output.action_items[:10]:
        description = item.description.strip()
        if not description:
            continue
        result.append(
            ActionItem(
                id=uuid4(),
                meeting_id=meeting_id,
                owner=item.owner_name,
                owner_email=item.owner_email,
                owner_confidence=item.owner_confidence,
                owner_source=item.owner_source,
                description=description,
                action_type=item.action_type,
                deadline=item.due_date,
                assigned_to=item.assigned_to,
                assigned_to_department=item.assigned_to_department,
                priority=item.priority,
                status=ActionItemStatus.open,
            )
        )
    return result


class OpenAIProvider:
    """Direct OpenAI API provider using strict structured map/reduce output."""

    def __init__(self, api_key: str, model: str = "gpt-4o"):
        self._api_key = api_key
        self._model = model

    async def generate(
        self,
        segments: list[TranscriptSegment],
        *,
        company_context: str | None = None,
        meeting_type: str | None = None,
    ) -> StructuredMeetingOutput:
        if len(_segments_to_labelled_transcript(segments)) < 80:
            return _fallback_output(
                "The recording was too short to produce a meaningful summary. "
                "Ensure system audio is being captured and try a longer recording.",
                TRANSCRIPT_TOO_SHORT_FLAG,
            )

        chunks = _chunk_segments_by_window_ms(segments)
        semaphore = asyncio.Semaphore(MAX_CHUNK_CONCURRENCY)

        async def run_chunk(index: int, chunk: list[TranscriptSegment]) -> _ChunkInsights:
            async with semaphore:
                return await self._extract_chunk_insights(index, len(chunks), chunk)

        chunk_results = await asyncio.gather(
            *(run_chunk(index, chunk) for index, chunk in enumerate(chunks, start=1))
        )
        # IN-383: context enters the consolidated (reduce) generation only —
        # short meetings are a single chunk plus this same reduce call, so one
        # injection point covers both the single-shot and map/reduce shapes
        # without repeating the block per chunk.
        return await self._reduce_chunk_insights(
            chunk_results,
            company_context=company_context,
            meeting_type=meeting_type,
        )

    async def _extract_chunk_insights(
        self, chunk_index: int, total_chunks: int, segments: list[TranscriptSegment]
    ) -> _ChunkInsights:
        payload = {
            "task": "chunk_insights",
            "chunk_index": chunk_index,
            "total_chunks": total_chunks,
            "time_range": {
                "start_ms": min(segment.start_ms for segment in segments),
                "end_ms": max(segment.end_ms for segment in segments),
            },
            "transcript": _segments_to_labelled_transcript(segments),
        }
        raw = await self._complete_json(
            _CHUNK_SYSTEM_PROMPT,
            payload,
            max_tokens=1600,
            schema_name="meeting_chunk_insights",
            response_model=_ChunkInsights,
        )
        return _ChunkInsights.model_validate(raw)

    async def _reduce_chunk_insights(
        self,
        chunk_results: list[_ChunkInsights],
        *,
        company_context: str | None = None,
        meeting_type: str | None = None,
    ) -> StructuredMeetingOutput:
        payload = {
            "task": "reduce_insights",
            "today": date.today().isoformat(),
            # IN-390: classification rides in the payload (not the prompt
            # string) so transcript content can never impersonate it.
            "meeting_type": meeting_type or "internal",
            "chunks": [chunk.model_dump(mode="json") for chunk in chunk_results],
        }
        system_prompt = _REDUCE_SYSTEM_PROMPT
        if company_context:
            system_prompt += build_company_context_block(company_context)
        raw = await self._complete_json(
            system_prompt,
            payload,
            max_tokens=2200,
            schema_name="structured_meeting_output",
            response_model=StructuredMeetingOutput,
        )
        return StructuredMeetingOutput.model_validate(raw)

    async def _complete_json(
        self,
        system_prompt: str,
        user_payload: dict,
        *,
        max_tokens: int,
        schema_name: str,
        response_model: type[BaseModel],
    ) -> dict:
        def request_json() -> dict:
            payload = {
                "model": self._model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
                ],
                "temperature": 0.2,
                "max_tokens": max_tokens,
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {
                        "name": schema_name,
                        "strict": True,
                        "schema": response_model.model_json_schema(),
                    },
                },
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

    async def generate(
        self,
        segments: list[TranscriptSegment],
        *,
        company_context: str | None = None,
        meeting_type: str | None = None,
    ) -> StructuredMeetingOutput:
        raise NotImplementedError("Azure OpenAI wiring requires a provisioned deployment")


def get_llm_provider() -> SummaryProvider:
    settings = get_settings()
    if settings.openai_endpoint and settings.openai_deployment:
        return AzureOpenAIProvider()
    if settings.openai_api_key:
        return OpenAIProvider(settings.openai_api_key)
    return StubLLMProvider()
