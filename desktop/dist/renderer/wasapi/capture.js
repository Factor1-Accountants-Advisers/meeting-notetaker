"use strict";
/**
 * Capture script for the hidden wasapi window.
 *
 * Lifecycle:
 *   main → 'wasapi:start'  → grab display + mic streams, mix via Web Audio,
 *                             start MediaRecorder, emit 'wasapi:started'
 *   (data)                 → stream webm chunks back as 'wasapi:chunk'
 *   main → 'wasapi:stop'   → stop recorder; 'wasapi:done' after final flush
 *
 * Anything thrown before the final flush is surfaced as 'wasapi:error'.
 *
 * This file must remain a non-module script: renderer tsconfig emits CommonJS,
 * and the browser context loading via <script src> can't handle CommonJS's
 * `exports` reference. Global types live in ./global.d.ts (ambient).
 */
let mediaRecorder = null;
let displayStream = null;
let micStream = null;
let audioContext = null;
async function startCapture() {
    try {
        // System audio. Video track is required by the spec; we stop it immediately.
        displayStream = await navigator.mediaDevices.getDisplayMedia({
            audio: true,
            video: true,
        });
        const videoTrack = displayStream.getVideoTracks()[0];
        if (videoTrack)
            videoTrack.stop();
        // Microphone (Windows default input)
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const sysAudioTracks = displayStream.getAudioTracks();
        if (sysAudioTracks.length === 0) {
            throw new Error('System audio was not captured. On Windows, check Sound Settings → ' +
                '"Allow apps to take exclusive control" and disable it for the default playback device.');
        }
        // Mix mic + system audio into one stream via Web Audio
        audioContext = new AudioContext();
        const dest = audioContext.createMediaStreamDestination();
        audioContext.createMediaStreamSource(displayStream).connect(dest);
        audioContext.createMediaStreamSource(micStream).connect(dest);
        mediaRecorder = new MediaRecorder(dest.stream, {
            mimeType: 'audio/webm;codecs=opus',
        });
        mediaRecorder.addEventListener('dataavailable', async (e) => {
            if (e.data.size === 0)
                return;
            const buffer = await e.data.arrayBuffer();
            window.wasapiAPI.chunk(new Uint8Array(buffer));
        });
        mediaRecorder.addEventListener('stop', () => {
            cleanup();
            window.wasapiAPI.done();
        });
        mediaRecorder.addEventListener('error', (e) => {
            const message = e?.error?.message ?? 'MediaRecorder error';
            window.wasapiAPI.error(message);
        });
        // 1-second chunks keep memory usage bounded and let us stream to disk
        mediaRecorder.start(1000);
        window.wasapiAPI.started();
        console.log('[wasapi:renderer] capture started');
    }
    catch (err) {
        console.error('[wasapi:renderer] startCapture failed:', err);
        cleanup();
        window.wasapiAPI.error(err.message || String(err));
    }
}
function stopCapture() {
    try {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop(); // triggers 'stop' handler → cleanup + done
        }
        else {
            cleanup();
            window.wasapiAPI.done();
        }
    }
    catch (err) {
        console.error('[wasapi:renderer] stopCapture failed:', err);
        window.wasapiAPI.error(err.message || String(err));
    }
}
function cleanup() {
    mediaRecorder = null;
    displayStream?.getTracks().forEach((t) => t.stop());
    displayStream = null;
    micStream?.getTracks().forEach((t) => t.stop());
    micStream = null;
    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close().catch(() => undefined);
    }
    audioContext = null;
}
window.wasapiAPI.onStart(() => void startCapture());
window.wasapiAPI.onStop(() => stopCapture());
console.log('[wasapi:renderer] capture.ts ready');
//# sourceMappingURL=capture.js.map