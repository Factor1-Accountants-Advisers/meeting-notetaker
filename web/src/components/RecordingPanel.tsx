"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Mic, Volume2, X, CircleDot, Square, AlertCircle } from "lucide-react";
import { getElectronAPIOrNull } from "@/lib/electron-bridge";
import { useRecordingStatus } from "@/lib/useRecordingStatus";
import type { CalendarEvent } from "@/types";

type PanelMode = "prefilled" | "adhoc" | "recording";

interface RecordingPanelProps {
  selectedMeeting: CalendarEvent | null;
  onDismiss: () => void;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export default function RecordingPanel({
  selectedMeeting,
  onDismiss,
}: RecordingPanelProps) {
  const router = useRouter();
  const electron = getElectronAPIOrNull();
  const { recording, elapsed } = useRecordingStatus();

  const [title, setTitle] = useState("");
  const [attendees, setAttendees] = useState<string[]>([]);
  const [attendeeInput, setAttendeeInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const mode: PanelMode = recording
    ? "recording"
    : selectedMeeting
      ? "prefilled"
      : "adhoc";

  const meetingTitle = selectedMeeting?.subject ?? title;

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
      const devices = await electron.getAudioDevices();
      await electron.startRecording({
        micName: devices?.[0]?.name ?? "default",
        loopbackName: devices?.[1]?.name ?? "default",
        outputPath: "",
      });
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : "Microphone access denied. Check your system permissions."
      );
    }
  };

  const handleStop = async () => {
    if (!electron) return;
    setUploadError(null);
    try {
      await electron.stopRecording();
      router.push("/");
    } catch (err: unknown) {
      setUploadError(
        err instanceof Error
          ? err.message
          : "Failed to upload recording. Your file is saved locally."
      );
    }
  };

  if (mode === "recording") {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="text-xs font-semibold text-red-400 uppercase tracking-wide">
              Recording in Progress
            </span>
          </div>
        </div>

        <p className="text-sm font-medium text-gray-200 mb-1">{meetingTitle}</p>

        <div className="text-4xl font-mono font-bold text-gray-100 my-4">
          {formatElapsed(elapsed)}
        </div>

        <div className="flex gap-4 mb-4 text-xs text-gray-500">
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
          <div className="flex items-start gap-2 p-3 mb-3 rounded-lg bg-red-500/10 border border-red-500/20">
            <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-xs text-red-300">{uploadError}</p>
              <button
                onClick={handleStop}
                className="text-xs text-blue-400 hover:text-blue-300 mt-1"
              >
                Retry Upload
              </button>
            </div>
          </div>
        )}

        <button
          onClick={handleStop}
          className="w-full py-3 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold rounded-xl flex items-center justify-center gap-2 transition-colors"
        >
          <Square className="w-4 h-4" fill="currentColor" />
          Stop Recording
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-5">
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs font-semibold text-blue-400 uppercase tracking-wide">
          {mode === "prefilled" ? "Ready to Record" : "New Recording"}
        </span>
        <button onClick={onDismiss} className="text-gray-600 hover:text-gray-400">
          <X className="w-4 h-4" />
        </button>
      </div>

      {mode === "prefilled" && selectedMeeting ? (
        <div className="mb-4">
          <p className="text-sm font-medium text-gray-200">
            {selectedMeeting.subject}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            {new Date(selectedMeeting.start).toLocaleDateString("en-US", {
              weekday: "short",
              month: "short",
              day: "numeric",
            })}{" "}
            · {new Date(selectedMeeting.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
            {" – "}
            {new Date(selectedMeeting.end).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">
            {selectedMeeting.attendees.map((a) => a.name).join(", ")}
          </p>
        </div>
      ) : (
        <div className="space-y-3 mb-4">
          <div>
            <label className="text-xs text-gray-500 font-medium block mb-1">
              Meeting Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Quick sync with David"
              className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-gray-200 placeholder:text-gray-600 outline-none focus:border-blue-500/40"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 font-medium block mb-1">
              Attendees
            </label>
            <div className="w-full px-2.5 py-1.5 bg-white/5 border border-white/10 rounded-lg min-h-[38px] flex flex-wrap gap-1 items-center">
              {attendees.map((name) => (
                <span
                  key={name}
                  className="bg-blue-500/15 text-blue-300 px-2 py-0.5 rounded text-xs flex items-center gap-1"
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
                className="flex-1 min-w-[80px] bg-transparent text-xs text-gray-200 outline-none placeholder:text-gray-600 py-0.5"
              />
            </div>
            <p className="text-[10px] text-gray-600 mt-1">
              Press Enter to add. Helps identify speakers in the transcript.
            </p>
          </div>
        </div>
      )}

      <div className="flex gap-4 mb-4 text-xs text-gray-500">
        <span className="flex items-center gap-1">
          <Mic className="w-3 h-3" /> Microphone
        </span>
        <span className="flex items-center gap-1">
          <Volume2 className="w-3 h-3" /> System Audio
        </span>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 mb-3 rounded-lg bg-red-500/10 border border-red-500/20">
          <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-red-300">{error}</p>
        </div>
      )}

      <button
        onClick={handleStart}
        disabled={!canStart}
        className="w-full py-3.5 bg-red-600 hover:bg-red-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-semibold rounded-xl flex items-center justify-center gap-2 transition-colors shadow-lg shadow-red-600/20 disabled:shadow-none"
      >
        <CircleDot className="w-4 h-4" />
        Start Recording
      </button>
    </div>
  );
}
