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

export async function uploadRecording(options: UploadOptions): Promise<UploadResult> {
  const { filePath, accessToken, backendUrl, metadata } = options;
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
    }
  );
  return response.data;
}
