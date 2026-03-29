"use client";

import { ReactNode, useEffect, useState } from "react";
import { Check } from "lucide-react";
import type { CalendarEvent } from "@/types";

interface DayMeetingListProps {
  meetings: CalendarEvent[];
  selectedMeetingId: string | null;
  onSelectMeeting: (meeting: CalendarEvent) => void;
  dateLabel: string;
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
  const [shouldRender, setShouldRender] = useState(isOpen);
  const [isVisible, setIsVisible] = useState(isOpen);

  useEffect(() => {
    let timeoutId: number | undefined;
    let frameId: number | undefined;

    if (isOpen) {
      setShouldRender(true);
      frameId = window.requestAnimationFrame(() => {
        setIsVisible(true);
      });
    } else if (shouldRender) {
      setIsVisible(false);
      timeoutId = window.setTimeout(() => {
        setShouldRender(false);
      }, 240);
    }

    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [isOpen, shouldRender]);

  if (!shouldRender) return null;

  return (
    <div
      className={`grid transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
        isVisible
          ? "mt-3 grid-rows-[1fr] translate-y-0 opacity-100"
          : "mt-1 grid-rows-[0fr] -translate-y-2 opacity-0"
      }`}
    >
      <div className="overflow-hidden">
        <div className="px-1 pb-1">{children}</div>
      </div>
    </div>
  );
}

export default function DayMeetingList({
  meetings,
  selectedMeetingId,
  onSelectMeeting,
  dateLabel,
  expandedMeetingId,
  renderExpandedContent,
}: DayMeetingListProps) {
  return (
    <div className="mt-4">
      <p className="text-xs text-gray-500 font-medium mb-3">{dateLabel}</p>

      {meetings.length === 0 ? (
        <p className="text-sm text-gray-600 italic">No meetings scheduled</p>
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
                  className={`w-full text-left border-l-4 p-3 transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${accent} ${
                    isSelected
                      ? `bg-blue-600/10 ring-1 ring-blue-500/30 shadow-[0_10px_30px_rgba(37,99,235,0.12)] ${
                          isExpanded ? "rounded-t-lg rounded-b-md" : "rounded-lg"
                        }`
                      : "rounded-lg bg-gray-800/40 hover:bg-gray-800/70"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-200 truncate">
                      {meeting.subject}
                    </span>
                    {isSelected ? (
                      <Check className="w-4 h-4 text-blue-400 flex-shrink-0" />
                    ) : (
                      <span className="text-[10px] text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full flex-shrink-0">
                        Select
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-1 text-xs text-gray-500">
                    <span>
                      {formatTime(meeting.start)} – {formatTime(meeting.end)}
                    </span>
                    <span>·</span>
                    <span>{formatDuration(meeting.start, meeting.end)}</span>
                  </div>
                </button>

                {renderExpandedContent && (
                  <InlineReveal isOpen={isExpanded}>
                    <div className="rounded-b-xl rounded-t-md border border-blue-500/20 bg-gradient-to-b from-blue-500/8 to-transparent p-1 shadow-[0_18px_40px_rgba(10,20,40,0.28)]">
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
  );
}
