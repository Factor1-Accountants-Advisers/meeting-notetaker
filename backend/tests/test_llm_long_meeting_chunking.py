import unittest
from datetime import date
from uuid import uuid4

from app.schemas import Priority, TranscriptSegment
from app.services.llm import (
    OpenAIProvider,
    _chunk_segments_by_window_ms,
    _segments_to_labelled_transcript,
    action_items_from_output,
    compose_plain_summary,
    render_summary_html,
)


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

    async def _complete_json(
        self,
        system_prompt: str,
        user_payload: dict,
        *,
        max_tokens: int,
        schema_name: str,
        response_model,
    ) -> dict:
        self.calls.append(
            {
                "system": system_prompt,
                "payload": user_payload,
                "max_tokens": max_tokens,
                "schema_name": schema_name,
                "response_model": response_model,
            }
        )
        if user_payload["task"] == "chunk_insights":
            index = user_payload["chunk_index"]
            return {
                "schema_version": "1.0",
                "chunk_index": index,
                "time_range": user_payload["time_range"],
                "summary_bullets": [f"chunk {index} summary"],
                "decisions": [f"chunk {index} decision"],
                "risks": [],
                "questions": [],
                "next_meeting": [],
                "action_items": [
                    {
                        "description": f"Action from chunk {index}",
                        "owner_name": "Joseph Guerrero",
                        "owner_email": None,
                        "owner_confidence": "high",
                        "owner_source": "explicit_speaker",
                        "action_type": None,
                        "due_date": None,
                        "assigned_to": None,
                        "assigned_to_department": None,
                        "priority": "high",
                    }
                ],
                "follow_ups": [],
                "quality_flags": [],
            }
        return {
            "schema_version": "1.0",
            "summary": "Consolidated summary across chunks.",
            "key_points": ["Reviewed rollout timeline"],
            "decisions": ["Proceed with the pilot"],
            "unresolved_questions": ["Who owns the follow-up?"],
            "next_meeting": [],
            "action_items": [
                {
                    "description": "Consolidated action",
                    "owner_name": "Joseph Guerrero",
                    "owner_email": "josephguerrero@factor1.com.au",
                    "owner_confidence": "high",
                    "owner_source": "explicit_speaker",
                    "action_type": "follow_up",
                    "due_date": date.today().isoformat(),
                    "assigned_to": "Joseph Guerrero",
                    "assigned_to_department": "Innovations and Systems",
                    "priority": "medium",
                }
            ],
            "follow_ups": ["Confirm pilot timing"],
            "quality_flags": [],
            "source_chunks": [
                chunk["chunk_index"] for chunk in user_payload["chunks"]
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

    async def test_long_meeting_uses_one_structured_generation_for_summary_and_actions(self):
        provider = FakeChunkedOpenAIProvider()
        meeting_id = uuid4()
        segments = [seg(i, i * 10, i * 10 + 4) for i in range(10)]

        output = await provider.generate(segments)
        summary = compose_plain_summary(output)
        summary_html = render_summary_html(output)
        actions = action_items_from_output(meeting_id, output)

        chunk_calls = [c for c in provider.calls if c["payload"]["task"] == "chunk_insights"]
        reduce_calls = [c for c in provider.calls if c["payload"]["task"] == "reduce_insights"]
        self.assertGreaterEqual(len(chunk_calls), 4)
        self.assertEqual(len(reduce_calls), 1)
        self.assertEqual(output.schema_version, "1.0")
        self.assertEqual(output.follow_ups, ["Confirm pilot timing"])
        # Plain-text summary keeps the overview plus section headers/bullets so the
        # minutes parsers can read decisions and open questions back out.
        self.assertIn("Consolidated summary across chunks.", summary)
        self.assertIn("Decisions", summary)
        self.assertIn("- Proceed with the pilot", summary)
        self.assertIn("Open questions", summary)
        # HTML summary is code-rendered and escaped (never taken from the model).
        self.assertIsNotNone(summary_html)
        self.assertIn("Consolidated summary across chunks.", summary_html)
        self.assertIn("<li", summary_html)
        self.assertIn("Proceed with the pilot", summary_html)
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0].meeting_id, meeting_id)
        self.assertEqual(actions[0].priority, Priority.medium)
        self.assertEqual(actions[0].owner, "Joseph Guerrero")

    async def test_meeting_type_rides_reduce_payload_only(self):
        # IN-390: the Slice 1 classification is applied to generation as a
        # payload field (never prompt-string concatenation), defaulting to
        # internal when the caller passes nothing.
        provider = FakeChunkedOpenAIProvider()
        segments = [seg(i, i * 10, i * 10 + 4) for i in range(10)]

        await provider.generate(segments, meeting_type="client")
        reduce_calls = [
            c for c in provider.calls if c["payload"]["task"] == "reduce_insights"
        ]
        chunk_calls = [
            c for c in provider.calls if c["payload"]["task"] == "chunk_insights"
        ]
        self.assertEqual(reduce_calls[0]["payload"]["meeting_type"], "client")
        self.assertTrue(
            all("meeting_type" not in c["payload"] for c in chunk_calls)
        )

        provider.calls.clear()
        await provider.generate(segments)
        reduce_calls = [
            c for c in provider.calls if c["payload"]["task"] == "reduce_insights"
        ]
        self.assertEqual(reduce_calls[0]["payload"]["meeting_type"], "internal")


if __name__ == "__main__":
    unittest.main()
