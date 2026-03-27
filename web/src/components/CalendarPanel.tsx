"use client";

import { useState, useEffect, useCallback } from "react";
import { getElectronAPIOrNull } from "@/lib/electron-bridge";
import type { CalendarEvent } from "@/types";

interface CalendarPanelProps {
  onSelectMeeting: (event: CalendarEvent) => void;
  selectedMeetingId: string | null;
}

function formatTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function CalendarPanel({ onSelectMeeting, selectedMeetingId }: CalendarPanelProps) {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const api = getElectronAPIOrNull();

  const loadCalendar = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.getCalendar();
      setEvents(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load calendar");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    loadCalendar();
  }, [loadCalendar]);

  if (!api) return null; // Hide in browser

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
          Upcoming
        </h2>
        <button
          onClick={loadCalendar}
          disabled={loading}
          className="text-xs text-blue-600 hover:text-blue-800 disabled:text-gray-400"
        >
          Refresh
        </button>
      </div>

      {loading && <p className="text-sm text-gray-400">Loading calendar...</p>}
      {error && <p className="text-sm text-red-500">{error}</p>}

      {!loading && !error && events.length === 0 && (
        <p className="text-sm text-gray-400">No upcoming meetings</p>
      )}

      <ul className="space-y-1">
        {events.map((evt) => (
          <li key={evt.id}>
            <button
              onClick={() => onSelectMeeting(evt)}
              className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                selectedMeetingId === evt.id
                  ? "bg-blue-50 border border-blue-200 text-blue-900"
                  : "hover:bg-gray-50 text-gray-700"
              }`}
            >
              <p className="font-medium truncate">{evt.subject}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {formatTime(evt.start)} – {formatTime(evt.end)}
                {evt.attendees.length > 0 && ` · ${evt.attendees.length} attendee${evt.attendees.length > 1 ? "s" : ""}`}
              </p>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
