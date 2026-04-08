"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.onRecordingError = onRecordingError;
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
let activeOutputPath;
let activeMetadata;
let lastError;
let errorCallback = null;
function onRecordingError(cb) {
    errorCallback = cb;
}
function clearRecordingState() {
    activeProcess = null;
    recordingActive = false;
    recordingStartedAt = null;
    activeMeetingTitle = undefined;
    activeOutputPath = undefined;
    activeMetadata = undefined;
}
function handleFfmpegError(err) {
    const isGracefulStop = err.message.includes('SIGINT');
    if (!isGracefulStop) {
        console.error('[recorder] error:', err.message);
        lastError = err.message;
        if (errorCallback)
            errorCallback(err.message);
    }
    clearRecordingState();
}
function startRecording(options) {
    if (recordingActive || activeProcess) {
        throw new Error('Already recording. Call stopRecording() first.');
    }
    recordingActive = true;
    recordingStartedAt = Date.now();
    activeMeetingTitle = options.meetingTitle ?? options.metadata?.meeting_title;
    activeOutputPath = options.outputPath;
    activeMetadata = options.metadata;
    lastError = undefined;
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
        .on('error', handleFfmpegError)
        .on('end', () => {
        clearRecordingState();
    })
        .save(options.outputPath);
}
/**
 * Stop the active recording and return the active recording session details.
 */
function stopRecording() {
    const stopResult = {
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
function isRecording() {
    return recordingActive;
}
function getRecordingStatus() {
    if (!recordingActive) {
        return { recording: false, error: lastError };
    }
    return {
        recording: true,
        meetingTitle: activeMeetingTitle,
        startedAt: recordingStartedAt ?? undefined,
    };
}
//# sourceMappingURL=recorder.js.map