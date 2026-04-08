"use client";

import { ReactNode } from "react";
import { Check } from "lucide-react";
import type { CalendarEvent } from "@/types";

interface DayMeetingListProps {
  meetings: CalendarEvent[];
  selectedMeetingId: string | null;
  onSelectMeeting: (meeting: CalendarEvent) => void;
  dateLabel: string;
  contentKey?: string;
  expandedMeetingId?: string | null;
  renderExpandedContent?: (meeting: CalendarEvent) => ReactNode;
}

const ACCENT_COLORS = [
  "border-blue-500",
  "border-purple-500",
  "border-emerald-500",
  "border-amber-500",
  "border-rose-500",
];

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
}

function InlineReveal({
  isOpen,
  children,
}: {
  isOpen: boolean;
  children: ReactNode;
}) {
  // CSS grid 0fr/1fr approach — no JS height measurement, fully GPU-compositable
  return (
    <div
      className="grid transition-[grid-template-rows,opacity] duration-250 ease-[cubic-bezier(0.22,1,0.36,1)]"
      style={{ gridTemplateRows: isOpen ? "1fr" : "0fr" , opacity: isOpen ? 1 : 0 }}
    >
      <div className="overflow-hidden">
        <div className={`px-1 pb-1 ${isOpen ? "mt-3" : ""}`}>
          {children}
        </div>
      </div>
    </div>
  );
}

export default function DayMeetingList({
  meetings,
  selectedMeetingId,
  onSelectMeeting,
  dateLabel,
  contentKey,
  expandedMeetingId,
  renderExpandedContent,
}: DayMeetingListProps) {
  return (
    <div className="mt-4">
      <div
        key={contentKey ?? dateLabel}
        className="animate-[panelMorph_220ms_cubic-bezier(0.22,1,0.36,1)]"
      >
        <p className="mb-3 text-sm text-[color:var(--text-secondary)]">{dateLabel}</p>

        {meetings.length === 0 ? (
          <p className="text-sm italic text-[color:var(--text-muted)]">No meetings scheduled</p>
        ) : (
          <div className="space-y-2">
            {meetings.map((meeting, i) => {
              const isSelected = meeting.id === selectedMeetingId;
              const isExpanded = meeting.id === expandedMeetingId;
              const accent = ACCENT_COLORS[i % ACCENT_COLORS.length];

              return (
                <div key={meeting.id}>
                  <button
                    onClick={() => onSelectMeeting(meeting)}
                    className={`w-full border-l-4 p-4 text-left transition-[background-color,border-color,box-shadow] duration-200 ease-out ${accent} ${
                      isSelected
                        ? `border border-[color:var(--border-strong)] bg-[color:var(--surface-elevated)] shadow-[var(--shadow-soft)] ${
                            isExpanded ? "rounded-t-lg rounded-b-md" : "rounded-lg"
                          }`
                        : "rounded-[22px] border border-[color:var(--border-subtle)] bg-[color:var(--surface)] hover:border-[color:var(--border-strong)] hover:bg-[color:var(--surface-elevated)]"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="truncate text-sm font-medium text-[color:var(--text-primary)]">
                        {meeting.subject}
                      </span>
                      {isSelected ? (
                        <Check className="h-4 w-4 flex-shrink-0 text-[color:var(--accent-text)]" />
                      ) : (
                        <span className="flex-shrink-0 rounded-full bg-[color:var(--surface-soft)] px-2 py-0.5 text-[10px] text-[color:var(--text-muted)]">
                          Select
                        </span>
                      )}
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-xs text-[color:var(--text-secondary)]">
                      <span>
                        {formatTime(meeting.start)} – {formatTime(meeting.end)}
                      </span>
                      <span>·</span>
                      <span>{formatDuration(meeting.start, meeting.end)}</span>
                    </div>
                  </button>

                  {renderExpandedContent && (
                    <InlineReveal isOpen={isExpanded}>
                      <div className="rounded-b-[24px] rounded-t-[14px] border border-[color:var(--border-strong)] bg-[color:var(--surface)] p-1 shadow-[var(--shadow-soft)]">
                        {renderExpandedContent(meeting)}
                      </div>
                    </InlineReveal>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
