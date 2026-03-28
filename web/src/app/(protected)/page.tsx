"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { Upload, Mic } from "lucide-react";
import { getElectronAPIOrNull } from "@/lib/electron-bridge";
import { useRecordingStatus } from "@/lib/useRecordingStatus";
import MeetingList from "@/components/MeetingList";
import UploadModal from "@/components/UploadModal";
import DayStrip from "@/components/DayStrip";
import DayMeetingList from "@/components/DayMeetingList";
import RecordingPanel from "@/components/RecordingPanel";
import type { CalendarEvent } from "@/types";

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default function DashboardPage() {
  const electron = getElectronAPIOrNull();
  const isElectron = !!electron;
  const { recording } = useRecordingStatus();

  const [showUpload, setShowUpload] = useState(false);
  const [selectedDate, setSelectedDate] = useState(toDateKey(new Date()));
  const [selectedMeeting, setSelectedMeeting] = useState<CalendarEvent | null>(null);
  const [showRecordingPanel, setShowRecordingPanel] = useState(false);

  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [calendarError, setCalendarError] = useState<string | null>(null);

  const fetchCalendar = useCallback(async () => {
    if (!electron) return;
    setCalendarLoading(true);
    setCalendarError(null);
    try {
      const events = await electron.getCalendar();
      setCalendarEvents(events);
    } catch {
      setCalendarError("Could not load calendar");
    } finally {
      setCalendarLoading(false);
    }
  }, [electron]);

  useEffect(() => {
    if (isElectron) fetchCalendar();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dayMeetings = useMemo(
    () =>
      calendarEvents.filter(
        (m) => new Date(m.start).toISOString().slice(0, 10) === selectedDate
      ),
    [calendarEvents, selectedDate]
  );

  const selectedDateLabel = useMemo(() => {
    const d = new Date(selectedDate + "T00:00:00");
    return d.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }, [selectedDate]);

  const handleSelectMeeting = (meeting: CalendarEvent) => {
    setSelectedMeeting(meeting);
    setShowRecordingPanel(true);
  };

  const handleStartAdHoc = () => {
    setSelectedMeeting(null);
    setShowRecordingPanel(true);
  };

  const handleDismissPanel = () => {
    setShowRecordingPanel(false);
    setSelectedMeeting(null);
  };

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">Note Taker</h1>
          <p className="text-sm text-gray-500 mt-0.5">{today}</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowUpload(true)}
            disabled={recording}
            className="px-4 py-2 text-sm font-medium text-gray-300 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded-lg flex items-center gap-2 transition-colors"
          >
            <Upload className="w-4 h-4" />
            Upload
          </button>
          {isElectron && (
            <button
              onClick={handleStartAdHoc}
              disabled={recording}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg flex items-center gap-2 transition-colors"
            >
              <Mic className="w-4 h-4" />
              Start Recording
            </button>
          )}
          {recording && (
            <div className="flex items-center gap-1.5 ml-2">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-xs font-medium text-red-400">Recording</span>
            </div>
          )}
        </div>
      </div>

      {/* Upcoming Meetings — Electron only */}
      {isElectron && (
        <section className={`mb-8 ${recording ? "opacity-50 pointer-events-none" : ""}`}>
          <DayStrip
            meetings={calendarEvents}
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
            loading={calendarLoading}
            error={calendarError}
            onRetry={fetchCalendar}
            onRefresh={fetchCalendar}
          />
          <DayMeetingList
            meetings={dayMeetings}
            selectedMeetingId={selectedMeeting?.id ?? null}
            onSelectMeeting={handleSelectMeeting}
            dateLabel={selectedDateLabel}
          />
        </section>
      )}

      {/* Recording Panel */}
      {showRecordingPanel && isElectron && (
        <section className="mb-8">
          <RecordingPanel
            selectedMeeting={selectedMeeting}
            onDismiss={handleDismissPanel}
          />
        </section>
      )}

      {/* Divider */}
      <hr className="border-gray-800 mb-8" />

      {/* Past Meetings */}
      <section>
        <MeetingList />
      </section>

      {/* Upload Modal */}
      {showUpload && <UploadModal onClose={() => setShowUpload(false)} />}
    </div>
  );
}
