import type { TranscriptSegment } from "@/types";

export type TranscriptDisplayOptions = {
  maxCharacters?: number;
};

const DEFAULT_DISPLAY_CHUNK_CHARACTERS = 520;
const SENTENCE_PATTERN = /[^.!?]+(?:[.!?]+|$)/g;

function splitIntoSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }

  const sentences = normalized.match(SENTENCE_PATTERN)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
  return sentences.length > 0 ? sentences : [normalized];
}

function splitLongSentence(sentence: string, maxCharacters: number): string[] {
  if (sentence.length <= maxCharacters) {
    return [sentence];
  }

  const words = sentence.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharacters) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (word.length > maxCharacters) {
      for (let index = 0; index < word.length; index += maxCharacters) {
        chunks.push(word.slice(index, index + maxCharacters));
      }
    } else {
      current = word;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

export function splitTextIntoEvidenceSnippets(text: string, maxCharacters: number): string[] {
  const safeMax = Math.max(80, maxCharacters);
  return splitIntoSentences(text).flatMap((sentence) => splitLongSentence(sentence, safeMax));
}

export function splitTextIntoReadableChunks(text: string, maxCharacters: number): string[] {
  const safeMax = Math.max(80, maxCharacters);
  const sentences = splitTextIntoEvidenceSnippets(text, safeMax);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length <= safeMax) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
    }
    current = sentence;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function estimateChunkStart(segment: TranscriptSegment, chunkIndex: number, chunkCount: number): number {
  if (chunkIndex === 0 || chunkCount <= 1) {
    return segment.start;
  }

  const duration = Math.max(0, segment.end - segment.start);
  if (duration === 0) {
    return segment.start;
  }

  return segment.start + (duration * chunkIndex) / chunkCount;
}

export function splitTranscriptSegmentsForDisplay(
  segments: TranscriptSegment[],
  options: TranscriptDisplayOptions = {}
): TranscriptSegment[] {
  const maxCharacters = options.maxCharacters ?? DEFAULT_DISPLAY_CHUNK_CHARACTERS;

  return segments.flatMap((segment) => {
    const text = segment.text.replace(/\s+/g, " ").trim();
    if (!text || text.length <= maxCharacters) {
      return [{ ...segment, text }];
    }

    const textChunks = splitTextIntoReadableChunks(text, maxCharacters);
    if (textChunks.length <= 1) {
      return [{ ...segment, text }];
    }

    return textChunks.map((chunkText, chunkIndex) => ({
      ...segment,
      start: estimateChunkStart(segment, chunkIndex, textChunks.length),
      text: chunkText,
    }));
  });
}
