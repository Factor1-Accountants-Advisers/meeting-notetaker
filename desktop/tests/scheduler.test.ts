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

  it('polls the calendar on startup and schedules upcoming meetings', async () => {
    const now = Date.now();
    const inFiveMin = new Date(now + 5 * 60_000).toISOString();
    const inOneHour = new Date(now + 60 * 60_000).toISOString();

    // Use mockResolvedValue (not Once) so repeat polls still return the event
    mockGetUpcomingMeetings.mockResolvedValue([
      makeEvent({ id: 'evt-near', start: inFiveMin, end: inOneHour }),
    ]);

    startScheduler();
    // Let the async poll complete
    await jest.advanceTimersByTimeAsync(0);

    expect(mockGetUpcomingMeetings).toHaveBeenCalledWith('mock-token');

    // Advance to meeting start time — should trigger notification
    await jest.advanceTimersByTimeAsync(5 * 60_000);

    expect(Notification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Auto-Record Starting',
        body: expect.stringContaining('Team Standup'),
      }),
    );
    expect(mockNotificationShow).toHaveBeenCalled();
  });

  it('auto-starts recording after the 30-second grace period', async () => {
    const now = Date.now();
    const justNow = new Date(now - 1000).toISOString(); // meeting already started
    const inOneHour = new Date(now + 60 * 60_000).toISOString();

    mockGetUpcomingMeetings.mockResolvedValueOnce([
      makeEvent({ start: justNow, end: inOneHour }),
    ]);

    startScheduler();
    await jest.advanceTimersByTimeAsync(0);

    // Notification shown immediately for already-started meeting
    expect(mockNotificationShow).toHaveBeenCalled();

    // Advance through grace period
    await jest.advanceTimersByTimeAsync(30_000);

    expect(mockSetPendingMeeting).toHaveBeenCalledWith(
      'Team Standup',
      [{ name: 'Alice', email: 'alice@test.com' }],
      justNow,
    );
    expect(mockHandleStartRecording).toHaveBeenCalled();
  });

  it('does not start recording when user dismisses the notification', async () => {
    const now = Date.now();
    const justNow = new Date(now - 1000).toISOString();
    const inOneHour = new Date(now + 60 * 60_000).toISOString();

    mockGetUpcomingMeetings.mockResolvedValueOnce([
      makeEvent({ start: justNow, end: inOneHour }),
    ]);

    startScheduler();
    await jest.advanceTimersByTimeAsync(0);

    // Simulate user clicking the notification (dismiss)
    const clickHandler = mockNotificationOn.mock.calls.find(
      ([event]: [string]) => event === 'click',
    )?.[1];
    expect(clickHandler).toBeDefined();
    clickHandler();

    // Advance past grace period
    await jest.advanceTimersByTimeAsync(30_000);

    expect(mockHandleStartRecording).not.toHaveBeenCalled();
  });

  it('skips auto-record when already recording', async () => {
    mockIsRecording.mockReturnValue(true);
    const now = Date.now();
    const justNow = new Date(now - 1000).toISOString();
    const inOneHour = new Date(now + 60 * 60_000).toISOString();

    mockGetUpcomingMeetings.mockResolvedValueOnce([
      makeEvent({ start: justNow, end: inOneHour }),
    ]);

    startScheduler();
    await jest.advanceTimersByTimeAsync(0);

    // Should not show notification when already recording
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

  it('dismissAutoRecord cancels the grace period from IPC', async () => {
    const now = Date.now();
    const justNow = new Date(now - 1000).toISOString();
    const inOneHour = new Date(now + 60 * 60_000).toISOString();

    mockGetUpcomingMeetings.mockResolvedValueOnce([
      makeEvent({ start: justNow, end: inOneHour }),
    ]);

    startScheduler();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockNotificationShow).toHaveBeenCalled();

    // Dismiss via IPC
    dismissAutoRecord();

    // Advance past grace period
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

    // Grace period triggers, let it auto-start
    await jest.advanceTimersByTimeAsync(30_000);
    expect(mockHandleStartRecording).toHaveBeenCalledTimes(1);

    // Simulate next poll cycle (5 minutes)
    await jest.advanceTimersByTimeAsync(5 * 60_000);

    // Should NOT trigger again for the same event
    expect(mockHandleStartRecording).toHaveBeenCalledTimes(1);
  });
});
