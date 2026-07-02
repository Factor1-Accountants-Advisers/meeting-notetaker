import unittest
from datetime import date
from uuid import uuid4

from app.schemas import Priority, TranscriptSegment
from app.services.llm import OpenAIProvider, _chunk_segments_by_window_ms, _segments_to_labelled_transcript


def seg(index: int, start_min: int, end_min: int | None = None) -> TranscriptSegment:
    end = end_min if end_min is not None else start_min + 1
    return TranscriptSegment(
        speaker="Joseph Guerrero" if index % 2 == 0 else "Benjamin Bryant",
        speaker_known=True,
        start_ms=start_min * 60_000,
        end_ms=end * 60_000,
        text=f"Segment {index} decision and action detail.",
        raw_speaker=f"SPEAKER_{index % 2:02d}",
    )


class FakeChunkedOpenAIProvider(OpenAIProvider):
    def __init__(self):
        super().__init__("test-key")
        self.calls: list[dict] = []

    async def _complete_json(self, system_prompt: str, user_payload: dict, *, max_tokens: int) -> dict:
        self.calls.append({"system": system_prompt, "payload": user_payload, "max_tokens": max_tokens})
        if user_payload["task"] == "chunk_insights":
            return {
                "summary_bullets": [f"chunk {user_payload['chunk_index']} summary"],
                "decisions": [f"chunk {user_payload['chunk_index']} decision"],
                "risks": [],
                "questions": [],
                "action_items": [
                    {
                        "description": f"Action from chunk {user_payload['chunk_index']}",
                        "owner": "Joseph Guerrero",
                        "deadline": None,
                        "priority": "high",
                    }
                ],
            }
        return {
            "summary": "Consolidated summary across chunks.",
            "action_items": [
                {
                    "description": "Consolidated action",
                    "owner": "Joseph Guerrero",
                    "deadline": date.today().isoformat(),
                    "priority": "medium",
                }
            ],
        }


class LongMeetingChunkingTests(unittest.IsolatedAsyncioTestCase):
    def test_chunk_segments_by_time_window_preserves_order_and_boundaries(self):
        segments = [seg(i, i * 5, i * 5 + 2) for i in range(8)]

        chunks = _chunk_segments_by_window_ms(segments, window_ms=15 * 60_000)

        self.assertEqual(len(chunks), 3)
        self.assertEqual([s.text for s in chunks[0]], [segments[0].text, segments[1].text, segments[2].text])
        self.assertEqual([s.text for s in chunks[1]], [segments[3].text, segments[4].text, segments[5].text])
        self.assertEqual([s.text for s in chunks[2]], [segments[6].text, segments[7].text])

    def test_labelled_transcript_includes_timestamps_and_speaker_labels(self):
        transcript = _segments_to_labelled_transcript([seg(1, 12, 14)])

        self.assertIn("[00:12:00-00:14:00] Benjamin Bryant", transcript)
        self.assertIn("Segment 1 decision and action detail.", transcript)

    async def test_long_meeting_uses_chunk_calls_then_reduce_for_summary_and_actions(self):
        provider = FakeChunkedOpenAIProvider()
        meeting_id = uuid4()
        segments = [seg(i, i * 10, i * 10 + 4) for i in range(10)]

        summary = await provider.summarize(segments)
        actions = await provider.extract_action_items(meeting_id, segments)

        chunk_calls = [c for c in provider.calls if c["payload"]["task"] == "chunk_insights"]
        reduce_calls = [c for c in provider.calls if c["payload"]["task"] == "reduce_insights"]
        self.assertGreaterEqual(len(chunk_calls), 4)
        self.assertEqual(len(reduce_calls), 1)
        self.assertEqual(summary, "Consolidated summary across chunks.")
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0].meeting_id, meeting_id)
        self.assertEqual(actions[0].priority, Priority.medium)
        self.assertEqual(actions[0].owner, "Joseph Guerrero")


if __name__ == "__main__":
    unittest.main()
