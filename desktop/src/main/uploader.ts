import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import FormData from 'form-data';

export interface AttendeeMetadata { name: string; email?: string; }
export interface MeetingMetadata {
  meeting_title: string;
  attendees: AttendeeMetadata[];
  scheduled_time?: string;
}
export interface UploadOptions {
  filePath: string;
  accessToken: string;
  backendUrl: string;
  metadata: MeetingMetadata;
}
export interface UploadResult { meeting_id: number; status: string; }

const MAX_RETRIES = 3;
const RETRY_DELAYS = [2000, 5000, 10000]; // ms

export async function uploadRecording(options: UploadOptions): Promise<UploadResult> {
  const { filePath, accessToken, backendUrl, metadata } = options;

  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`Recording file not found: ${filePath}`);
  }

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const form = new FormData();
      form.append('audio_file', fs.createReadStream(filePath), {
        filename: path.basename(filePath),
        contentType: 'audio/wav',
      });
      form.append('metadata', JSON.stringify(metadata));

      const response = await axios.post<UploadResult>(
        `${backendUrl}/api/meetings/upload`,
        form,
        {
          headers: { ...form.getHeaders(), Authorization: `Bearer ${accessToken}` },
          maxBodyLength: 600 * 1024 * 1024,
          maxContentLength: 600 * 1024 * 1024,
          timeout: 5 * 60 * 1000, // 5 minute timeout
        }
      );
      return response.data;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;

      // Don't retry client errors (4xx) — they won't succeed on retry
      if (status && status >= 400 && status < 500) {
        throw lastError;
      }

      if (attempt < MAX_RETRIES) {
        console.warn(`[uploader] Attempt ${attempt + 1} failed, retrying in ${RETRY_DELAYS[attempt]}ms:`, lastError.message);
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      }
    }
  }
  throw lastError!;
}
