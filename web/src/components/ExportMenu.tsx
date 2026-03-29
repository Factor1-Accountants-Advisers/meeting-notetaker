"use client";

import { useState, useRef, useEffect } from "react";
import type { TranscriptSegment, SummaryResponse } from "@/types";

interface ExportMenuProps {
  meetingTitle: string;
  segments: TranscriptSegment[] | null;
  summary: SummaryResponse | null;
}

function buildPlainText(title: string, segments: TranscriptSegment[] | null, summary: SummaryResponse | null): string {
  const lines: string[] = [`# ${title}`, ""];

  if (summary?.summary_text) {
    lines.push("## Summary", summary.summary_text, "");
    if (summary.key_points.length > 0) {
      lines.push("## Key Points");
      summary.key_points.forEach((p) => lines.push(`- ${p}`));
      lines.push("");
    }
    if (summary.follow_ups.length > 0) {
      lines.push("## Follow-ups");
      summary.follow_ups.forEach((f) => lines.push(`- ${f}`));
      lines.push("");
    }
  }

  if (segments && segments.length > 0) {
    lines.push("## Transcript", "");
    segments.forEach((seg) => {
      const start = formatTimestamp(seg.start);
      lines.push(`[${start}] ${seg.speaker}: ${seg.text}`);
    });
  }

  return lines.join("\n");
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function downloadFile(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ExportMenu({ meetingTitle, segments, summary }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const text = buildPlainText(meetingTitle, segments, summary);
  const slug = meetingTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="px-3 py-1.5 border border-gray-700 rounded-md text-sm text-gray-300 hover:bg-gray-800 transition-colors"
      >
        Export
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-48 bg-gray-800 border border-gray-700 rounded-md shadow-lg z-10">
          <button
            onClick={() => { navigator.clipboard.writeText(text); setOpen(false); }}
            className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-gray-700"
          >
            Copy to clipboard
          </button>
          <button
            onClick={() => { downloadFile(text, `${slug}.txt`); setOpen(false); }}
            className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-gray-700"
          >
            Download as .txt
          </button>
          <button
            onClick={() => { downloadFile(text, `${slug}.md`); setOpen(false); }}
            className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-gray-700"
          >
            Download as .md
          </button>
        </div>
      )}
    </div>
  );
}
