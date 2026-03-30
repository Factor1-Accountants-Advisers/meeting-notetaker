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
        className="inline-flex h-11 items-center rounded-2xl border border-[color:var(--border-strong)] bg-[color:var(--surface-elevated)] px-4 text-sm font-medium text-[color:var(--text-primary)] shadow-[var(--shadow-soft)] transition hover:bg-[color:var(--surface-soft)]"
      >
        Export
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-2 w-52 overflow-hidden rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] shadow-[var(--shadow-panel)]">
          <button
            onClick={() => { navigator.clipboard.writeText(text); setOpen(false); }}
            className="w-full px-4 py-3 text-left text-sm text-[color:var(--text-primary)] transition hover:bg-[color:var(--surface-soft)]"
          >
            Copy to clipboard
          </button>
          <button
            onClick={() => { downloadFile(text, `${slug}.txt`); setOpen(false); }}
            className="w-full px-4 py-3 text-left text-sm text-[color:var(--text-primary)] transition hover:bg-[color:var(--surface-soft)]"
          >
            Download as .txt
          </button>
          <button
            onClick={() => { downloadFile(text, `${slug}.md`); setOpen(false); }}
            className="w-full px-4 py-3 text-left text-sm text-[color:var(--text-primary)] transition hover:bg-[color:var(--surface-soft)]"
          >
            Download as .md
          </button>
        </div>
      )}
    </div>
  );
}
