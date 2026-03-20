"use client";

import type { TranscriptSegment } from "@/types";

const speakerColors = [
  "text-blue-700",
  "text-green-700",
  "text-purple-700",
  "text-orange-700",
  "text-pink-700",
  "text-teal-700",
];

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface TranscriptViewProps {
  segments: TranscriptSegment[];
  onSeek?: (seconds: number) => void;
}

export default function TranscriptView({ segments, onSeek }: TranscriptViewProps) {
  if (segments.length === 0) {
    return <p className="text-gray-500">No transcript available.</p>;
  }

  const speakers = Array.from(new Set(segments.map((s) => s.speaker)));
  const colorMap = Object.fromEntries(
    speakers.map((name, i) => [name, speakerColors[i % speakerColors.length]])
  );

  return (
    <div className="space-y-4">
      {segments.map((seg, i) => (
        <div key={i} className="flex gap-3">
          <button
            onClick={() => onSeek?.(seg.start)}
            className="text-xs text-gray-400 hover:text-blue-600 font-mono shrink-0 pt-0.5"
            title="Jump to this point"
          >
            {formatTimestamp(seg.start)}
          </button>
          <div>
            <span className={`font-semibold text-sm ${colorMap[seg.speaker]}`}>
              {seg.speaker}
            </span>
            <p className="text-sm text-gray-800 mt-0.5">{seg.text}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
