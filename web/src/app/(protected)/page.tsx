"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { Upload, Mic, FileText, Calendar, UploadCloud, MousePointerClick } from "lucide-react";
import { getElectronAPIOrNull } from "@/lib/electron-bridge";
import { useRecordingStatus } from "@/lib/useRecordingStatus";
import MeetingList from "@/components/MeetingList";
import UploadModal from "@/components/UploadModal";
import DayStrip from "@/components/DayStrip";
import DayMeetingList from "@/components/DayMeetingList";
import RecordingPanel from "@/components/RecordingPanel";
import MeetingDetailContent from "./meetings/[[...id]]/MeetingDetailContent";
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
  const [selectedCalendarEvent, setSelectedCalendarEvent] =
    useState<CalendarEvent | null>(null);
  const [showRecordingPanel, setShowRecordingPanel] = useState(false);
  const [detailMeetingId, setDetailMeetingId] = useState<number | null>(null);

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
    if (showRecordingPanel && selectedCalendarEvent?.id === meeting.id) {
      setShowRecordingPanel(false);
      setSelectedCalendarEvent(null);
      return;
    }
    setSelectedCalendarEvent(meeting);
    setShowRecordingPanel(true);
  };

  const handleStartAdHoc = () => {
    setSelectedCalendarEvent(null);
    setShowRecordingPanel(true);
  };

  const handleDismissPanel = () => {
    setShowRecordingPanel(false);
    setSelectedCalendarEvent(null);
  };

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="flex gap-6 h-full">
      {/* Left Panel */}
      <div className="w-[400px] flex-shrink-0 overflow-y-auto scrollbar-hidden pr-2">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-gray-100">Note Taker</h1>
            <p className="text-sm text-gray-500 mt-0.5">{today}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowUpload(true)}
              disabled={recording}
              className="px-3 py-1.5 text-sm font-medium text-gray-300 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded-lg flex items-center gap-1.5 transition-colors"
            >
              <Upload className="w-3.5 h-3.5" />
              Upload
            </button>
            {isElectron && (
              <button
                onClick={handleStartAdHoc}
                disabled={recording}
                className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg flex items-center gap-1.5 transition-colors"
              >
                <Mic className="w-3.5 h-3.5" />
                Record
              </button>
            )}
          </div>
        </div>

        {recording && (
          <div className="flex items-center gap-1.5 mb-4">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="text-xs font-medium text-red-400">Recording</span>
          </div>
        )}

        {/* Upcoming Meetings — Electron only */}
        {isElectron && (
          <section
            className={`mb-6 ${recording ? "opacity-50 pointer-events-none" : ""}`}
          >
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
              selectedMeetingId={selectedCalendarEvent?.id ?? null}
              onSelectMeeting={handleSelectMeeting}
              dateLabel={selectedDateLabel}
              expandedMeetingId={
                showRecordingPanel && selectedCalendarEvent
                  ? selectedCalendarEvent.id
                  : null
              }
              renderExpandedContent={(meeting) => (
                <RecordingPanel
                  selectedMeeting={meeting}
                  onDismiss={handleDismissPanel}
                  onMeetingCreated={(meetingId) => {
                    setShowRecordingPanel(false);
                    setSelectedCalendarEvent(null);
                    setDetailMeetingId(meetingId);
                  }}
                />
              )}
            />
          </section>
        )}

        {/* Ad-hoc Recording Panel */}
        {showRecordingPanel && isElectron && !selectedCalendarEvent && (
          <section className="mb-6">
            <RecordingPanel
              selectedMeeting={null}
              onDismiss={handleDismissPanel}
              onMeetingCreated={(meetingId) => {
                setShowRecordingPanel(false);
                setSelectedCalendarEvent(null);
                setDetailMeetingId(meetingId);
              }}
            />
          </section>
        )}

        {/* Divider */}
        <hr className="border-gray-800 mb-6" />

        {/* Past Meetings */}
        <section>
          <MeetingList
            onSelectMeeting={setDetailMeetingId}
            selectedMeetingId={detailMeetingId}
          />
        </section>
      </div>

      {/* Right Panel */}
      <div className="flex-1 overflow-y-auto scrollbar-hidden border-l border-gray-800 pl-6 bg-gray-950">
        {detailMeetingId ? (
          <MeetingDetailContent
            meetingId={detailMeetingId}
            onClose={() => setDetailMeetingId(null)}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full px-8 max-w-lg mx-auto">
            <div className="w-14 h-14 rounded-2xl bg-blue-600/10 flex items-center justify-center mb-5">
              <FileText className="w-7 h-7 text-blue-400" />
            </div>
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              Welcome to Note Taker
            </h2>
            <p className="text-sm text-gray-400 text-center mb-8">
              AI-powered meeting transcription, speaker identification, and smart
              summaries — all in one place.
            </p>

            <div className="w-full space-y-4">
              <div className="flex items-start gap-3 p-3 rounded-lg bg-gray-900/50 border border-gray-800">
                <div className="w-8 h-8 rounded-lg bg-blue-600/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Calendar className="w-4 h-4 text-blue-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-200">Record a meeting</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Select an upcoming meeting from the calendar on the left, then hit Start Recording.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 p-3 rounded-lg bg-gray-900/50 border border-gray-800">
                <div className="w-8 h-8 rounded-lg bg-purple-600/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <UploadCloud className="w-4 h-4 text-purple-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-200">Upload an audio file</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Already have a recording? Click Upload to transcribe and summarise any audio file.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 p-3 rounded-lg bg-gray-900/50 border border-gray-800">
                <div className="w-8 h-8 rounded-lg bg-green-600/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <MousePointerClick className="w-4 h-4 text-green-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-200">View past meetings</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Click any meeting in the list below to view its transcript, summary, and action items.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Upload Modal */}
      {showUpload && <UploadModal onClose={() => setShowUpload(false)} />}
    </div>
  );
}
