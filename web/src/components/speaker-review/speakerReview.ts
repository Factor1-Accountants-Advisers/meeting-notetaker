import type { SpeakerMapping, TranscriptSegment } from "@/types";
import { splitTextIntoEvidenceSnippets } from "@/lib/transcript-display";

export type SpeakerReviewGroup = {
  speakerLabel: string;
  mapping: SpeakerMapping | null;
  quotes: RepresentativeQuote[];
};

export type RepresentativeQuote = {
  text: string;
  start: number;
};

function resolveSpeakerLabel(segment: TranscriptSegment): string {
  const rawLabel = segment.raw_speaker?.trim();
  const displayLabel = segment.speaker.trim();

  return rawLabel || displayLabel || "Unknown speaker";
}

export function getRepresentativeQuotes(segments: TranscriptSegment[], max = 3): RepresentativeQuote[] {
  if (max <= 0) {
    return [];
  }

  const quoteCandidates = segments.flatMap((segment) => {
    const text = segment.text.trim();
    if (!text) {
      return [];
    }

    return splitTextIntoEvidenceSnippets(text, 220).map((chunk, index, chunks) => ({
      text: chunk,
      start: chunks.length > 1
        ? segment.start + (Math.max(0, segment.end - segment.start) * index) / chunks.length
        : segment.start,
    }));
  });

  const sortedQuotes = segments.length === 1
    ? quoteCandidates.sort((a, b) => a.start - b.start)
    : quoteCandidates.sort((a, b) => b.text.length - a.text.length || a.start - b.start);

  return sortedQuotes.slice(0, max).map(({ text, start }) => ({ text, start }));
}

export function groupSegmentsForReview(
  segments: TranscriptSegment[],
  mappings: SpeakerMapping[]
): SpeakerReviewGroup[] {
  const mappingByLabel = new Map(
    mappings.map((mapping) => [mapping.speaker_label.trim(), mapping] as const)
  );
  const grouped = new Map<string, TranscriptSegment[]>();

  for (const segment of segments) {
    const label = resolveSpeakerLabel(segment);
    grouped.set(label, [...(grouped.get(label) ?? []), segment]);
  }

  const reviewGroups: SpeakerReviewGroup[] = [];
  grouped.forEach((speakerSegments, speakerLabel) => {
    reviewGroups.push({
      speakerLabel,
      mapping: mappingByLabel.get(speakerLabel) ?? null,
      quotes: getRepresentativeQuotes(speakerSegments),
    });
  });

  return reviewGroups;
}
