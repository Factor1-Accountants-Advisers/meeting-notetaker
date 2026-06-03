import { describe, expect, it } from "vitest";

import type { TranscriptSegment } from "@/types";
import { splitTranscriptSegmentsForDisplay } from "@/lib/transcript-display";

function makeSegment(overrides: Partial<TranscriptSegment>): TranscriptSegment {
  return {
    speaker: "Speaker 1",
    raw_speaker: "SPEAKER_00",
    start: 10,
    end: 70,
    text: "Short transcript segment.",
    ...overrides,
  };
}

describe("splitTranscriptSegmentsForDisplay", () => {
  it("leaves normal transcript segments unchanged", () => {
    const segment = makeSegment({ text: "A short readable segment.", start: 3, end: 8 });

    expect(splitTranscriptSegmentsForDisplay([segment])).toEqual([segment]);
  });

  it("splits one very long provider segment into readable display chunks", () => {
    const longSegment = makeSegment({
      start: 20,
      end: 200,
      text:
        "First sentence explains the setup. Second sentence has more useful context for the listener. Third sentence continues the same speaker turn with a clear idea. Fourth sentence should move into another display card. Fifth sentence closes the point for review.",
    });

    const chunks = splitTranscriptSegmentsForDisplay([longSegment], { maxCharacters: 115 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.speaker)).toEqual(chunks.map(() => "Speaker 1"));
    expect(chunks[0].text).toBe("First sentence explains the setup. Second sentence has more useful context for the listener.");
    expect(chunks.some((chunk) => chunk.text.includes("Fourth sentence should move into another display card."))).toBe(true);
    expect(chunks.every((chunk) => chunk.text.length <= 115)).toBe(true);
    expect(chunks[0].start).toBe(20);
    expect(chunks[1].start).toBeGreaterThan(chunks[0].start);
  });
});
