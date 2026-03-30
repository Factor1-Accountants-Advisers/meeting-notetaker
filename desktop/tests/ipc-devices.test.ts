jest.mock('electron', () => ({
  ipcMain: {
    handle: jest.fn(),
    on: jest.fn(),
  },
  BrowserWindow: { fromWebContents: jest.fn() },
  shell: { openExternal: jest.fn() },
  app: {
    getVersion: jest.fn(() => '1.0.0'),
    requestSingleInstanceLock: jest.fn(() => true),
    quit: jest.fn(),
    disableHardwareAcceleration: jest.fn(),
    whenReady: jest.fn(() => ({ then: jest.fn() })),
    on: jest.fn(),
    getPath: jest.fn(() => '/tmp/test'),
    isPackaged: false,
  },
}));
jest.mock('../src/main/auth', () => ({
  acquireToken: jest.fn(),
  acquireIdToken: jest.fn(),
  clearTokenCache: jest.fn(),
}));
jest.mock('../src/main/graph', () => ({ getUpcomingMeetings: jest.fn() }));
jest.mock('../src/main/recorder', () => ({
  startRecording: jest.fn(),
  stopRecording: jest.fn(),
  isRecording: jest.fn(),
}));
jest.mock('../src/main/uploader', () => ({ uploadRecording: jest.fn() }));
jest.mock('../src/main/tray', () => ({ setPendingMeeting: jest.fn() }));
jest.mock('ffmpeg-static', () => 'C:\\ffmpeg\\ffmpeg.exe');
jest.mock('electron-updater', () => ({ autoUpdater: { checkForUpdatesAndNotify: jest.fn() } }));
jest.mock('../src/main/protocol', () => ({ registerAppProtocol: jest.fn() }));

import { ipcMain } from 'electron';
import { acquireIdToken } from '../src/main/auth';
import { uploadRecording } from '../src/main/uploader';

describe('audio:get-devices IPC handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('registers audio:get-devices handler', () => {
    require('../src/main/ipc').registerIpcHandlers();
    const handleCalls = (ipcMain.handle as jest.Mock).mock.calls;
    const channels = handleCalls.map((c: [string, Function]) => c[0]);
    expect(channels).toContain('audio:get-devices');
  });
});

describe('uploader:upload IPC handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the ID token for backend uploads', async () => {
    (acquireIdToken as jest.Mock).mockResolvedValue('id-token-123');
    (uploadRecording as jest.Mock).mockResolvedValue({ meeting_id: 7, status: 'processing' });

    require('../src/main/ipc').registerIpcHandlers();
    const handleCalls = (ipcMain.handle as jest.Mock).mock.calls;
    const uploadHandler = handleCalls.find((c: [string, Function]) => c[0] === 'uploader:upload')?.[1];

    const metadata = {
      meeting_title: 'Test',
      attendees: [{ name: 'Alice', email: 'alice@example.com' }],
    };

    await uploadHandler({}, { filePath: 'C:/tmp/test.wav', metadata });

    expect(acquireIdToken).toHaveBeenCalled();
    expect(uploadRecording).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: 'C:/tmp/test.wav',
        accessToken: 'id-token-123',
        metadata,
      })
    );
  });
});

describe('audio device parsing helpers', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('parses audio devices from ffmpeg dshow output that labels lines with (audio)', () => {
    const { parseAudioDevicesFromFfmpegOutput } = require('../src/main/ipc');

    const output = `
ffmpeg version 8.0
[dshow @ 000001] "HI556" (video)
[dshow @ 000001]   Alternative name "@device_pnp_video"
[dshow @ 000001] "Microphone Array (2- Realtek(R) Audio)" (audio)
[dshow @ 000001]   Alternative name "@device_cm_mic"
[dshow @ 000001] "CABLE Output (2- VB-Audio Virtual Cable)" (audio)
[dshow @ 000001]   Alternative name "@device_cm_cable"
Error opening input file dummy.
`;

    expect(parseAudioDevicesFromFfmpegOutput(output)).toEqual([
      {
        name: 'Microphone Array (2- Realtek(R) Audio)',
        id: 'Microphone Array (2- Realtek(R) Audio)',
      },
      {
        name: 'CABLE Output (2- VB-Audio Virtual Cable)',
        id: 'CABLE Output (2- VB-Audio Virtual Cable)',
      },
    ]);
  });

  it('does not choose an arbitrary non-microphone device as loopback when render name does not match', () => {
    const { selectDefaultAudioDevices } = require('../src/main/ipc');

    const devices = [
      { name: 'Microphone Array (2- Realtek(R) Audio)', id: 'mic' },
      { name: 'Headset Earphone (Teams Certified)', id: 'headset' },
    ];

    expect(
      selectDefaultAudioDevices(devices, {
        capture: 'Microphone Array (2- Realtek(R) Audio)',
        render: 'Speakers (Realtek(R) Audio)',
      })
    ).toEqual({
      micName: 'Microphone Array (2- Realtek(R) Audio)',
      loopbackName: '',
    });
  });

  it('prefers an explicit loopback-style device when present', () => {
    const { selectDefaultAudioDevices } = require('../src/main/ipc');

    const devices = [
      { name: 'Microphone Array (2- Realtek(R) Audio)', id: 'mic' },
      { name: 'CABLE Output (2- VB-Audio Virtual Cable)', id: 'loopback' },
    ];

    expect(
      selectDefaultAudioDevices(devices, {
        capture: 'Microphone Array (2- Realtek(R) Audio)',
        render: 'Speakers (Realtek(R) Audio)',
      })
    ).toEqual({
      micName: 'Microphone Array (2- Realtek(R) Audio)',
      loopbackName: 'CABLE Output (2- VB-Audio Virtual Cable)',
    });
  });
});
