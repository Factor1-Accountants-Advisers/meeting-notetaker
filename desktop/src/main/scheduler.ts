/**
 * Calendar-based auto-record scheduler.
 *
 * Polls the user's Outlook calendar and sets timers for upcoming meetings.
 * At meeting start time, shows a 30-second grace period notification.
 * If the user doesn't dismiss it, recording starts automatically.
 */
import { Notification } from 'electron';
import { acquireToken } from './auth';
import { getUpcomingMeetings, CalendarEvent } from './graph';
import { setPendingMeeting, handleStartRecording } from './tray';
import { isRecording } from './recorder';

const GRACE_PERIOD_MS = 30_000;
const POLL_INTERVAL_MS = 5 * 60_000; // Refresh calendar every 5 minutes
const SCHEDULE_HORIZON_MS = 10 * 60_000; // Only set timers for meetings within 10 minutes

/** Active timers keyed by calendar event ID */
const pendingTimers = new Map<string, NodeJS.Timeout>();
/** Events we've already started (or dismissed) — avoid re-triggering on refresh */
const handledEvents = new Set<string>();

let pollTimer: NodeJS.Timeout | null = null;
let graceTimer: NodeJS.Timeout | null = null;
let activeNotification: Notification | null = null;

export function startScheduler(): void {
  console.log('[scheduler] Starting calendar auto-record scheduler');
  // Run immediately, then on interval
  void pollCalendar();
  pollTimer = setInterval(() => void pollCalendar(), POLL_INTERVAL_MS);
}

export function stopScheduler(): void {
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

async function pollCalendar(): Promise<void> {
  try {
    const token = await acquireToken();
    const events = await getUpcomingMeetings(token);
    scheduleUpcoming(events);
  } catch (err) {
    console.warn('[scheduler] Calendar poll failed:', err);
  }
}

function scheduleUpcoming(events: CalendarEvent[]): void {
  const now = Date.now();

  // Clear timers for events that no longer exist in the calendar
  for (const [eventId, timer] of pendingTimers) {
    if (!events.some((e) => e.id === eventId)) {
      clearTimeout(timer);
      pendingTimers.delete(eventId);
    }
  }

  for (const event of events) {
    if (handledEvents.has(event.id)) continue;
    if (pendingTimers.has(event.id)) continue;

    const startMs = new Date(event.start).getTime();
    const delayMs = startMs - now;

    // Skip meetings that already ended
    const endMs = new Date(event.end).getTime();
    if (endMs <= now) continue;

    // Meeting already started (app launched mid-meeting) — trigger immediately
    if (delayMs <= 0) {
      console.log(`[scheduler] Meeting "${event.subject}" already started — triggering now`);
      triggerGracePeriod(event);
      continue;
    }

    // Only set timers for meetings within the schedule horizon
    if (delayMs > SCHEDULE_HORIZON_MS) continue;

    console.log(`[scheduler] Scheduling "${event.subject}" in ${Math.round(delayMs / 1000)}s`);
    const timer = setTimeout(() => {
      pendingTimers.delete(event.id);
      triggerGracePeriod(event);
    }, delayMs);
    pendingTimers.set(event.id, timer);
  }
}

function triggerGracePeriod(event: CalendarEvent): void {
  if (handledEvents.has(event.id)) return;
  handledEvents.add(event.id);

  // Don't auto-record if already recording
  if (isRecording()) {
    console.log(`[scheduler] Already recording — skipping auto-record for "${event.subject}"`);
    return;
  }

  console.log(`[scheduler] Grace period started for "${event.subject}" (${GRACE_PERIOD_MS / 1000}s)`);

  // Show notification
  activeNotification = new Notification({
    title: 'Auto-Record Starting',
    body: `"${event.subject}" — recording will begin in 30 seconds. Click to dismiss.`,
    silent: false,
  });

  activeNotification.on('click', () => {
    console.log(`[scheduler] User dismissed auto-record for "${event.subject}"`);
    cancelGracePeriod();
  });

  activeNotification.show();

  // Set grace period timer
  graceTimer = setTimeout(() => {
    graceTimer = null;
    activeNotification?.close();
    activeNotification = null;
    autoStartRecording(event);
  }, GRACE_PERIOD_MS);
}

/** Dismiss the current grace period notification (callable from renderer via IPC). */
export function dismissAutoRecord(): void {
  if (graceTimer) {
    console.log('[scheduler] Auto-record dismissed via IPC');
    cancelGracePeriod();
  }
}

function cancelGracePeriod(): void {
  if (graceTimer) {
    clearTimeout(graceTimer);
    graceTimer = null;
  }
  if (activeNotification) {
    activeNotification.close();
    activeNotification = null;
  }
}

function autoStartRecording(event: CalendarEvent): void {
  if (isRecording()) {
    console.log(`[scheduler] Already recording — skipping auto-start for "${event.subject}"`);
    return;
  }

  console.log(`[scheduler] Auto-starting recording for "${event.subject}"`);

  // Set meeting metadata so the tray's start handler uses it
  setPendingMeeting(
    event.subject,
    event.attendees,
    event.start,
  );

  handleStartRecording();
}
