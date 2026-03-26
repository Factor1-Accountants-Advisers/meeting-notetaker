// Types re-declared here to avoid cross-rootDir import; must stay in sync with src/main/graph.ts
interface CalendarAttendee {
  name: string;
  email: string;
}

interface CalendarEvent {
  id: string;
  subject: string;
  start: string;
  end: string;
  attendees: CalendarAttendee[];
}

// Script file (no import/export) — declarations are global by default
interface Window {
  meetingSelector: {
    getCalendar: () => Promise<CalendarEvent[]>;
    selectMeeting: (event: CalendarEvent) => Promise<void>;
    closeWindow: () => void;
  };
}

function buildEventItem(evt: CalendarEvent): HTMLLIElement {
  const li = document.createElement('li');
  const time = new Date(evt.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const names = evt.attendees.map((a) => a.name).join(', ') || 'No attendees';

  const titleDiv = document.createElement('div');
  titleDiv.className = 'evt-title';
  titleDiv.textContent = evt.subject;

  const metaDiv = document.createElement('div');
  metaDiv.className = 'evt-meta';
  metaDiv.textContent = `${time} · ${names}`;

  li.appendChild(titleDiv);
  li.appendChild(metaDiv);
  li.addEventListener('click', () => window.meetingSelector.selectMeeting(evt));
  return li;
}

async function loadCalendar(): Promise<void> {
  const loadingEl = document.getElementById('loading')!;
  const listEl = document.getElementById('meeting-list')!;
  const errorEl = document.getElementById('error')!;

  // Reset UI safely
  loadingEl.hidden = false;
  listEl.hidden = true;
  while (listEl.firstChild) {
    listEl.removeChild(listEl.firstChild);
  }
  errorEl.hidden = true;

  try {
    const events = await window.meetingSelector.getCalendar();
    loadingEl.hidden = true;

    if (events.length === 0) {
      errorEl.textContent = 'No upcoming meetings in the next 8 hours.';
      errorEl.hidden = false;
      return;
    }

    for (const evt of events) {
      listEl.appendChild(buildEventItem(evt));
    }
    listEl.hidden = false;
  } catch (err: unknown) {
    loadingEl.hidden = true;
    errorEl.textContent = `Failed to load calendar: ${err instanceof Error ? err.message : String(err)}`;
    errorEl.hidden = false;
  }
}

function init(): void {
  document.getElementById('btn-skip')!.addEventListener('click', () =>
    window.meetingSelector.closeWindow()
  );

  document.getElementById('btn-refresh')!.addEventListener('click', () =>
    loadCalendar()
  );

  loadCalendar();
}

init();
