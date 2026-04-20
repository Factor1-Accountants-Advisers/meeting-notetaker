"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onRecordingError = onRecordingError;
exports.startRecording = startRecording;
exports.stopRecording = stopRecording;
exports.isRecording = isRecording;
exports.getRecordingStatus = getRecordingStatus;
const wasapi_capture_1 = require("./wasapi-capture");
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
    recordingStartedAt = null;
    activeMeetingTitle = undefined;
    activeOutputPath = undefined;
    activeMetadata = undefined;
}
function handleError(message) {
    console.error('[recorder] error:', message);
    lastError = message;
    if (errorCallback)
        errorCallback(message);
    clearRecordingState();
}
function startRecording(options) {
    if ((0, wasapi_capture_1.isWasapiRecording)()) {
        throw new Error('Already recording. Call stopRecording() first.');
    }
    recordingStartedAt = Date.now();
    activeMeetingTitle = options.meetingTitle ?? options.metadata?.meeting_title;
    activeOutputPath = options.outputPath;
    activeMetadata = options.metadata;
    lastError = undefined;
    (0, wasapi_capture_1.startWasapiCapture)(options.outputPath)
        .then(() => {
        console.log(`[recorder] WASAPI capture started → ${options.outputPath}`);
    })
        .catch((err) => {
        handleError(err.message);
    });
}
/**
 * Stop the active recording. Returns a promise that resolves once the webm
 * chunks have been flushed and transcoded to wav. The wav path is returned
 * in RecordingStopResult.outputPath.
 */
async function stopRecording() {
    const snapshot = {
        outputPath: activeOutputPath || '',
        metadata: activeMetadata,
    };
    if (!(0, wasapi_capture_1.isWasapiRecording)()) {
        clearRecordingState();
        return { ...snapshot, ...(lastError ? { error: lastError } : {}) };
    }
    try {
        const wavPath = await (0, wasapi_capture_1.stopWasapiCapture)();
        clearRecordingState();
        return { outputPath: wavPath, metadata: snapshot.metadata };
    }
    catch (err) {
        const message = err.message;
        handleError(message);
        return { ...snapshot, error: message };
    }
}
function isRecording() {
    return (0, wasapi_capture_1.isWasapiRecording)();
}
function getRecordingStatus() {
    if (!(0, wasapi_capture_1.isWasapiRecording)()) {
        return { recording: false, error: lastError };
    }
    return {
        recording: true,
        meetingTitle: activeMeetingTitle,
        startedAt: recordingStartedAt ?? undefined,
    };
}
//# sourceMappingURL=recorder.js.map