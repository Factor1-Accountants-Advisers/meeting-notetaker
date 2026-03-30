"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Mic, Volume2, CircleDot, Square, AlertCircle, Loader2 } from "lucide-react";
import { getElectronAPIOrNull } from "@/lib/electron-bridge";
import { useRecordingStatus } from "@/lib/useRecordingStatus";
import {
  readAudioSettings,
  hasCompleteAudioSettings,
  needsDefaultAudioSettings,
  applyDefaultAudioSettings,
} from "@/lib/audio-settings";
import type { CalendarEvent } from "@/types";

type PanelMode = "prefilled" | "adhoc" | "recording" | "uploading";

interface RecordingPanelProps {
  selectedMeeting: CalendarEvent | null;
  onMeetingCreated?: (meetingId: number) => void;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function formatMeetingDateTime(start: string, end: string): string {
  return `${new Date(start).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  })} · ${new Date(start).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  })} - ${new Date(end).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function summarizeParticipants(
  attendees: { name: string }[],
  maxVisible = 3
): string {
  const names = attendees
    .map((attendee) => attendee.name.trim())
    .filter(Boolean);

  if (names.length === 0) return "No participants listed";
  if (names.length <= maxVisible) return names.join(", ");

  const visible = names.slice(0, maxVisible).join(", ");
  return `${visible} +${names.length - maxVisible} more`;
}

export default function RecordingPanel({
  selectedMeeting,
  onMeetingCreated,
}: RecordingPanelProps) {
  const router = useRouter();
  const electron = getElectronAPIOrNull();
  const { recording, elapsed } = useRecordingStatus();

  const [title, setTitle] = useState("");
  const [attendees, setAttendees] = useState<string[]>([]);
  const [attendeeInput, setAttendeeInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [lastFilePath, setLastFilePath] = useState<string | null>(null);

  const isRecording = recording;

  const mode: PanelMode = uploading
    ? "uploading"
    : isRecording
      ? "recording"
      : selectedMeeting
        ? "prefilled"
        : "adhoc";

  const meetingTitle = selectedMeeting?.subject ?? title;
  const audioSettings = readAudioSettings();
  const audioReady = hasCompleteAudioSettings(audioSettings);

  const buildMetadata = () => ({
    meeting_title: meetingTitle || `Recording ${new Date().toLocaleString()}`,
    attendees: selectedMeeting
      ? selectedMeeting.attendees.map((a) => ({ name: a.name, email: a.email }))
      : attendees.map((name) => ({ name })),
    scheduled_time: selectedMeeting?.start,
  });

  const canStart =
    mode === "prefilled" || (title.trim() !== "" && attendees.length > 0);

  const handleAddAttendee = useCallback(() => {
    const name = attendeeInput.trim();
    if (name && !attendees.includes(name)) {
      setAttendees((prev) => [...prev, name]);
    }
    setAttendeeInput("");
  }, [attendeeInput, attendees]);

  const handleRemoveAttendee = (name: string) => {
    setAttendees((prev) => prev.filter((a) => a !== name));
  };

  const handleStart = async () => {
    if (!electron) return;
    setError(null);
    try {
      let settings = audioSettings;

      // Auto-detect defaults if no settings saved yet
      if (!hasCompleteAudioSettings(settings) && needsDefaultAudioSettings()) {
        try {
          const defaults = await electron.getDefaultAudioDevices();
          const applied = applyDefaultAudioSettings(defaults);
          if (applied && hasCompleteAudioSettings(applied)) {
            settings = applied;
          }
        } catch {
          // Fall through to the "not ready" error below
        }
      }

      if (!hasCompleteAudioSettings(settings)) {
        setError(
          "Before recording, choose your microphone and system audio in Settings."
        );
        return;
      }

      await electron.startRecording({
        micName: settings.micName,
        loopbackName: settings.loopbackName,
        outputPath: "", // main process generates the path
        metadata: buildMetadata(),
      });
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : "Microphone access denied. Check your system permissions."
      );
    }
  };

  const doUpload = async (filePath: string) => {
    if (!electron) return;
    setUploading(true);
    setUploadError(null);
    try {
      const result = await electron.uploadRecording({
        filePath,
        metadata: buildMetadata(),
      });
      setUploading(false);
      if (onMeetingCreated) {
        onMeetingCreated(result.meeting_id);
      }
    } catch (err: unknown) {
      setUploading(false);
      setLastFilePath(filePath);
      setUploadError(
        err instanceof Error
          ? err.message
          : "Failed to upload recording. Your file is saved locally."
      );
    }
  };

  const handleStop = async () => {
    if (!electron) return;
    setUploadError(null);
    try {
      const filePath = await electron.stopRecording();
      await doUpload(filePath);
    } catch (err: unknown) {
      setUploadError(
        err instanceof Error
          ? err.message
          : "Failed to stop recording."
      );
    }
  };

  const handleRetryUpload = async () => {
    if (lastFilePath) {
      await doUpload(lastFilePath);
    }
  };

  if (mode === "uploading") {
    return (
      <div className="rounded-[24px] border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] p-5">
        <div className="flex flex-col items-center py-6">
          <Loader2 className="mb-3 h-8 w-8 animate-spin text-[color:var(--accent-text)]" />
          <p className="text-sm font-medium text-[color:var(--text-primary)]">Uploading recording...</p>
          <p className="mt-1 text-xs text-[color:var(--text-secondary)]">
            This may take a moment depending on the file size.
          </p>
        </div>
      </div>
    );
  }

  if (mode === "recording") {
    return (
      <div className="rounded-[24px] border border-[color:var(--danger-soft)] bg-[color:var(--surface-elevated)] p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-[color:var(--danger)] animate-pulse" />
            <span className="text-xs font-semibold uppercase tracking-wide text-[color:var(--danger)]">
              Recording in Progress
            </span>
          </div>
        </div>

        <p className="mb-1 text-sm font-medium text-[color:var(--text-primary)]">{meetingTitle}</p>

        <div className="my-4 font-mono text-4xl font-bold text-[color:var(--text-primary)]">
          {formatElapsed(elapsed)}
        </div>

        <div className="mb-4 flex gap-4 text-xs text-[color:var(--text-secondary)]">
          <div className="flex items-center gap-1.5">
            <Mic className="w-3 h-3" />
            <div className="flex gap-px items-end h-3">
              {[3, 5, 8, 6, 4, 7, 5].map((h, i) => (
                <div
                  key={i}
                  className="w-1 bg-green-500/60 rounded-full"
                  style={{ height: `${h * 1.5}px` }}
                />
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Volume2 className="w-3 h-3" />
            <div className="flex gap-px items-end h-3">
              {[4, 7, 5, 8, 6, 3, 7].map((h, i) => (
                <div
                  key={i}
                  className="w-1 bg-green-500/60 rounded-full"
                  style={{ height: `${h * 1.5}px` }}
                />
              ))}
            </div>
          </div>
        </div>

        {uploadError && (
          <div className="mb-3 flex items-start gap-2 rounded-2xl border border-[color:var(--danger-soft)] bg-[color:var(--danger-soft)] p-3">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-[color:var(--danger)]" />
            <div>
              <p className="text-xs text-[color:var(--danger)]">{uploadError}</p>
              <button
                onClick={handleRetryUpload}
                className="mt-1 text-xs text-[color:var(--accent-text)] hover:opacity-80"
              >
                Retry Upload
              </button>
            </div>
          </div>
        )}

        <button
          onClick={handleStop}
          className="flex w-full items-center justify-center gap-2 rounded-full bg-[color:var(--danger)] py-3 text-sm font-semibold text-white transition hover:opacity-90"
        >
          <Square className="w-4 h-4" fill="currentColor" />
          Stop Recording
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-[24px] border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] p-5">
      {uploadError && (
        <div className="mb-3 flex items-start gap-2 rounded-2xl border border-[color:var(--danger-soft)] bg-[color:var(--danger-soft)] p-3">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-[color:var(--danger)]" />
          <div>
            <p className="text-xs text-[color:var(--danger)]">{uploadError}</p>
            <button
              onClick={handleRetryUpload}
              className="mt-1 text-xs text-[color:var(--accent-text)] hover:opacity-80"
            >
              Retry Upload
            </button>
          </div>
        </div>
      )}

      {mode === "prefilled" && selectedMeeting ? (
        <div className="mb-5 space-y-3">
          <div className="grid gap-1">
            <span className="text-sm font-semibold text-[color:var(--text-primary)]">
              Title
            </span>
            <p className="text-sm font-normal text-[color:var(--text-secondary)]">
              {selectedMeeting.subject}
            </p>
          </div>
          <div className="grid gap-1">
            <span className="text-sm font-semibold text-[color:var(--text-primary)]">
              Date and Time
            </span>
            <p className="text-sm font-normal text-[color:var(--text-secondary)]">
              {formatMeetingDateTime(selectedMeeting.start, selectedMeeting.end)}
            </p>
          </div>
          <div className="grid gap-1">
            <span className="text-sm font-semibold text-[color:var(--text-primary)]">
              Participants
            </span>
            <p className="text-sm font-normal text-[color:var(--text-secondary)]">
              {summarizeParticipants(selectedMeeting.attendees)}
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-3 mb-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-[color:var(--text-secondary)]">
              Meeting Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Quick sync with David"
              className="w-full rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] px-3 py-2 text-sm text-[color:var(--text-primary)] placeholder:text-[color:var(--text-muted)] outline-none focus:border-[color:var(--border-strong)]"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-[color:var(--text-secondary)]">
              Attendees
            </label>
            <div className="flex min-h-[38px] w-full flex-wrap items-center gap-1 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] px-2.5 py-1.5">
              {attendees.map((name) => (
                <span
                  key={name}
                  className="flex items-center gap-1 rounded-full bg-[color:var(--accent-soft)] px-2 py-0.5 text-xs text-[color:var(--accent-text)]"
                >
                  {name}
                  <button
                    onClick={() => handleRemoveAttendee(name)}
                    className="opacity-60 hover:opacity-100"
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                type="text"
                value={attendeeInput}
                onChange={(e) => setAttendeeInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddAttendee();
                  }
                }}
                placeholder={attendees.length === 0 ? "Add name..." : ""}
                className="min-w-[80px] flex-1 bg-transparent py-0.5 text-xs text-[color:var(--text-primary)] outline-none placeholder:text-[color:var(--text-muted)]"
              />
            </div>
            <p className="mt-1 text-[10px] text-[color:var(--text-muted)]">
              Press Enter to add. Helps identify speakers in the transcript.
            </p>
          </div>
        </div>
      )}

      <div className="mb-4 flex gap-4 text-xs text-[color:var(--text-secondary)]">
        <span className="flex items-center gap-1">
          <Mic className="w-3 h-3" /> Microphone
        </span>
        <span className="flex items-center gap-1">
          <Volume2 className="w-3 h-3" /> System Audio
        </span>
      </div>

      {!audioReady && (
        <div className="mb-4 rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4">
          <p className="text-sm font-medium text-[color:var(--text-primary)]">
            Before recording, choose your microphone and system audio.
          </p>
          <p className="mt-1 text-xs leading-6 text-[color:var(--text-secondary)]">
            This only needs to be set once on this device.
          </p>
          <button
            type="button"
            onClick={() => router.push("/settings")}
            className="mt-3 inline-flex h-10 items-center rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] px-4 text-sm font-medium text-[color:var(--text-primary)] transition hover:border-[color:var(--border-strong)]"
          >
            Set up audio devices
          </button>
        </div>
      )}

      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-2xl border border-[color:var(--danger-soft)] bg-[color:var(--danger-soft)] p-3">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-[color:var(--danger)]" />
          <p className="text-xs text-[color:var(--danger)]">{error}</p>
        </div>
      )}

      <button
        onClick={handleStart}
        disabled={!canStart || !audioReady}
        className="flex w-full items-center justify-center gap-2 rounded-full bg-[color:var(--surface-inverse)] py-3.5 text-sm font-semibold text-[color:var(--text-inverse)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <CircleDot className="w-4 h-4" />
        Start Recording
      </button>
    </div>
  );
}
