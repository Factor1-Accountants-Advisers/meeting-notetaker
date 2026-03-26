import ffmpeg, { FfmpegCommand } from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';

if (!ffmpegPath) throw new Error('ffmpeg-static did not resolve a binary for this platform');
ffmpeg.setFfmpegPath(ffmpegPath);

export interface RecordingOptions {
  micName: string;
  loopbackName: string;
  outputPath: string;
}

let activeProcess: FfmpegCommand | null = null;

export function startRecording(options: RecordingOptions): void {
  if (activeProcess) throw new Error('Already recording. Call stopRecording() first.');

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
    })
    .on('end', () => { activeProcess = null; })
    .save(options.outputPath);
}

export function stopRecording(): void {
  if (!activeProcess) return;
  activeProcess.kill('SIGINT');
  // activeProcess is reset by the 'end' or 'error' event handler
}

export function isRecording(): boolean {
  return activeProcess !== null;
}
