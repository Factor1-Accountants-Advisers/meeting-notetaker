import { uploadRecording, UploadOptions } from '../src/main/uploader';
jest.mock('axios');
import axios from 'axios';
const mockPost = axios.post as jest.MockedFunction<typeof axios.post>;

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  createReadStream: jest.fn().mockReturnValue('mock-stream'),
  existsSync: jest.fn().mockReturnValue(true),
}));

const baseOptions: UploadOptions = {
  filePath: 'C:/tmp/meeting.wav',
  accessToken: 'test-token',
  backendUrl: 'http://localhost:8000',
  metadata: {
    meeting_title: 'Sprint Review',
    attendees: [{ name: 'Alice', email: 'alice@firm.com' }],
    scheduled_time: '2026-03-20T09:00:00Z',
  },
};

describe('uploader.uploadRecording', () => {
  beforeEach(() => jest.clearAllMocks());

  it('posts to /api/meetings/upload with Bearer token', async () => {
    mockPost.mockResolvedValueOnce({ data: { meeting_id: 42, status: 'processing' } });
    const result = await uploadRecording(baseOptions);
    expect(mockPost).toHaveBeenCalledWith(
      'http://localhost:8000/api/meetings/upload',
      expect.any(Object),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) })
    );
    expect(result).toEqual({ meeting_id: 42, status: 'processing' });
  });

  it('throws immediately on 4xx HTTP error (no retry)', async () => {
    const axiosError = Object.assign(new Error('Request failed with status code 401'), {
      isAxiosError: true,
      response: { status: 401 },
    });
    // Mock axios.isAxiosError to recognise our error
    (axios.isAxiosError as unknown as jest.Mock) = jest.fn().mockReturnValue(true);
    mockPost.mockRejectedValueOnce(axiosError);
    await expect(uploadRecording(baseOptions)).rejects.toThrow('401');
    expect(mockPost).toHaveBeenCalledTimes(1); // no retries for client errors
  });
});
