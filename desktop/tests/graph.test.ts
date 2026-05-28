import { getUpcomingMeetings, CalendarEvent } from '../src/main/graph';
jest.mock('axios');
import axios from 'axios';
const mockGet = axios.get as jest.MockedFunction<typeof axios.get>;

describe('graph.getUpcomingMeetings', () => {
  beforeEach(() => jest.clearAllMocks());

  it('requests Graph calendar times in UTC and maps CalendarEvent array', async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        value: [{
          id: 'evt1', subject: 'Sprint Review',
          start: { dateTime: '2026-03-20T09:00:00', timeZone: 'UTC' },
          end: { dateTime: '2026-03-20T10:00:00', timeZone: 'UTC' },
          attendees: [{ emailAddress: { name: 'Alice', address: 'alice@firm.com' } }],
          isCancelled: false,
          isAllDay: false,
          showAs: 'busy',
          isOnlineMeeting: true,
        }],
      },
    });
    const events = await getUpcomingMeetings('mock-token');
    expect(mockGet).toHaveBeenCalledWith(
      expect.stringContaining('/me/calendarView'),
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer mock-token',
          Prefer: 'outlook.timezone="UTC"',
        },
      })
    );
    expect(mockGet.mock.calls[0][0]).toContain('isCancelled%2CisAllDay%2CshowAs%2Ctype%2CisOnlineMeeting%2ConlineMeeting%2Corganizer%2Cattendees');
    expect(events[0]).toMatchObject<CalendarEvent>({
      id: 'evt1', subject: 'Sprint Review',
      start: '2026-03-20T09:00:00Z', end: '2026-03-20T10:00:00Z',
      attendees: [{ name: 'Alice', email: 'alice@firm.com' }],
    });
  });

  it('does not double-append UTC suffix when Graph returns an ISO timestamp with timezone', async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        value: [{
          id: 'evt1', subject: 'Sprint Review',
          start: { dateTime: '2026-03-20T09:00:00Z', timeZone: 'UTC' },
          end: { dateTime: '2026-03-20T10:00:00+00:00', timeZone: 'UTC' },
          attendees: [],
          isCancelled: false,
          isAllDay: false,
          showAs: 'busy',
          isOnlineMeeting: true,
        }],
      },
    });

    const events = await getUpcomingMeetings('mock-token');

    expect(events[0].start).toBe('2026-03-20T09:00:00Z');
    expect(events[0].end).toBe('2026-03-20T10:00:00+00:00');
  });

  it('filters cancelled, all-day, free, and tentative non-online calendar entries', async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        value: [
          { id: 'cancelled', subject: 'Cancelled', start: { dateTime: '2026-03-20T09:00:00' }, end: { dateTime: '2026-03-20T10:00:00' }, attendees: [], isCancelled: true, isAllDay: false, showAs: 'busy', isOnlineMeeting: true },
          { id: 'allday', subject: 'Holiday', start: { dateTime: '2026-03-20T00:00:00' }, end: { dateTime: '2026-03-21T00:00:00' }, attendees: [], isCancelled: false, isAllDay: true, showAs: 'busy', isOnlineMeeting: false },
          { id: 'free', subject: 'FYI', start: { dateTime: '2026-03-20T11:00:00' }, end: { dateTime: '2026-03-20T12:00:00' }, attendees: [], isCancelled: false, isAllDay: false, showAs: 'free', isOnlineMeeting: false },
          { id: 'tentative-placeholder', subject: 'Maybe', start: { dateTime: '2026-03-20T13:00:00' }, end: { dateTime: '2026-03-20T14:00:00' }, attendees: [], isCancelled: false, isAllDay: false, showAs: 'tentative', isOnlineMeeting: false },
          { id: 'teams', subject: 'Teams call', start: { dateTime: '2026-03-20T15:00:00' }, end: { dateTime: '2026-03-20T16:00:00' }, attendees: [], isCancelled: false, isAllDay: false, showAs: 'tentative', isOnlineMeeting: true },
        ],
      },
    });

    const events = await getUpcomingMeetings('mock-token');

    expect(events.map((event) => event.id)).toEqual(['teams']);
  });

  it('returns empty array when no events', async () => {
    mockGet.mockResolvedValueOnce({ data: { value: [] } });
    expect(await getUpcomingMeetings('t')).toEqual([]);
  });

  it('throws on network error', async () => {
    mockGet.mockRejectedValueOnce(new Error('Network Error'));
    await expect(getUpcomingMeetings('t')).rejects.toThrow('Network Error');
  });
});
