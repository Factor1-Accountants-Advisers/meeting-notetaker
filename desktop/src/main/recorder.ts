import ffmpeg, { FfmpegCommand } from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';

if (!ffmpegPath) throw new Error('ffmpeg-static did not resolve a binary for this platform');
ffmpeg.setFfmpegPath(ffmpegPath);

export interface RecordingOptions {
  micName: string;
  loopbackName: string;
  outputPath: string;
  meetingTitle?: string;
}

export interface RecordingStatusSnapshot {
  recording: boolean;
  meetingTitle?: string;
  startedAt?: number;
}

let activeProcess: FfmpegCommand | null = null;
let recordingActive = false;
let recordingStartedAt: number | null = null;
let activeMeetingTitle: string | undefined;

export function startRecording(options: RecordingOptions): void {
  if (recordingActive || activeProcess) {
    throw new Error('Already recording. Call stopRecording() first.');
  }

  recordingActive = true;
  recordingStartedAt = Date.now();
  activeMeetingTitle = options.meetingTitle;

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
    .on('error', (err) => {
      if (!err.message.includes('SIGINT')) console.error('[recorder] error:', err.message);
      activeProcess = null;
      recordingActive = false;
      recordingStartedAt = null;
      activeMeetingTitle = undefined;
    })
    .on('end', () => {
      activeProcess = null;
      recordingActive = false;
      recordingStartedAt = null;
      activeMeetingTitle = undefined;
    })
    .save(options.outputPath);
}

export function stopRecording(): void {
  if (!activeProcess) {
    recordingActive = false;
    recordingStartedAt = null;
    activeMeetingTitle = undefined;
    return;
  }
  recordingActive = false;
  recordingStartedAt = null;
  activeMeetingTitle = undefined;
  activeProcess.kill('SIGINT');
  // activeProcess is reset by the 'end' or 'error' event handler
}

export function isRecording(): boolean {
  return recordingActive;
}

export function getRecordingStatus(): RecordingStatusSnapshot {
  if (!recordingActive) {
    return { recording: false };
  }

  return {
    recording: true,
    meetingTitle: activeMeetingTitle,
    startedAt: recordingStartedAt ?? undefined,
  };
}
