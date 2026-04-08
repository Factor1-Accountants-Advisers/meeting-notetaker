const mockInput = jest.fn().mockReturnThis();
const mockInputOptions = jest.fn().mockReturnThis();
const mockComplexFilter = jest.fn().mockReturnThis();
const mockAudioCodec = jest.fn().mockReturnThis();
const mockAudioFrequency = jest.fn().mockReturnThis();
const mockAudioChannels = jest.fn().mockReturnThis();
const mockOutputOptions = jest.fn().mockReturnThis();
const mockSave = jest.fn().mockReturnThis();
const mockKill = jest.fn();
const mockOn = jest.fn().mockReturnThis();

jest.mock('fluent-ffmpeg', () => {
  const instance = {
    input: mockInput, inputOptions: mockInputOptions,
    complexFilter: mockComplexFilter, audioCodec: mockAudioCodec,
    audioFrequency: mockAudioFrequency, audioChannels: mockAudioChannels,
    outputOptions: mockOutputOptions, save: mockSave,
    kill: mockKill, on: mockOn,
  };
  const fn = jest.fn().mockReturnValue(instance);
  (fn as any).setFfmpegPath = jest.fn();
  return fn;
});
jest.mock('ffmpeg-static', () => '/usr/bin/ffmpeg');

describe('recorder', () => {
  let startRecording: typeof import('../src/main/recorder').startRecording;
  let stopRecording: typeof import('../src/main/recorder').stopRecording;
  let getRecordingStatus: typeof import('../src/main/recorder').getRecordingStatus;

  beforeEach(() => {
    jest.clearAllMocks();
    // Re-import to reset module-level activeProcess state
    jest.resetModules();
    // Re-register mocks after resetModules
    jest.doMock('fluent-ffmpeg', () => {
      const instance = {
        input: mockInput, inputOptions: mockInputOptions,
        complexFilter: mockComplexFilter, audioCodec: mockAudioCodec,
        audioFrequency: mockAudioFrequency, audioChannels: mockAudioChannels,
        outputOptions: mockOutputOptions, save: mockSave,
        kill: mockKill, on: mockOn,
      };
      const fn = jest.fn().mockReturnValue(instance);
      (fn as any).setFfmpegPath = jest.fn();
      return fn;
    });
    jest.doMock('ffmpeg-static', () => '/usr/bin/ffmpeg');
    const recorder = require('../src/main/recorder');
    startRecording = recorder.startRecording;
    stopRecording = recorder.stopRecording;
    getRecordingStatus = recorder.getRecordingStatus;
  });

  it('calls ffmpeg with two dshow inputs and amix filter', () => {
    startRecording({ micName: 'Mic', loopbackName: 'Loop', outputPath: 'out.wav' });
    expect(mockInput).toHaveBeenCalledWith('audio=Mic');
    expect(mockInput).toHaveBeenCalledWith('audio=Loop');
    expect(mockComplexFilter).toHaveBeenCalledWith(expect.stringContaining('amix=inputs=2'));
    expect(mockSave).toHaveBeenCalledWith('out.wav');
  });

  it('stopRecording calls kill(SIGINT) and returns the active session details', () => {
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

    expect(stopRecording()).toEqual({
      outputPath: 'out.wav',
      metadata,
    });
    expect(mockKill).toHaveBeenCalledWith('SIGINT');
  });

  it('stopRecording is a no-op when not recording', () => {
    expect(stopRecording()).toEqual({ outputPath: '' });
    expect(mockKill).not.toHaveBeenCalled();
  });

  it('tracks meeting title and startedAt across recording status queries', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(123456789);

    startRecording({
      micName: 'Mic',
      loopbackName: 'Loop',
      outputPath: 'out.wav',
      meetingTitle: 'AI Mission Catch Up',
    });

    expect(getRecordingStatus()).toEqual({
      recording: true,
      meetingTitle: 'AI Mission Catch Up',
      startedAt: 123456789,
    });

    stopRecording();

    expect(getRecordingStatus()).toEqual({
      recording: false,
    });

    nowSpy.mockRestore();
  });

  it('preserves the ffmpeg error in recording status after an async failure', () => {
    startRecording({ micName: 'Mic', loopbackName: 'Loop', outputPath: 'out.wav' });

    const errorHandler = mockOn.mock.calls.find(([event]) => event === 'error')?.[1];
    expect(errorHandler).toBeDefined();

    errorHandler?.(new Error('device disconnected'));

    expect(getRecordingStatus()).toEqual({
      recording: false,
      error: 'device disconnected',
    });
  });
});
