import type { SpeakerMapping, TranscriptSegment } from "@/types";

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

  return [...segments]
    .map((segment) => ({
      text: segment.text.trim(),
      start: segment.start,
    }))
    .filter((quote) => quote.text.length > 0)
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, max);
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
