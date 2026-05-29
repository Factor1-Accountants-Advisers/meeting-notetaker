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
  needs_speaker_review?: boolean;
  speaker_review_completed_at?: string | null;
  speaker_mapping_quality?: number | null;
  diarization_diagnostics?: Record<string, unknown> | null;
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
  raw_speaker?: string | null;
  matched_email?: string | null;
  match_confidence?: number | null;
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
  owner_confidence?: number | null;
  owner_source?: ActionOwnerSource | null;
  owner_reason?: string | null;
  due_date: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export type SpeakerMappingSource = "assemblyai" | "llm_inference" | "user_corrected";

export type ActionOwnerSource =
  | "speaker_mapping"
  | "explicit_name_match"
  | "llm_extraction"
  | "user_corrected"
  | "unassigned";

export type SpeakerMapping = {
  id: number;
  meeting_id: number;
  speaker_label: string;
  display_name: string | null;
  email: string | null;
  confidence: number;
  source: SpeakerMappingSource;
  reason: string | null;
  created_at: string;
  updated_at: string;
};

export type SpeakerMappingUpdate = {
  speaker_label: string;
  display_name?: string | null;
  email?: string | null;
  confidence?: number;
  source?: "user_corrected";
  reason?: string | null;
};

export interface SpeakerMappingListResponse {
  items: SpeakerMapping[];
  needs_speaker_review: boolean;
  speaker_mapping_quality: number | null;
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
  needs_speaker_review: boolean;
  speaker_review_completed_at: string | null;
  speaker_mapping_quality: number | null;
  diarization_diagnostics: Record<string, unknown> | null;
  speaker_mappings: SpeakerMapping[];
}

export interface CalendarAttendee {
  name: string;
  email: string;
}

export interface CalendarEvent {
  id: string;
  subject: string;
  start: string;
  end: string;
  attendees: CalendarAttendee[];
}
