"use client";

import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  const [shouldRender, setShouldRender] = useState(isOpen);
  const [isVisible, setIsVisible] = useState(isOpen);
  const [height, setHeight] = useState(isOpen ? "auto" : "0px");
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!shouldRender || !contentRef.current) return;

    const nextHeight = `${contentRef.current.scrollHeight}px`;
    setHeight(nextHeight);
  }, [children, shouldRender]);

  useEffect(() => {
    let timeoutId: number | undefined;
    let frameId: number | undefined;

    if (isOpen) {
      setShouldRender(true);
      frameId = window.requestAnimationFrame(() => {
        if (contentRef.current) {
          setHeight(`${contentRef.current.scrollHeight}px`);
        }
        setIsVisible(true);
      });
    } else if (shouldRender) {
      if (contentRef.current) {
        setHeight(`${contentRef.current.scrollHeight}px`);
      }
      frameId = window.requestAnimationFrame(() => {
        setHeight("0px");
        setIsVisible(false);
      });
      timeoutId = window.setTimeout(() => {
        setShouldRender(false);
      }, 320);
    }

    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [isOpen, shouldRender]);

  if (!shouldRender) return null;

  return (
    <div
      className={`overflow-hidden transition-[max-height,opacity,transform,margin] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
        isVisible
          ? "mt-3 translate-y-0 opacity-100"
          : "mt-1 -translate-y-2 opacity-0"
      }`}
      style={{ maxHeight: height }}
    >
      <div ref={contentRef} className="px-1 pb-1">
        {children}
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
                    className={`w-full border-l-4 p-4 text-left transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${accent} ${
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
