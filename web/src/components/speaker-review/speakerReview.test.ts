import { describe, expect, it } from "vitest";

import type { SpeakerMapping, TranscriptSegment } from "@/types";
import { getRepresentativeQuotes, groupSegmentsForReview } from "@/components/speaker-review/speakerReview";

function makeSegment(overrides: Partial<TranscriptSegment>): TranscriptSegment {
  return {
    speaker: "Speaker 1",
    raw_speaker: "SPEAKER_00",
    start: 0,
    end: 1,
    text: "Hello from the transcript.",
    ...overrides,
  };
}

function makeMapping(overrides: Partial<SpeakerMapping>): SpeakerMapping {
  return {
    id: 1,
    meeting_id: 10,
    speaker_label: "SPEAKER_00",
    display_name: "Alex Rivera",
    email: "alex@example.com",
    confidence: 0.82,
    source: "llm_inference",
    reason: "Matched by introduction",
    created_at: "2026-05-29T00:00:00.000Z",
    updated_at: "2026-05-29T00:00:00.000Z",
    ...overrides,
  };
}

describe("getRepresentativeQuotes", () => {
  it("selects up to 3 representative quotes", () => {
    const segments = [
      makeSegment({ start: 1, text: "one" }),
      makeSegment({ start: 2, text: "two two" }),
      makeSegment({ start: 3, text: "three three three" }),
      makeSegment({ start: 4, text: "four four four four" }),
    ];

    expect(getRepresentativeQuotes(segments)).toEqual([
      { start: 4, text: "four four four four" },
      { start: 3, text: "three three three" },
      { start: 2, text: "two two" },
    ]);
  });

  it("prefers longer non-empty quotes", () => {
    const segments = [
      makeSegment({ text: "short" }),
      makeSegment({ text: "   " }),
      makeSegment({ text: "a much longer representative quote" }),
      makeSegment({ text: "medium quote" }),
    ];

    expect(getRepresentativeQuotes(segments, 2)).toEqual([
      { start: 0, text: "a much longer representative quote" },
      { start: 0, text: "medium quote" },
    ]);
  });
});

describe("groupSegmentsForReview", () => {
  it("groups segments by raw speaker label", () => {
    const segments = [
      makeSegment({ speaker: "Alex Rivera", raw_speaker: "SPEAKER_00", text: "Opening project status update" }),
      makeSegment({ speaker: "Jordan Kim", raw_speaker: "SPEAKER_01", text: "Budget approval discussion" }),
      makeSegment({ speaker: "Alex Rivera", raw_speaker: "SPEAKER_00", text: "Follow-up owners and deadlines" }),
    ];

    const groups = groupSegmentsForReview(segments, []);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.speakerLabel)).toEqual(["SPEAKER_00", "SPEAKER_01"]);
    expect(groups[0].quotes).toEqual([
      { start: 0, text: "Follow-up owners and deadlines" },
      { start: 0, text: "Opening project status update" },
    ]);
    expect(groups[1].quotes).toEqual([{ start: 0, text: "Budget approval discussion" }]);
  });

  it("resolves current mapping display", () => {
    const segments = [
      makeSegment({ speaker: "Speaker A", raw_speaker: "SPEAKER_00", text: "We need to validate the rollout plan" }),
      makeSegment({ speaker: "Speaker B", raw_speaker: "SPEAKER_01", text: "I can own the dashboard updates" }),
    ];
    const alexMapping = makeMapping({ speaker_label: "SPEAKER_00", display_name: "Alex Rivera", email: "alex@example.com" });

    const groups = groupSegmentsForReview(segments, [alexMapping]);

    expect(groups[0]).toMatchObject({
      speakerLabel: "SPEAKER_00",
      mapping: alexMapping,
      quotes: [{ start: 0, text: "We need to validate the rollout plan" }],
    });
    expect(groups[1]).toMatchObject({
      speakerLabel: "SPEAKER_01",
      mapping: null,
      quotes: [{ start: 0, text: "I can own the dashboard updates" }],
    });
  });
});
