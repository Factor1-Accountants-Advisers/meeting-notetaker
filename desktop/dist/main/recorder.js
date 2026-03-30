"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startRecording = startRecording;
exports.stopRecording = stopRecording;
exports.isRecording = isRecording;
exports.getRecordingStatus = getRecordingStatus;
const fluent_ffmpeg_1 = __importDefault(require("fluent-ffmpeg"));
const ffmpeg_static_1 = __importDefault(require("ffmpeg-static"));
if (!ffmpeg_static_1.default)
    throw new Error('ffmpeg-static did not resolve a binary for this platform');
fluent_ffmpeg_1.default.setFfmpegPath(ffmpeg_static_1.default);
let activeProcess = null;
let recordingActive = false;
let recordingStartedAt = null;
let activeMeetingTitle;
function startRecording(options) {
    if (recordingActive || activeProcess) {
        throw new Error('Already recording. Call stopRecording() first.');
    }
    recordingActive = true;
    recordingStartedAt = Date.now();
    activeMeetingTitle = options.meetingTitle;
    activeProcess = (0, fluent_ffmpeg_1.default)()
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
        if (!err.message.includes('SIGINT'))
            console.error('[recorder] error:', err.message);
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
function stopRecording() {
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
function isRecording() {
    return recordingActive;
}
function getRecordingStatus() {
    if (!recordingActive) {
        return { recording: false };
    }
    return {
        recording: true,
        meetingTitle: activeMeetingTitle,
        startedAt: recordingStartedAt ?? undefined,
    };
}
//# sourceMappingURL=recorder.js.map