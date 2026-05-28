const mockStartWasapiCapture = jest.fn<Promise<void>, [string]>();
const mockStopWasapiCapture = jest.fn<Promise<string>, []>();
const mockIsWasapiRecording = jest.fn<boolean, []>();

jest.mock('../src/main/wasapi-capture', () => ({
  startWasapiCapture: (outputPath: string) => mockStartWasapiCapture(outputPath),
  stopWasapiCapture: () => mockStopWasapiCapture(),
  isWasapiRecording: () => mockIsWasapiRecording(),
}));

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('recorder', () => {
  let startRecording: typeof import('../src/main/recorder').startRecording;
  let stopRecording: typeof import('../src/main/recorder').stopRecording;
  let getRecordingStatus: typeof import('../src/main/recorder').getRecordingStatus;
  let onRecordingError: typeof import('../src/main/recorder').onRecordingError;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    jest.doMock('../src/main/wasapi-capture', () => ({
      startWasapiCapture: (outputPath: string) => mockStartWasapiCapture(outputPath),
      stopWasapiCapture: () => mockStopWasapiCapture(),
      isWasapiRecording: () => mockIsWasapiRecording(),
    }));
    mockStartWasapiCapture.mockResolvedValue(undefined);
    mockStopWasapiCapture.mockResolvedValue('out.wav');
    mockIsWasapiRecording.mockReturnValue(false);

    const recorder = require('../src/main/recorder');
    startRecording = recorder.startRecording;
    stopRecording = recorder.stopRecording;
    getRecordingStatus = recorder.getRecordingStatus;
    onRecordingError = recorder.onRecordingError;
  });

  it('starts WASAPI capture with the requested output path', () => {
    startRecording({ micName: 'Mic', loopbackName: 'Loop', outputPath: 'out.wav' });

    expect(mockStartWasapiCapture).toHaveBeenCalledWith('out.wav');
  });

  it('stopRecording awaits WASAPI stop and returns the active session metadata', async () => {
    const metadata = {
      meeting_title: 'AI Mission Catch Up',
      attendees: [{ name: 'Alice', email: 'alice@example.com' }],
      scheduled_time: '2026-03-30T03:00:00Z',
    };

    startRecording({
      micName: 'Mic',
      loopbackName: 'Loop',
      outputPath: 'out.wav',
      metadata,
    });
    mockIsWasapiRecording.mockReturnValue(true);
    mockStopWasapiCapture.mockResolvedValueOnce('out.wav');

    await expect(stopRecording()).resolves.toEqual({
      outputPath: 'out.wav',
      metadata,
    });
    expect(mockStopWasapiCapture).toHaveBeenCalled();
  });

  it('stopRecording is a no-op when not recording', async () => {
    await expect(stopRecording()).resolves.toEqual({ outputPath: '' });
    expect(mockStopWasapiCapture).not.toHaveBeenCalled();
  });

  it('tracks meeting title and startedAt while WASAPI reports an active recording', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(123456789);

    startRecording({
      micName: 'Mic',
      loopbackName: 'Loop',
      outputPath: 'out.wav',
      meetingTitle: 'AI Mission Catch Up',
    });
    mockIsWasapiRecording.mockReturnValue(true);

    expect(getRecordingStatus()).toEqual({
      recording: true,
      meetingTitle: 'AI Mission Catch Up',
      startedAt: 123456789,
    });

    mockStopWasapiCapture.mockResolvedValueOnce('out.wav');
    await stopRecording();
    mockIsWasapiRecording.mockReturnValue(false);

    expect(getRecordingStatus()).toEqual({
      recording: false,
      error: undefined,
    });

    nowSpy.mockRestore();
  });

  it('preserves a WASAPI start failure in recording status and notifies listeners', async () => {
    const errorCallback = jest.fn();
    onRecordingError(errorCallback);
    mockStartWasapiCapture.mockRejectedValueOnce(new Error('device disconnected'));

    startRecording({ micName: 'Mic', loopbackName: 'Loop', outputPath: 'out.wav' });
    await flushPromises();

    expect(errorCallback).toHaveBeenCalledWith('device disconnected');
    expect(getRecordingStatus()).toEqual({
      recording: false,
      error: 'device disconnected',
    });
  });
});
