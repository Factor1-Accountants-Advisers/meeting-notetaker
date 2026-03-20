export interface Participant {
  id: number;
  name: string;
  email: string | null;
}

export interface MeetingListItem {
  id: number;
  title: string;
  scheduled_time: string | null;
  duration_seconds: number | null;
  status: string;
  participant_count: number;
  has_summary: boolean;
  created_at: string;
}

export interface MeetingListResponse {
  items: MeetingListItem[];
  total: number;
  page: number;
  per_page: number;
  has_next: boolean;
}

export interface TranscriptSegment {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

export interface TranscriptResponse {
  meeting_id: number;
  segments: TranscriptSegment[];
}

export interface SummaryResponse {
  summary_text: string | null;
  key_points: string[];
  follow_ups: string[];
}

export interface ActionItem {
  id: number;
  meeting_id: number;
  description: string;
  owner_name: string | null;
  owner_email: string | null;
  due_date: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ActionItemListResponse {
  items: ActionItem[];
  total: number;
  page: number;
  per_page: number;
  has_next: boolean;
}

export interface ActionItemUpdate {
  description?: string;
  owner_name?: string;
  owner_email?: string;
  due_date?: string;
  status?: string;
}

export interface MeetingDetail {
  id: number;
  title: string;
  scheduled_time: string | null;
  duration_seconds: number | null;
  status: string;
  audio_url: string | null;
  created_at: string;
  participants: Participant[];
  transcript: TranscriptResponse | null;
  summary: SummaryResponse | null;
  action_items: ActionItem[];
}
