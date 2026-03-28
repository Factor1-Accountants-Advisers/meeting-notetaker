"use client";

import { Check } from "lucide-react";
import type { CalendarEvent } from "@/types";

interface DayMeetingListProps {
  meetings: CalendarEvent[];
  selectedMeetingId: string | null;
  onSelectMeeting: (meeting: CalendarEvent) => void;
  dateLabel: string;
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

export default function DayMeetingList({
  meetings,
  selectedMeetingId,
  onSelectMeeting,
  dateLabel,
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
            const accent = ACCENT_COLORS[i % ACCENT_COLORS.length];

            return (
              <button
                key={meeting.id}
                onClick={() => onSelectMeeting(meeting)}
                className={`w-full text-left p-3 rounded-lg border-l-4 ${accent} transition-all ${
                  isSelected
                    ? "bg-blue-600/10 ring-1 ring-blue-500/30"
                    : "bg-gray-800/40 hover:bg-gray-800/70"
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
            );
          })}
        </div>
      )}
    </div>
  );
}
