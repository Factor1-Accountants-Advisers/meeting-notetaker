/**
 * Calendar-based auto-record scheduler.
 *
 * Polls the user's Outlook calendar and shows a notification when a meeting starts.
 * The scheduler does not auto-start recording or open the app from the background.
 */
import { Notification } from 'electron';
import { acquireToken } from './auth';
import { getUpcomingMeetings, CalendarEvent } from './graph';
import { isRecording } from './recorder';

const POLL_INTERVAL_MS = 5 * 60_000; // Refresh calendar every 5 minutes
const SCHEDULE_HORIZON_MS = 10 * 60_000; // Only set timers for meetings within 10 minutes

/** Active timers keyed by calendar event ID */
const pendingTimers = new Map<string, NodeJS.Timeout>();
/** Events we've already started (or dismissed) — avoid re-triggering on refresh */
const handledEvents = new Set<string>();

let pollTimer: NodeJS.Timeout | null = null;
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
      console.log(`[scheduler] Meeting "${event.subject}" already started — notifying now`);
      notifyMeetingStarting(event);
      continue;
    }

    // Only set timers for meetings within the schedule horizon
    if (delayMs > SCHEDULE_HORIZON_MS) continue;

    console.log(`[scheduler] Scheduling "${event.subject}" in ${Math.round(delayMs / 1000)}s`);
    const timer = setTimeout(() => {
      pendingTimers.delete(event.id);
      notifyMeetingStarting(event);
    }, delayMs);
    pendingTimers.set(event.id, timer);
  }
}

function notifyMeetingStarting(event: CalendarEvent): void {
  if (handledEvents.has(event.id)) return;
  handledEvents.add(event.id);

  if (isRecording()) {
    console.log(`[scheduler] Already recording — skipping meeting notification for "${event.subject}"`);
    return;
  }

  console.log(`[scheduler] Notifying user that "${event.subject}" is starting; auto-record is disabled`);

  activeNotification?.close();
  activeNotification = new Notification({
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
export function dismissAutoRecord(): void {
  cancelGracePeriod();
}

function cancelGracePeriod(): void {
  if (activeNotification) {
    activeNotification.close();
    activeNotification = null;
  }
}
