import { getUpcomingMeetings, CalendarEvent } from '../src/main/graph';
jest.mock('axios');
import axios from 'axios';
const mockGet = axios.get as jest.MockedFunction<typeof axios.get>;

describe('graph.getUpcomingMeetings', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns mapped CalendarEvent array', async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        value: [{
          id: 'evt1', subject: 'Sprint Review',
          start: { dateTime: '2026-03-20T09:00:00' },
          end: { dateTime: '2026-03-20T10:00:00' },
          attendees: [{ emailAddress: { name: 'Alice', address: 'alice@firm.com' } }],
        }],
      },
    });
    const events = await getUpcomingMeetings('mock-token');
    expect(mockGet).toHaveBeenCalledWith(
      expect.stringContaining('/me/calendarView'),
      expect.objectContaining({ headers: { Authorization: 'Bearer mock-token' } })
    );
    expect(events[0]).toMatchObject<CalendarEvent>({
      id: 'evt1', subject: 'Sprint Review',
      start: '2026-03-20T09:00:00Z', end: '2026-03-20T10:00:00Z',
      attendees: [{ name: 'Alice', email: 'alice@firm.com' }],
    });
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
