import type { MeetingMetadata } from './uploader';
import { startWasapiCapture, stopWasapiCapture, isWasapiRecording } from './wasapi-capture';

/**
 * Recording facade. Internally delegates to Electron's WASAPI loopback capture
 * via a hidden renderer (see wasapi-capture.ts). The public API is unchanged
 * so ipc.ts and tray.ts continue to work without modification.
 *
 * Fields micName and loopbackName on RecordingOptions are accepted but ignored
 * — WASAPI always uses the Windows default playback + default input devices.
 */

export interface RecordingOptions {
  micName: string;
  loopbackName: string;
  outputPath: string;
  meetingTitle?: string;
  metadata?: MeetingMetadata;
}

export interface RecordingStatusSnapshot {
  recording: boolean;
  meetingTitle?: string;
  startedAt?: number;
  outputPath?: string;
  error?: string;
}

export interface RecordingStopResult {
  outputPath: string;
  metadata?: MeetingMetadata;
  error?: string;
}

export type RecordingErrorCallback = (error: string) => void;

let recordingStartedAt: number | null = null;
let activeMeetingTitle: string | undefined;
let activeOutputPath: string | undefined;
let activeMetadata: MeetingMetadata | undefined;
let lastError: string | undefined;
let errorCallback: RecordingErrorCallback | null = null;

export function onRecordingError(cb: RecordingErrorCallback | null): void {
  errorCallback = cb;
}

function clearRecordingState(): void {
  recordingStartedAt = null;
  activeMeetingTitle = undefined;
  activeOutputPath = undefined;
  activeMetadata = undefined;
}

function handleError(message: string): void {
  console.error('[recorder] error:', message);
  lastError = message;
  if (errorCallback) errorCallback(message);
  clearRecordingState();
}

export function startRecording(options: RecordingOptions): void {
  if (isWasapiRecording()) {
    throw new Error('Already recording. Call stopRecording() first.');
  }

  recordingStartedAt = Date.now();
  activeMeetingTitle = options.meetingTitle ?? options.metadata?.meeting_title;
  activeOutputPath = options.outputPath;
  activeMetadata = options.metadata;
  lastError = undefined;

  startWasapiCapture(options.outputPath)
    .then(() => {
      console.log(`[recorder] WASAPI capture started → ${options.outputPath}`);
    })
    .catch((err: Error) => {
      handleError(err.message);
    });
}

/**
 * Stop the active recording. Returns a promise that resolves once the webm
 * chunks have been flushed and transcoded to wav. The wav path is returned
 * in RecordingStopResult.outputPath.
 */
export async function stopRecording(): Promise<RecordingStopResult> {
  const snapshot: RecordingStopResult = {
    outputPath: activeOutputPath || '',
    metadata: activeMetadata,
  };

  if (!isWasapiRecording()) {
    clearRecordingState();
    return { ...snapshot, ...(lastError ? { error: lastError } : {}) };
  }

  try {
    const wavPath = await stopWasapiCapture();
    clearRecordingState();
    return { outputPath: wavPath, metadata: snapshot.metadata };
  } catch (err) {
    const message = (err as Error).message;
    handleError(message);
    return { ...snapshot, error: message };
  }
}

export function isRecording(): boolean {
  return isWasapiRecording();
}

export function getRecordingStatus(): RecordingStatusSnapshot {
  if (!isWasapiRecording()) {
    return { recording: false, error: lastError };
  }

  return {
    recording: true,
    meetingTitle: activeMeetingTitle,
    startedAt: recordingStartedAt ?? undefined,
  };
}
