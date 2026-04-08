import ffmpeg, { FfmpegCommand } from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import type { MeetingMetadata } from './uploader';

if (!ffmpegPath) throw new Error('ffmpeg-static did not resolve a binary for this platform');
ffmpeg.setFfmpegPath(ffmpegPath);

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

let activeProcess: FfmpegCommand | null = null;
let recordingActive = false;
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
  activeProcess = null;
  recordingActive = false;
  recordingStartedAt = null;
  activeMeetingTitle = undefined;
  activeOutputPath = undefined;
  activeMetadata = undefined;
}

function handleFfmpegError(err: Error): void {
  const isGracefulStop = err.message.includes('SIGINT');
  if (!isGracefulStop) {
    console.error('[recorder] error:', err.message);
    lastError = err.message;
    if (errorCallback) errorCallback(err.message);
  }
  clearRecordingState();
}

export function startRecording(options: RecordingOptions): void {
  if (recordingActive || activeProcess) {
    throw new Error('Already recording. Call stopRecording() first.');
  }

  recordingActive = true;
  recordingStartedAt = Date.now();
  activeMeetingTitle = options.meetingTitle ?? options.metadata?.meeting_title;
  activeOutputPath = options.outputPath;
  activeMetadata = options.metadata;
  lastError = undefined;

  activeProcess = ffmpeg()
    .input(`audio=${options.micName}`)
    .inputOptions(['-f', 'dshow'])
    .input(`audio=${options.loopbackName}`)
    .inputOptions(['-f', 'dshow'])
    .complexFilter('amix=inputs=2:duration=longest:dropout_transition=0')
    .audioFrequency(16000)
    .audioChannels(1)
    .audioCodec('pcm_s16le')
    .outputOptions(['-y'])
    .on('start', (cmd) => console.log('[recorder] started:', cmd))
    .on('error', handleFfmpegError)
    .on('end', () => {
      clearRecordingState();
    })
    .save(options.outputPath);
}

/**
 * Stop the active recording and return the active recording session details.
 */
export function stopRecording(): RecordingStopResult {
  const stopResult: RecordingStopResult = {
    outputPath: activeOutputPath || '',
    metadata: activeMetadata,
    ...(lastError ? { error: lastError } : {}),
  };

  if (!activeProcess) {
    recordingActive = false;
    recordingStartedAt = null;
    activeMeetingTitle = undefined;
    activeOutputPath = undefined;
    activeMetadata = undefined;
    return stopResult;
  }
  recordingActive = false;
  recordingStartedAt = null;
  activeMeetingTitle = undefined;
  activeOutputPath = undefined;
  activeMetadata = undefined;
  activeProcess.kill('SIGINT');
  // activeProcess is reset by the 'end' or 'error' event handler
  return stopResult;
}

export function isRecording(): boolean {
  return recordingActive;
}

export function getRecordingStatus(): RecordingStatusSnapshot {
  if (!recordingActive) {
    return { recording: false, error: lastError };
  }

  return {
    recording: true,
    meetingTitle: activeMeetingTitle,
    startedAt: recordingStartedAt ?? undefined,
  };
}
