"use client";

import { useState, useEffect, useRef } from "react";
import { getElectronAPIOrNull } from "@/lib/electron-bridge";

interface RecordingState {
  recording: boolean;
  meetingTitle?: string;
  elapsed: number;
}

/**
 * Hook that subscribes to recording status from Electron's main process.
 * Returns current recording state with a live-updating elapsed timer.
 * Returns { recording: false, elapsed: 0 } when not in Electron.
 */
export function useRecordingStatus(): RecordingState {
  const [recording, setRecording] = useState(false);
  const [meetingTitle, setMeetingTitle] = useState<string | undefined>();
  const [elapsed, setElapsed] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const api = getElectronAPIOrNull();

  // Poll initial state + subscribe to pushes
  useEffect(() => {
    if (!api) return;
    api.getRecordingStatus().then((status) => {
      setRecording(status.recording);
      setMeetingTitle(status.meetingTitle);
      if (status.recording && status.startedAt) {
        startTimeRef.current = status.startedAt;
      } else {
        startTimeRef.current = null;
      }
    });

    const unsub = api.onRecordingStatus((status) => {
      setRecording(status.recording);
      setMeetingTitle(status.meetingTitle);
      if (status.recording && status.startedAt) {
        startTimeRef.current = status.startedAt;
      } else {
        startTimeRef.current = null;
      }
    });
    return unsub;
  }, [api]);

  // Elapsed timer
  useEffect(() => {
    if (recording) {
      if (!startTimeRef.current) startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        setElapsed(Date.now() - (startTimeRef.current ?? Date.now()));
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      setElapsed(0);
      startTimeRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [recording]);

  return { recording, meetingTitle, elapsed };
}
