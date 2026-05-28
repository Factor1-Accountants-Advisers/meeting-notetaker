import axios from 'axios';

export interface CalendarAttendee {
  name: string;
  email: string;
}

export interface CalendarEvent {
  id: string;
  subject: string;
  start: string;
  end: string;
  attendees: CalendarAttendee[];
}

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_SELECT_FIELDS = [
  'id',
  'subject',
  'start',
  'end',
  'isCancelled',
  'isAllDay',
  'showAs',
  'type',
  'isOnlineMeeting',
  'onlineMeeting',
  'organizer',
  'attendees',
].join(',');

function asUtcInstant(dateTime: string): string {
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(dateTime)) return dateTime;
  return `${dateTime}Z`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function shouldIncludeEvent(evt: any): boolean {
  if (evt.isCancelled) {
    console.log(`[graph] Excluding cancelled event ${evt.id ?? '(unknown)'}`);
    return false;
  }
  if (evt.isAllDay) {
    console.log(`[graph] Excluding all-day event ${evt.id ?? '(unknown)'}`);
    return false;
  }

  const showAs = typeof evt.showAs === 'string' ? evt.showAs.toLowerCase() : '';
  if (showAs === 'free' || showAs === 'oof' || showAs === 'workingElsewhere'.toLowerCase()) {
    console.log(`[graph] Excluding non-busy event ${evt.id ?? '(unknown)'} showAs=${showAs}`);
    return false;
  }

  const hasOnlineMeeting = Boolean(evt.isOnlineMeeting || evt.onlineMeeting);
  if (showAs === 'tentative' && !hasOnlineMeeting) {
    console.log(`[graph] Excluding tentative non-online event ${evt.id ?? '(unknown)'}`);
    return false;
  }

  return true;
}

export async function getUpcomingMeetings(accessToken: string): Promise<CalendarEvent[]> {
  const now = new Date();
  const params = new URLSearchParams({
    startDateTime: now.toISOString(),
    endDateTime: new Date(now.getTime() + 7 * 24 * 3600000).toISOString(),
    $select: GRAPH_SELECT_FIELDS,
    $top: '20',
    $orderby: 'start/dateTime asc',
  });
  const response = await axios.get(`${GRAPH_BASE}/me/calendarView?${params}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'outlook.timezone="UTC"',
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (response.data.value as any[])
    .filter(shouldIncludeEvent)
    .map((evt) => ({
      id: evt.id as string,
      subject: evt.subject as string,
      start: asUtcInstant(evt.start.dateTime as string),
      end: asUtcInstant(evt.end.dateTime as string),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      attendees: (evt.attendees ?? []).map((a: any) => ({
        name: (a.emailAddress?.name as string) ?? '',
        email: (a.emailAddress?.address as string) ?? '',
      })),
    }));
}
