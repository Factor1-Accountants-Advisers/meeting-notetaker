"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import {
  Clock3,
  Mic,
  Upload,
  Users,
} from "lucide-react";
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
  // Local date, not UTC. Must match DayStrip's toDateKey so tab keys and
  // meeting-bucket keys agree — a UTC-vs-local mismatch silently drops
  // meetings onto the wrong day tab for users east of UTC.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Cross-fades between panels without destroying/recreating DOM.
 * Both children stay mounted; only opacity + pointer-events toggle.
 */
function MorphPanel({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`absolute inset-0 transition-opacity duration-200 ease-out ${
        active ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
    >
      {children}
    </div>
  );
}

export default function DashboardPage() {
  const electron = getElectronAPIOrNull();
  const isElectron = !!electron;
  const { recording, elapsed, meetingTitle } = useRecordingStatus();

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

  useEffect(() => {
    if (!recording || selectedCalendarEvent || !meetingTitle || calendarEvents.length === 0) {
      return;
    }

    const matchedMeeting = calendarEvents.find(
      (event) => event.subject === meetingTitle
    );

    if (matchedMeeting) {
      setSelectedCalendarEvent(matchedMeeting);
      setShowRecordingPanel(true);
    }
  }, [calendarEvents, meetingTitle, recording, selectedCalendarEvent]);

  const dayMeetings = useMemo(
    () =>
      calendarEvents.filter(
        (m) => toDateKey(new Date(m.start)) === selectedDate
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

  const activeRecordingMeetingId = useMemo(() => {
    if (!recording || !meetingTitle) return null;
    return (
      calendarEvents.find((event) => event.subject === meetingTitle)?.id ?? null
    );
  }, [calendarEvents, meetingTitle, recording]);

  const handleSelectMeeting = (meeting: CalendarEvent) => {
    if (recording) {
      if (!activeRecordingMeetingId || meeting.id !== activeRecordingMeetingId) {
        return;
      }
    }

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

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const selectedAttendeeNames = selectedCalendarEvent?.attendees
    .map((attendee) => attendee.name)
    .slice(0, 4)
    .join(", ");

  const composerTitle = recording
    ? meetingTitle || selectedCalendarEvent?.subject || "Recording in progress"
    : selectedCalendarEvent?.subject || "What should we capture today?";

  return (
    <div className="grid h-full grid-cols-[minmax(340px,390px)_minmax(0,1fr)] gap-5">
      <aside className="surface-panel scrollbar-hidden flex h-full min-h-0 flex-col overflow-y-auto rounded-[30px] px-5 py-5">
        <div className="mb-6">
          <h1 className="text-[2.15rem] font-semibold tracking-tight text-[color:var(--text-primary)]">
            Note Taker
          </h1>
          <p className="mt-1 text-sm text-[color:var(--text-secondary)]">{today}</p>
        </div>

        {recording && (
          <div className="mb-5 flex items-center gap-2 rounded-full border border-[color:var(--danger-soft)] bg-[color:var(--danger-soft)] px-3 py-2 text-xs font-medium text-[color:var(--danger)]">
            <span className="h-2 w-2 rounded-full bg-[color:var(--danger)] animate-pulse" />
            Recording live
          </div>
        )}

        {isElectron && (
          <section className={recording ? "opacity-80" : ""}>
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
              contentKey={selectedDate}
              expandedMeetingId={
                showRecordingPanel && selectedCalendarEvent
                  ? selectedCalendarEvent.id
                  : null
              }
              renderExpandedContent={(meeting) => (
                <RecordingPanel
                  selectedMeeting={meeting}
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

        {showRecordingPanel && isElectron && !selectedCalendarEvent && (
          <section className="mt-5">
            <RecordingPanel
              selectedMeeting={null}
              onMeetingCreated={(meetingId) => {
                setShowRecordingPanel(false);
                setSelectedCalendarEvent(null);
                setDetailMeetingId(meetingId);
              }}
            />
          </section>
        )}

        <section className="mt-7 border-t border-[color:var(--border-subtle)] pt-6">
          <MeetingList
            onSelectMeeting={setDetailMeetingId}
            selectedMeetingId={detailMeetingId}
          />
        </section>
      </aside>

      <section className="surface-panel relative min-h-0 overflow-hidden rounded-[34px]">
        {/* Detail panel — stays mounted once a meeting has been viewed */}
        {detailMeetingId !== null && (
          <MorphPanel active={detailMeetingId !== null}>
            <div className="scrollbar-hidden h-full overflow-y-auto px-8 py-8">
              <MeetingDetailContent
                meetingId={detailMeetingId}
                onClose={() => setDetailMeetingId(null)}
              />
            </div>
          </MorphPanel>
        )}

        {/* Idle / recording panel */}
        <MorphPanel active={detailMeetingId === null}>
          <div className="scrollbar-hidden relative flex h-full min-h-0 flex-col overflow-y-auto px-8 py-8">
            <div className="pointer-events-none absolute inset-x-16 top-0 h-44 rounded-b-[56px] bg-[radial-gradient(circle_at_top,rgba(37,99,235,0.09),transparent_58%)]" />

            <div className="relative mx-auto flex h-full w-full max-w-4xl flex-col">
              <div className="flex flex-1 flex-col items-center justify-center pb-12 pt-4">
                <div className="w-full max-w-3xl text-center">
                  <h2 className="text-balance text-4xl font-semibold tracking-tight text-[color:var(--text-primary)] md:text-5xl">
                    {recording
                      ? "Your meeting is being captured."
                      : selectedCalendarEvent
                        ? "Your meeting is loaded and ready."
                        : "Capture a meeting"}
                  </h2>
                  <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-[color:var(--text-secondary)]">
                    {recording
                      ? "Keep Note Taker running while it listens to system audio, then stop when the meeting ends."
                      : selectedCalendarEvent
                        ? "The selected meeting from the left rail is ready for recording."
                        : "Choose a meeting from the left rail or start an ad-hoc recording."}
                  </p>
                </div>

                <div className="surface-card mt-10 flex min-h-[260px] w-full max-w-3xl flex-col rounded-[36px] px-8 py-8 text-left shadow-[var(--shadow-panel)]">
                  <div className="min-w-0 flex-1">
                    <p className="text-2xl font-semibold tracking-tight text-[color:var(--text-primary)]">
                      {composerTitle}
                    </p>

                    {recording ? (
                      <div className="mt-4">
                        <p className="font-mono text-4xl font-semibold text-[color:var(--text-primary)]">
                          {String(Math.floor(elapsed / 60000)).padStart(2, "0")}:
                          {String(Math.floor((elapsed % 60000) / 1000)).padStart(2, "0")}
                        </p>
                        <p className="mt-3 max-w-lg text-sm leading-7 text-[color:var(--text-secondary)]">
                          Listening to system audio. Stop when the meeting ends and Note Taker will continue with transcript, summary, and action items.
                        </p>
                      </div>
                    ) : selectedCalendarEvent ? (
                      <div className="mt-4 space-y-3">
                        <div className="flex flex-wrap items-center gap-4 text-sm text-[color:var(--text-secondary)]">
                          <span className="inline-flex items-center gap-2">
                            <Clock3 className="h-4 w-4 text-[color:var(--text-muted)]" />
                            {new Date(selectedCalendarEvent.start).toLocaleDateString("en-US", {
                              weekday: "long",
                              month: "short",
                              day: "numeric",
                            })}{" "}
                            ·{" "}
                            {new Date(selectedCalendarEvent.start).toLocaleTimeString("en-US", {
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </span>
                          <span className="inline-flex items-center gap-2">
                            <Users className="h-4 w-4 text-[color:var(--text-muted)]" />
                            {selectedCalendarEvent.attendees.length} attendees
                          </span>
                        </div>
                        <p className="max-w-2xl text-sm leading-7 text-[color:var(--text-secondary)]">
                          {selectedAttendeeNames}
                          {selectedCalendarEvent.attendees.length > 4 &&
                            ` +${selectedCalendarEvent.attendees.length - 4} more`}
                        </p>
                      </div>
                    ) : (
                      <p className="mt-4 max-w-xl text-sm leading-7 text-[color:var(--text-secondary)]">
                        Choose a meeting from the left rail, or start a fresh capture session for an unplanned conversation.
                      </p>
                    )}
                  </div>

                  <div className="mt-8 border-t border-[color:var(--border-subtle)] pt-5">
                    <p className="mx-auto max-w-xl text-center text-sm leading-7 text-[color:var(--text-secondary)]">
                      Note Taker records system audio and turns the meeting into searchable notes, summaries, and follow-up actions.
                    </p>

                    <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
                      <button
                        onClick={() => setShowUpload(true)}
                        disabled={recording}
                        className="inline-flex h-12 items-center gap-2 rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] px-5 text-sm font-medium text-[color:var(--text-primary)] transition-[border-color,background-color] duration-150 hover:border-[color:var(--border-strong)] hover:bg-white disabled:opacity-50"
                      >
                        <Upload className="h-4 w-4" />
                        Upload
                      </button>
                      {isElectron && (
                        <button
                          onClick={
                            selectedCalendarEvent
                              ? () => setShowRecordingPanel(true)
                              : handleStartAdHoc
                          }
                          disabled={recording}
                          className="inline-flex h-12 items-center gap-2 rounded-full bg-[color:var(--surface-inverse)] px-6 text-sm font-medium text-[color:var(--text-inverse)] transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
                        >
                          <Mic className="h-4 w-4" />
                          {selectedCalendarEvent ? "Open capture" : "Record"}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </MorphPanel>
      </section>

      {showUpload && (
        <UploadModal
          onClose={() => setShowUpload(false)}
          onUploaded={(meetingId) => {
            setShowUpload(false);
            setShowRecordingPanel(false);
            setSelectedCalendarEvent(null);
            setDetailMeetingId(meetingId);
          }}
        />
      )}
    </div>
  );
}
