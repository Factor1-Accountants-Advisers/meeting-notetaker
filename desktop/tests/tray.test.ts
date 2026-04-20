const mockSetToolTip = jest.fn();
const mockSetContextMenu = jest.fn();
const mockSetImage = jest.fn();
const mockTrayOn = jest.fn();
const mockBuildFromTemplate = jest.fn((template) => template);

jest.mock('electron', () => ({
  Tray: jest.fn().mockImplementation(() => ({
    setToolTip: mockSetToolTip,
    setContextMenu: mockSetContextMenu,
    setImage: mockSetImage,
    on: mockTrayOn,
  })),
  Menu: {
    buildFromTemplate: mockBuildFromTemplate,
  },
  app: {
    quit: jest.fn(),
  },
  nativeImage: {
    createFromPath: jest.fn((value: string) => value),
  },
  BrowserWindow: jest.fn(),
}));

jest.mock('../src/main/index', () => ({
  getMainWindow: jest.fn(() => null),
}));

jest.mock('../src/main/auth', () => ({
  acquireToken: jest.fn(),
  acquireIdToken: jest.fn(),
}));

jest.mock('../src/main/recorder', () => ({
  startRecording: jest.fn(),
  stopRecording: jest.fn(),
  isRecording: jest.fn(() => false),
  getRecordingStatus: jest.fn(() => ({ recording: false })),
}));

jest.mock('../src/main/uploader', () => ({
  uploadRecording: jest.fn(),
}));

import { createTray, setPendingMeeting } from '../src/main/tray';
import { acquireIdToken } from '../src/main/auth';
import { startRecording, stopRecording } from '../src/main/recorder';
import { uploadRecording } from '../src/main/uploader';

const TEST_BACKEND_URL = 'http://localhost:8000';

describe('tray recording flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('uploads the shared recorder session metadata with an ID token', async () => {
    (acquireIdToken as jest.Mock).mockResolvedValue('id-token-123');
    (stopRecording as jest.Mock).mockReturnValue({
      outputPath: 'C:/tmp/meeting.wav',
      metadata: {
        meeting_title: 'Original Meeting',
        attendees: [{ name: 'Alice', email: 'alice@example.com' }],
        scheduled_time: '2026-03-30T03:00:00Z',
      },
    });

    createTray({
      backendUrl: 'http://localhost:8000',
      recordingOutputDir: 'C:/tmp',
      micName: 'Mic',
      loopbackName: 'Loop',
      onOpenApp: jest.fn(),
    });

    setPendingMeeting('Original Meeting', [{ name: 'Alice', email: 'alice@example.com' }], '2026-03-30T03:00:00Z');
    const startTemplate = mockBuildFromTemplate.mock.calls.at(-1)?.[0];
    await startTemplate.find((item: { label: string }) => item.label === 'Start Recording').click();

    expect(startRecording).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          meeting_title: 'Original Meeting',
          attendees: [{ name: 'Alice', email: 'alice@example.com' }],
          scheduled_time: '2026-03-30T03:00:00Z',
        },
      })
    );

    setPendingMeeting('New Meeting', [{ name: 'Bob', email: 'bob@example.com' }], '2026-03-30T04:00:00Z');
    const stopTemplate = mockBuildFromTemplate.mock.calls.at(-1)?.[0];
    await stopTemplate.find((item: { label: string }) => item.label === 'Stop Recording').click();
    jest.runOnlyPendingTimers();

    expect(acquireIdToken).toHaveBeenCalled();
    expect(uploadRecording).toHaveBeenCalledWith({
      filePath: 'C:/tmp/meeting.wav',
      accessToken: 'id-token-123',
      backendUrl: TEST_BACKEND_URL,
      metadata: {
        meeting_title: 'Original Meeting',
        attendees: [{ name: 'Alice', email: 'alice@example.com' }],
        scheduled_time: '2026-03-30T03:00:00Z',
      },
    });
  });
});
