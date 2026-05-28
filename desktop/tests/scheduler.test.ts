const mockNotificationShow = jest.fn();
const mockNotificationClose = jest.fn();
const mockNotificationOn = jest.fn();

jest.mock('electron', () => ({
  Notification: jest.fn().mockImplementation(() => ({
    show: mockNotificationShow,
    close: mockNotificationClose,
    on: mockNotificationOn,
  })),
}));

jest.mock('../src/main/auth', () => ({
  acquireToken: jest.fn().mockResolvedValue('mock-token'),
}));

const mockGetUpcomingMeetings = jest.fn().mockResolvedValue([]);
jest.mock('../src/main/graph', () => ({
  getUpcomingMeetings: (...args: unknown[]) => mockGetUpcomingMeetings(...args),
}));

const mockSetPendingMeeting = jest.fn();
const mockHandleStartRecording = jest.fn();
jest.mock('../src/main/tray', () => ({
  setPendingMeeting: (...args: unknown[]) => mockSetPendingMeeting(...args),
  handleStartRecording: (...args: unknown[]) => mockHandleStartRecording(...args),
}));

const mockIsRecording = jest.fn(() => false);
jest.mock('../src/main/recorder', () => ({
  isRecording: () => mockIsRecording(),
}));

import { startScheduler, stopScheduler, dismissAutoRecord } from '../src/main/scheduler';
import { CalendarEvent } from '../src/main/graph';
import { Notification } from 'electron';

function makeEvent(overrides: Partial<CalendarEvent> & { start: string; end: string }): CalendarEvent {
  return {
    id: 'evt-1',
    subject: 'Team Standup',
    attendees: [{ name: 'Alice', email: 'alice@test.com' }],
    ...overrides,
  };
}

describe('scheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockIsRecording.mockReturnValue(false);
    mockGetUpcomingMeetings.mockResolvedValue([]);
  });

  afterEach(() => {
    stopScheduler();
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('polls the calendar on startup and schedules upcoming meeting notifications', async () => {
    const now = Date.now();
    const inFiveMin = new Date(now + 5 * 60_000).toISOString();
    const inOneHour = new Date(now + 60 * 60_000).toISOString();

    mockGetUpcomingMeetings.mockResolvedValue([
      makeEvent({ id: 'evt-near', start: inFiveMin, end: inOneHour }),
    ]);

    startScheduler();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockGetUpcomingMeetings).toHaveBeenCalledWith('mock-token');

    await jest.advanceTimersByTimeAsync(5 * 60_000);

    expect(Notification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Meeting Starting',
        body: expect.stringContaining('Team Standup'),
      }),
    );
    expect(mockNotificationShow).toHaveBeenCalled();
  });

  it('does not auto-start recording after notifying about an already-started meeting', async () => {
    const now = Date.now();
    const justNow = new Date(now - 1000).toISOString();
    const inOneHour = new Date(now + 60 * 60_000).toISOString();

    mockGetUpcomingMeetings.mockResolvedValueOnce([
      makeEvent({ start: justNow, end: inOneHour }),
    ]);

    startScheduler();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockNotificationShow).toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(30_000);

    expect(mockSetPendingMeeting).not.toHaveBeenCalled();
    expect(mockHandleStartRecording).not.toHaveBeenCalled();
  });

  it('opens no app/settings flow from background scheduler notifications', async () => {
    const now = Date.now();
    const justNow = new Date(now - 1000).toISOString();
    const inOneHour = new Date(now + 60 * 60_000).toISOString();

    mockGetUpcomingMeetings.mockResolvedValueOnce([
      makeEvent({ start: justNow, end: inOneHour }),
    ]);

    startScheduler();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(30_000);

    expect(mockHandleStartRecording).not.toHaveBeenCalled();
    expect(mockSetPendingMeeting).not.toHaveBeenCalled();
  });

  it('skips notifications when already recording', async () => {
    mockIsRecording.mockReturnValue(true);
    const now = Date.now();
    const justNow = new Date(now - 1000).toISOString();
    const inOneHour = new Date(now + 60 * 60_000).toISOString();

    mockGetUpcomingMeetings.mockResolvedValueOnce([
      makeEvent({ start: justNow, end: inOneHour }),
    ]);

    startScheduler();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockNotificationShow).not.toHaveBeenCalled();
    expect(mockHandleStartRecording).not.toHaveBeenCalled();
  });

  it('skips meetings that have already ended', async () => {
    const now = Date.now();
    const pastStart = new Date(now - 60 * 60_000).toISOString();
    const pastEnd = new Date(now - 1000).toISOString();

    mockGetUpcomingMeetings.mockResolvedValueOnce([
      makeEvent({ start: pastStart, end: pastEnd }),
    ]);

    startScheduler();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockNotificationShow).not.toHaveBeenCalled();
  });

  it('dismissAutoRecord cancels the current notification without starting recording', async () => {
    const now = Date.now();
    const justNow = new Date(now - 1000).toISOString();
    const inOneHour = new Date(now + 60 * 60_000).toISOString();

    mockGetUpcomingMeetings.mockResolvedValueOnce([
      makeEvent({ start: justNow, end: inOneHour }),
    ]);

    startScheduler();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockNotificationShow).toHaveBeenCalled();

    dismissAutoRecord();
    await jest.advanceTimersByTimeAsync(30_000);

    expect(mockHandleStartRecording).not.toHaveBeenCalled();
    expect(mockNotificationClose).toHaveBeenCalled();
  });

  it('does not re-trigger for the same event after a calendar refresh', async () => {
    const now = Date.now();
    const justNow = new Date(now - 1000).toISOString();
    const inOneHour = new Date(now + 60 * 60_000).toISOString();
    const event = makeEvent({ start: justNow, end: inOneHour });

    mockGetUpcomingMeetings.mockResolvedValue([event]);

    startScheduler();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockNotificationShow).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(5 * 60_000);

    expect(mockNotificationShow).toHaveBeenCalledTimes(1);
    expect(mockHandleStartRecording).not.toHaveBeenCalled();
  });
});
