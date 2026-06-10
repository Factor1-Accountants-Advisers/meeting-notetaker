from uuid import UUID

from fastapi import APIRouter, Query
from pydantic import BaseModel

from app import store

router = APIRouter(prefix="/search", tags=["search"])


class SearchResult(BaseModel):
    meeting_id: UUID
    meeting_title: str
    kind: str  # "meeting" | "summary" | "transcript" | "action_item"
    snippet: str


def _snippet(text: str, needle: str, radius: int = 45) -> str:
    idx = text.lower().find(needle)
    start = max(0, idx - radius)
    end = min(len(text), idx + len(needle) + radius)
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(text) else ""
    return f"{prefix}{text[start:end].strip()}{suffix}"


@router.get("", response_model=list[SearchResult])
async def search(q: str = Query(min_length=2, max_length=100)) -> list[SearchResult]:
    """Global search across titles, summaries, transcripts, and action items.

    Linear scan over the in-memory store; becomes a Postgres full-text query
    with the database work.
    """
    needle = q.lower()
    results: list[SearchResult] = []

    for m in store.MEETINGS.values():
        if needle in m.title.lower() or needle in m.context.lower():
            results.append(
                SearchResult(
                    meeting_id=m.id, meeting_title=m.title, kind="meeting", snippet=m.context
                )
            )

    for mid, summary in store.SUMMARIES.items():
        meeting = store.MEETINGS.get(mid)
        if meeting and needle in summary.lower():
            results.append(
                SearchResult(
                    meeting_id=mid,
                    meeting_title=meeting.title,
                    kind="summary",
                    snippet=_snippet(summary, needle),
                )
            )

    for mid, segments in store.TRANSCRIPTS.items():
        meeting = store.MEETINGS.get(mid)
        if meeting is None:
            continue
        for seg in segments:
            if needle in seg.text.lower():
                results.append(
                    SearchResult(
                        meeting_id=mid,
                        meeting_title=meeting.title,
                        kind="transcript",
                        snippet=f"{seg.speaker}: {_snippet(seg.text, needle)}",
                    )
                )
                break  # one hit per meeting transcript is enough for the dropdown

    for item in store.ACTION_ITEMS.values():
        if needle in item.description.lower():
            meeting = store.MEETINGS.get(item.meeting_id)
            results.append(
                SearchResult(
                    meeting_id=item.meeting_id,
                    meeting_title=meeting.title if meeting else "",
                    kind="action_item",
                    snippet=item.description,
                )
            )

    return results[:12]
