"use client";

import { useCallback } from "react";
import { getElectronAPIOrNull } from "@/lib/electron-bridge";
import { useRecordingStatus } from "@/lib/useRecordingStatus";
import { formatElapsed } from "@/lib/format";
import type { CalendarEvent } from "@/types";

interface RecordingControlsProps {
  selectedMeeting: CalendarEvent | null;
}

export default function RecordingControls({ selectedMeeting }: RecordingControlsProps) {
  const { recording, elapsed } = useRecordingStatus();
  const api = getElectronAPIOrNull();

  const handleStart = useCallback(async () => {
    if (!api) return;
    const outputPath = `meeting-${Date.now()}.wav`;
    const micName = localStorage.getItem("settings:micName") ?? "";
    const loopbackName = localStorage.getItem("settings:loopbackName") ?? "";
    await api.startRecording({ micName, loopbackName, outputPath });
    if (selectedMeeting) {
      await api.selectMeeting(selectedMeeting);
    }
  }, [api, selectedMeeting]);

  const handleStop = useCallback(async () => {
    if (!api) return;
    await api.stopRecording();
  }, [api]);

  if (!api) return null;

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
        Recording
      </h2>

      {recording ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 bg-red-500 rounded-full animate-pulse" />
            <span className="text-sm font-medium text-red-700">Recording</span>
            <span className="text-sm text-gray-500 ml-auto font-mono">
              {formatElapsed(elapsed)}
            </span>
          </div>
          <button
            onClick={handleStop}
            className="w-full px-3 py-2 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 transition-colors"
          >
            Stop Recording
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-gray-500">
            {selectedMeeting
              ? `Meeting: ${selectedMeeting.subject}`
              : "Select a meeting above, or record ad-hoc"}
          </p>
          <button
            onClick={handleStart}
            className="w-full px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors"
          >
            Start Recording
          </button>
        </div>
      )}
    </div>
  );
}
