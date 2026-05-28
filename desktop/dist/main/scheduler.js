"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startScheduler = startScheduler;
exports.stopScheduler = stopScheduler;
exports.dismissAutoRecord = dismissAutoRecord;
/**
 * Calendar-based auto-record scheduler.
 *
 * Polls the user's Outlook calendar and shows a notification when a meeting starts.
 * The scheduler does not auto-start recording or open the app from the background.
 */
const electron_1 = require("electron");
const auth_1 = require("./auth");
const graph_1 = require("./graph");
const recorder_1 = require("./recorder");
const POLL_INTERVAL_MS = 5 * 60000; // Refresh calendar every 5 minutes
const SCHEDULE_HORIZON_MS = 10 * 60000; // Only set timers for meetings within 10 minutes
/** Active timers keyed by calendar event ID */
const pendingTimers = new Map();
/** Events we've already started (or dismissed) — avoid re-triggering on refresh */
const handledEvents = new Set();
let pollTimer = null;
let activeNotification = null;
function startScheduler() {
    console.log('[scheduler] Starting calendar auto-record scheduler');
    // Run immediately, then on interval
    void pollCalendar();
    pollTimer = setInterval(() => void pollCalendar(), POLL_INTERVAL_MS);
}
function stopScheduler() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    for (const timer of pendingTimers.values()) {
        clearTimeout(timer);
    }
    pendingTimers.clear();
    handledEvents.clear();
    cancelGracePeriod();
    console.log('[scheduler] Stopped');
}
async function pollCalendar() {
    try {
        const token = await (0, auth_1.acquireToken)();
        const events = await (0, graph_1.getUpcomingMeetings)(token);
        scheduleUpcoming(events);
    }
    catch (err) {
        console.warn('[scheduler] Calendar poll failed:', err);
    }
}
function scheduleUpcoming(events) {
    const now = Date.now();
    // Clear timers for events that no longer exist in the calendar
    for (const [eventId, timer] of pendingTimers) {
        if (!events.some((e) => e.id === eventId)) {
            clearTimeout(timer);
            pendingTimers.delete(eventId);
        }
    }
    for (const event of events) {
        if (handledEvents.has(event.id))
            continue;
        if (pendingTimers.has(event.id))
            continue;
        const startMs = new Date(event.start).getTime();
        const delayMs = startMs - now;
        // Skip meetings that already ended
        const endMs = new Date(event.end).getTime();
        if (endMs <= now)
            continue;
        // Meeting already started (app launched mid-meeting) — trigger immediately
        if (delayMs <= 0) {
            console.log(`[scheduler] Meeting "${event.subject}" already started — notifying now`);
            notifyMeetingStarting(event);
            continue;
        }
        // Only set timers for meetings within the schedule horizon
        if (delayMs > SCHEDULE_HORIZON_MS)
            continue;
        console.log(`[scheduler] Scheduling "${event.subject}" in ${Math.round(delayMs / 1000)}s`);
        const timer = setTimeout(() => {
            pendingTimers.delete(event.id);
            notifyMeetingStarting(event);
        }, delayMs);
        pendingTimers.set(event.id, timer);
    }
}
function notifyMeetingStarting(event) {
    if (handledEvents.has(event.id))
        return;
    handledEvents.add(event.id);
    if ((0, recorder_1.isRecording)()) {
        console.log(`[scheduler] Already recording — skipping meeting notification for "${event.subject}"`);
        return;
    }
    console.log(`[scheduler] Notifying user that "${event.subject}" is starting; auto-record is disabled`);
    activeNotification?.close();
    activeNotification = new electron_1.Notification({
        title: 'Meeting Starting',
        body: `"${event.subject}" is starting. Open Notetaker from the tray if you want to record.`,
        silent: false,
    });
    activeNotification.on('click', () => {
        console.log(`[scheduler] User dismissed meeting notification for "${event.subject}"`);
        cancelGracePeriod();
    });
    activeNotification.show();
}
/** Dismiss the current scheduler notification (callable from renderer via IPC). */
function dismissAutoRecord() {
    cancelGracePeriod();
}
function cancelGracePeriod() {
    if (activeNotification) {
        activeNotification.close();
        activeNotification = null;
    }
}
//# sourceMappingURL=scheduler.js.map