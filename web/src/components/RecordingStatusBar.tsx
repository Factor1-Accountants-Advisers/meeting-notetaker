"use client";

import { getElectronAPIOrNull } from "@/lib/electron-bridge";
import { useRecordingStatus } from "@/lib/useRecordingStatus";
import { formatElapsed } from "@/lib/format";

export default function RecordingStatusBar() {
  const { recording, meetingTitle, elapsed } = useRecordingStatus();
  const api = getElectronAPIOrNull();

  if (!recording) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-red-600 text-white px-4 py-2 flex items-center gap-3 z-50">
      <span className="inline-block w-2 h-2 bg-white rounded-full animate-pulse" />
      <span className="text-sm font-medium">
        Recording{meetingTitle ? `: ${meetingTitle}` : ""}
      </span>
      <span className="text-sm font-mono ml-auto">{formatElapsed(elapsed)}</span>
      <button
        onClick={() => api?.stopRecording()}
        className="px-3 py-1 bg-white text-red-600 text-sm font-medium rounded hover:bg-red-50 transition-colors"
      >
        Stop
      </button>
    </div>
  );
}
