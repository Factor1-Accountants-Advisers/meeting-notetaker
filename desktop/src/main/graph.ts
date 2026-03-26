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

export async function getUpcomingMeetings(accessToken: string): Promise<CalendarEvent[]> {
  const now = new Date();
  const params = new URLSearchParams({
    startDateTime: now.toISOString(),
    endDateTime: new Date(now.getTime() + 8 * 3600000).toISOString(),
    $select: 'id,subject,start,end,attendees',
    $top: '20',
    $orderby: 'start/dateTime asc',
  });
  const response = await axios.get(`${GRAPH_BASE}/me/calendarView?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (response.data.value as any[]).map((evt) => ({
    id: evt.id as string,
    subject: evt.subject as string,
    start: evt.start.dateTime as string,
    end: evt.end.dateTime as string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attendees: (evt.attendees ?? []).map((a: any) => ({
      name: (a.emailAddress?.name as string) ?? '',
      email: (a.emailAddress?.address as string) ?? '',
    })),
  }));
}
