"use client";

import { useMemo } from "react";
import { RefreshCw } from "lucide-react";
import type { CalendarEvent } from "@/types";

interface DayStripProps {
  meetings: CalendarEvent[];
  selectedDate: string;
  onSelectDate: (date: string) => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onRefresh?: () => void;
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function getDayLabel(d: Date, today: Date): string {
  if (toDateKey(d) === toDateKey(today)) return "Today";
  return d.toLocaleDateString("en-US", { weekday: "short" });
}

function isWeekend(d: Date): boolean {
  const day = d.getDay();
  return day === 0 || day === 6;
}

export default function DayStrip({
  meetings,
  selectedDate,
  onSelectDate,
  loading,
  error,
  onRetry,
  onRefresh,
}: DayStripProps) {
  const today = useMemo(() => new Date(), []);

  const days = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, [today]);

  const meetingCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const m of meetings) {
      const key = new Date(m.start).toISOString().slice(0, 10);
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }, [meetings]);

  if (error) {
    return (
      <div className="text-center py-6">
        <p className="mb-2 text-sm text-[color:var(--danger)]">Could not load calendar</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="text-sm text-[color:var(--accent-text)] hover:opacity-80"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--text-muted)]">
          Upcoming Meetings
        </h2>
        {onRefresh && (
          <button
            onClick={onRefresh}
            className="flex items-center gap-1 text-xs text-[color:var(--accent-text)] hover:opacity-80"
          >
            <RefreshCw className="w-3 h-3" />
            Refresh
          </button>
        )}
      </div>

      <div className="flex gap-2">
        {loading
          ? Array.from({ length: 7 }, (_, i) => (
              <div
                key={i}
                className="h-16 w-14 animate-pulse rounded-2xl bg-[color:var(--surface-soft)]"
              />
            ))
          : days.map((d) => {
              const key = toDateKey(d);
              const isSelected = key === selectedDate;
              const isToday = toDateKey(d) === toDateKey(today);
              const count = meetingCounts[key] || 0;
              const weekend = isWeekend(d);

              return (
                <button
                  key={key}
                  onClick={() => onSelectDate(key)}
                  className={`flex h-16 w-14 flex-col items-center justify-center gap-0.5 rounded-2xl border text-xs transition-all ${
                    isSelected
                      ? "border-[color:var(--border-strong)] bg-[color:var(--surface-inverse)] text-[color:var(--text-inverse)] shadow-[var(--shadow-soft)]"
                      : isToday
                        ? "border-[color:var(--border-strong)] bg-[color:var(--accent-soft)] text-[color:var(--accent-text)]"
                        : "border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] text-[color:var(--text-primary)] hover:border-[color:var(--border-strong)]"
                  } ${weekend && !isSelected && !isToday ? "opacity-60" : ""}`}
                >
                  <span className="text-[10px] font-medium uppercase">
                    {getDayLabel(d, today)}
                  </span>
                  <span className="text-lg font-bold">{d.getDate()}</span>
                  {count > 0 && (
                    <div className="flex gap-0.5">
                      {Array.from({ length: Math.min(count, 3) }, (_, i) => (
                        <div
                          key={i}
                          className={`w-1 h-1 rounded-full ${
                            isSelected
                              ? "bg-[color:var(--text-inverse)]/70"
                              : "bg-[color:var(--accent)]"
                          }`}
                        />
                      ))}
                    </div>
                  )}
                </button>
              );
            })}
      </div>
    </div>
  );
}
